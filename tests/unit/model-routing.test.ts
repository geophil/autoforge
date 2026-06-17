import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/config/env";
import { routeModel } from "../../src/orchestrator/model-routing";
import { deterministicTaskPolicy } from "../../src/orchestrator/task-policy";

const env = loadEnv({
  NODE_ENV: "test",
  EXECUTOR_DEFAULT: "mock",
  MODEL_TIER_CHEAP: "cheap-model",
  MODEL_TIER_STANDARD: "standard-model",
  MODEL_TIER_STRONG: "strong-model"
});

describe("model routing", () => {
  test("uses standard for normal engineering dispatches", () => {
    const decision = routeModel(env, {
      agentType: "coder",
      phase: "implementation",
      tier: "STANDARD",
      description: "Add a small UI affordance"
    });

    expect(decision.tier).toBe("standard");
    expect(decision.model).toBe("standard-model");
    expect(decision.rationale).toBe("standard_default_for_agent_dispatch");
  });

  test("escalates sensitive areas to strong", () => {
    const decision = routeModel(env, {
      agentType: "planner",
      phase: "execution_plan",
      tier: "STANDARD",
      description: "Add an auth migration for session permissions",
      filesInScope: ["src/db/migrations/012_auth.sql"]
    });

    expect(decision.tier).toBe("strong");
    expect(decision.model).toBe("strong-model");
    expect(decision.sensitiveAreas).toEqual(expect.arrayContaining(["auth", "database"]));
  });

  test("does not escalate medium customer-facing policy to strong by itself", () => {
    const policy = deterministicTaskPolicy({ description: "Add a dashboard API filter" });
    const decision = routeModel(env, {
      agentType: "coder",
      phase: "implementation",
      tier: policy.tier,
      description: "Add a dashboard API filter",
      policy
    });

    expect(policy.riskLevel).toBe("medium");
    expect(policy.sensitiveAreas).toContain("customer_facing");
    expect(decision.tier).toBe("standard");
    expect(decision.rationale).toBe("policy_model_floor");
  });

  test("honors high-risk policy with strong model even without a runtime keyword", () => {
    const policy = deterministicTaskPolicy({ description: "Critical production outage in checkout" });
    const decision = routeModel(env, {
      agentType: "planner",
      phase: "execution_plan",
      tier: policy.tier,
      description: "Fix checkout stability",
      policy
    });

    expect(decision.tier).toBe("strong");
    expect(decision.rationale).toBe("strong_for_high_risk_policy");
  });

  test("escalates repeated failures to strong", () => {
    const decision = routeModel(env, {
      agentType: "reviewer",
      phase: "review",
      tier: "STANDARD",
      description: "Review a normal change",
      failureCount: 2
    });

    expect(decision.tier).toBe("strong");
    expect(decision.rationale).toBe("strong_after_repeated_failures");
  });

  test("does not route engineering agents to cheap", () => {
    const decision = routeModel(env, {
      agentType: "doc",
      phase: "summarization",
      tier: "EXPRESS",
      description: "Summarize completed docs"
    });

    expect(decision.tier).toBe("standard");
    expect(decision.rationale).toBe("standard_floor_for_engineering_agent");
  });
});
