import { describe, expect, test } from "bun:test";
import {
  decideTaskPolicy,
  deterministicTaskPolicy,
  withTierOverride,
  type LlmPolicyClassification,
  type TaskPolicyLlmClassifier
} from "../../src/orchestrator/task-policy";

describe("task policy", () => {
  test("routes clearly bounded documentation work to low risk EXPRESS", () => {
    const policy = deterministicTaskPolicy({ description: "Fix README typo" });

    expect(policy.taskType).toBe("documentation");
    expect(policy.riskLevel).toBe("low");
    expect(policy.tier).toBe("EXPRESS");
    expect(policy.assessment.novelty).toBe("low");
    expect(policy.toolPolicy.qmd).toBe("none");
    expect(policy.toolPolicy.allowedBundles).not.toContain("qmd");
  });

  test("keeps operational severity language high risk", () => {
    const policy = deterministicTaskPolicy({ description: "Critical production outage in checkout" });

    expect(policy.riskLevel).toBe("high");
    expect(policy.tier).toBe("THOROUGH");
    expect(policy.modelFloor).toBe("strong");
    expect(policy.sensitiveAreas).toContain("security");
  });

  test("recomputes review gates when tier is explicitly overridden", () => {
    const basePolicy = deterministicTaskPolicy({ description: "Add a small helper" });
    const forcedExpress = withTierOverride(basePolicy, "EXPRESS");

    expect(basePolicy.requiredGates.planReview).toBe(true);
    expect(forcedExpress.requiredGates.planReview).toBe(false);
    expect(forcedExpress.requiredGates.modelReview).toBe(false);
    expect(forcedExpress.requiredGates.prGate).toBe(true);
  });

  test("does not allow LLM to downgrade deterministic high-risk signals", async () => {
    const policy = await decideTaskPolicy({
      description: "Update schema fields",
      filesInScope: ["src/db/schema.sql"]
    }, {
      llmClassifier: fakeClassifier({
        taskType: "documentation",
        riskLevel: "low",
        confidence: 0.95,
        sensitiveAreas: [],
        rationale: "looks small"
      })
    });

    expect(policy.riskLevel).toBe("high");
    expect(policy.tier).toBe("THOROUGH");
    expect(policy.sensitiveAreas).toContain("database");
  });

  test("allows LLM to upgrade semantic risk", async () => {
    const policy = await decideTaskPolicy({ description: "Move token refresh into the background worker" }, {
      llmClassifier: fakeClassifier({
        taskType: "security",
        riskLevel: "high",
        confidence: 0.88,
        sensitiveAreas: ["auth", "secrets"],
        rationale: "token refresh is auth-sensitive"
      })
    });

    expect(policy.riskLevel).toBe("high");
    expect(policy.modelFloor).toBe("strong");
    expect(policy.sensitiveAreas).toEqual(expect.arrayContaining(["auth", "secrets"]));
    expect(policy.sources.llm.status).toBe("success");
  });

  test("falls back to deterministic policy when LLM classifier fails", async () => {
    const policy = await decideTaskPolicy({ description: "Add a small helper" }, {
      llmClassifier: {
        classify: async () => {
          throw new Error("offline");
        }
      }
    });

    expect(policy.sources.llm.status).toBe("fallback");
    expect(policy.riskLevel).toBe("medium");
    expect(policy.tier).toBe("STANDARD");
  });
});

function fakeClassifier(classification: LlmPolicyClassification): TaskPolicyLlmClassifier {
  return {
    classify: async () => ({
      status: "success",
      classification,
      model: "cheap-classifier",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.00001,
      latencyMs: 12
    })
  };
}
