import { describe, expect, test } from "bun:test";
import {
  buildEnvelopeReuseProjectQuery,
  buildEnvelopeReuseQuery,
  buildProjectTokenUsageQuery,
  buildPlannerTokenKpiProjectQuery,
  buildPlannerTokenKpiQuery,
  buildRuntimeCacheKpiProjectQuery,
  computePlannerTokenKpis,
  computeRuntimeCacheKpis,
  meetsPlannerReductionTarget,
  plannerReductionAchieved
} from "../../src/web/token-kpi-utils";

describe("computePlannerTokenKpis", () => {
  test("computes median planner tokens and planner share", () => {
    const summary = computePlannerTokenKpis([
      { stage: "planner:spec", tokenInput: 100 },
      { stage: "planner:execution_plan", tokenInput: 300 },
      { stage: "coder", tokenInput: 200 }
    ]);

    expect(summary.plannerMedianInputTokens).toBe(200);
    expect(summary.totalInputTokens).toBe(600);
    expect(summary.plannerInputShare).toBeCloseTo(2 / 3, 5);
  });

  test("counts retries by stage attempt > 0", () => {
    const summary = computePlannerTokenKpis([
      { stage: "planner:spec", tokenInput: 120, attempt: 0 },
      { stage: "planner:spec", tokenInput: 160, attempt: 1 },
      { stage: "planner:execution_plan", tokenInput: 300, attempt: 2 },
      { stage: "doc", tokenInput: 80, attempt: 0 }
    ]);

    expect(summary.plannerRetries).toBe(2);
  });

  test("computes planner median reduction and checks target gate", () => {
    expect(plannerReductionAchieved(1000, 700)).toBeCloseTo(0.3, 5);
    expect(meetsPlannerReductionTarget(1000, 700)).toBe(true);
    expect(meetsPlannerReductionTarget(1000, 850)).toBe(false);
  });
});

describe("computeRuntimeCacheKpis", () => {
  test("summarizes prompt-cache and runtime contribution metrics", () => {
    const summary = computeRuntimeCacheKpis([
      {
        stablePrefixHash: "hash-a",
        cachedInputTokens: 80,
        inputTokens: 100,
        estimatedCachedInputSavings: 0.001,
        maxHistoryChars: 200,
        toolOutputContributionBytes: 50
      },
      {
        stablePrefixHash: "hash-a",
        cachedInputTokens: 20,
        inputTokens: 100,
        estimatedCachedInputSavings: 0.002,
        maxHistoryChars: 300,
        toolOutputContributionBytes: 25
      }
    ]);

    expect(summary.repeatedStablePrefixCount).toBe(1);
    expect(summary.cachedInputTokenRatio).toBe(0.5);
    expect(summary.estimatedCachedInputSavings).toBeCloseTo(0.003);
    expect(summary.maxHistoryChars).toBe(300);
    expect(summary.toolOutputContributionBytes).toBe(75);
  });
});

describe("token KPI SQL helpers", () => {
  test("buildPlannerTokenKpiQuery scopes to planner stages and window", () => {
    const { sql, params } = buildPlannerTokenKpiQuery(7);
    expect(sql).toContain("planner:spec");
    expect(sql).toContain("planner:execution_plan");
    expect(sql).toContain("project_id = ?");
    expect(sql).toContain("datetime('now', '-' || ? || ' days')");
    expect(params).toEqual([7]);
  });

  test("buildEnvelopeReuseQuery groups by context envelope hash", () => {
    const { sql, params } = buildEnvelopeReuseQuery(14);
    expect(sql).toContain("context_envelope_hash");
    expect(sql).toContain("COUNT(*) AS occurrences");
    expect(sql).toContain("project_id = ?");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual([14]);
  });

  test("project query builders prepend projectId and append limit when needed", () => {
    const planner = buildPlannerTokenKpiProjectQuery("p1", 7);
    const envelope = buildEnvelopeReuseProjectQuery("p1", 14, 5);
    const allUsage = buildProjectTokenUsageQuery("p2", 30);
    expect(planner.params).toEqual(["p1", 7]);
    expect(envelope.params).toEqual(["p1", 14, 5]);
    expect(allUsage.params).toEqual(["p2", 30]);
    expect(allUsage.sql).toContain("COALESCE");
  });

  test("buildRuntimeCacheKpiProjectQuery reads runtime telemetry payloads", () => {
    const { sql, params } = buildRuntimeCacheKpiProjectQuery("p3", 21);
    expect(sql).toContain("event_type = 'agent_runtime_telemetry'");
    expect(sql).toContain("$.stablePrefixHash");
    expect(sql).toContain("$.tokenTotals.cached");
    expect(sql).toContain("$.returnedToolOutputBytes");
    expect(params).toEqual(["p3", 21]);
  });
});
