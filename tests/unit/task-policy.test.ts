import { describe, expect, test } from "bun:test";
import {
  decideTaskPolicy,
  deterministicTaskPolicy,
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
