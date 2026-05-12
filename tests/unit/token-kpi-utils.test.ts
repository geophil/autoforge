import { describe, expect, test } from "bun:test";
import {
  buildEnvelopeReuseProjectQuery,
  buildEnvelopeReuseQuery,
  buildProjectTokenUsageQuery,
  buildPlannerTokenKpiProjectQuery,
  buildPlannerTokenKpiQuery,
  computePlannerTokenKpis,
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
});
