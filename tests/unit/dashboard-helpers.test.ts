import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DashboardHelpers = {
  summarizeTokenUsage: (events: Array<Record<string, unknown>>) => {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    costSource: string;
  };
  eventTimelineSummary: (event: Record<string, unknown>) => {
    group: string;
    label: string;
    details: string[];
  };
  buildPrGateReport: (
    task: Record<string, unknown>,
    events: Array<Record<string, unknown>>
  ) => {
    state: string;
    title: string;
    rows: Array<[string, string]>;
  };
  interventionRecommendation: (category: string, reason?: string) => {
    title: string;
    primaryStage: string | null;
    secondaryStage: string | null;
    focus: string;
  };
  transcriptAttemptDiffs: (transcripts: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
};

function loadDashboardHelpers(): DashboardHelpers {
  const uiHelpers = readFileSync(
    resolve(process.cwd(), "src/web/public/ui-helpers.js"),
    "utf8"
  );
  const code = readFileSync(
    resolve(process.cwd(), "src/web/public/dashboard-helpers.js"),
    "utf8"
  );
  const fakeModule: { exports: Record<string, unknown> } = { exports: {} };
  const windowShim: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "window", uiHelpers)(
    fakeModule,
    fakeModule.exports,
    windowShim
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "window", code)(
    fakeModule,
    fakeModule.exports,
    windowShim
  );
  return fakeModule.exports as DashboardHelpers;
}

const helpers = loadDashboardHelpers();

describe("dashboard helpers", () => {
  test("prefers persisted event cost over fallback pricing", () => {
    const summary = helpers.summarizeTokenUsage([
      { tokenUsage: { input: 1000, output: 100 }, estimatedCost: 0.25 }
    ]);

    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(100);
    expect(summary.estimatedCostUsd).toBe(0.25);
    expect(summary.costSource).toBe("persisted");
  });

  test("summarizes variant selected timeline details", () => {
    const summary = helpers.eventTimelineSummary({
      type: "variant_selected",
      agent: "orchestrator",
      payload: {
        agent_type: "coder",
        variant_id: "v1",
        persona_version_id: "p1",
        skill_version_ids: ["s1", "s2"],
        injected_lesson_ids: ["l1"]
      }
    });

    expect(summary.group).toBe("dispatch");
    expect(summary.label).toBe("Variant selected: coder");
    expect(summary.details).toContain("variant v1");
    expect(summary.details).toContain("2 skills");
    expect(summary.details).toContain("1 lesson");
  });

  test("summarizes nested review finding severity", () => {
    const summary = helpers.eventTimelineSummary({
      type: "review_finding",
      agent: "reviewer",
      payload: {
        finding: {
          severity: "MAJOR"
        }
      }
    });

    expect(summary.group).toBe("review");
    expect(summary.label).toBe("Review finding: MAJOR");
  });

  test("builds accepted and blocked PR gate reports", () => {
    const accepted = helpers.buildPrGateReport(
      { tier: "STANDARD", prUrl: "https://example.test/pr/1" },
      [
        {
          type: "task_exit_check",
          payload: {
            verification_status: "passed",
            test_pass_rate: 1,
            review_score: 1,
            unresolved_findings: 0,
            artifact_validation_statuses: ["ok"]
          }
        }
      ]
    );
    expect(accepted.state).toBe("ready");
    expect(accepted.title).toBe("PR gate ready");

    const blocked = helpers.buildPrGateReport(
      { tier: "STANDARD" },
      [
        { type: "test_results", payload: { verificationStatus: "unavailable", passRate: 1 } },
        {
          type: "failure_analysis",
          payload: {
            failure_category: "pr_gate",
            failure_reason: "verification_unavailable",
            verification_status: "unavailable"
          }
        }
      ]
    );
    expect(blocked.state).toBe("blocked");
    expect(blocked.rows.flat()).toContain("verification_unavailable");
  });

  test("maps intervention category to guided retry recommendation", () => {
    const recommendation = helpers.interventionRecommendation("pr_gate", "verification_unavailable");
    expect(recommendation.primaryStage).toBe("executing");
    expect(recommendation.secondaryStage).toBe("planning");
    expect(recommendation.focus).toBe("pr_gate");
  });

  test("computes adjacent transcript deltas by stage", () => {
    const diffs = helpers.transcriptAttemptDiffs([
      { stage: "planner:spec", attempt: 0, tokenInput: 100, tokenOutput: 20, userPrompt: "a", output: { x: 1 } },
      { stage: "planner:spec", attempt: 1, tokenInput: 150, tokenOutput: 25, userPrompt: "b", output: { x: 2 } },
      { stage: "coder", attempt: 0, tokenInput: 90, tokenOutput: 10 }
    ]);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].tokenInputDelta).toBe(50);
    expect(diffs[0].tokenOutputDelta).toBe(5);
    expect(diffs[0].promptChanged).toBe(true);
    expect(diffs[0].outputChanged).toBe(true);
  });
});
