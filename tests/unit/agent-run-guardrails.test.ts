import { describe, expect, test } from "bun:test";
import { AgentRunGuardrails } from "../../src/runtime/agent-run-guardrails";
import { RunBudget } from "../../src/runtime/run-budget";

const plannerSpecTask = {
  type: "planner" as const,
  prompt: "## Phase\nspec\n\n## Task\nDo work",
  metadata: { phase: "spec" }
};

describe("AgentRunGuardrails", () => {
  test("blocks planner spec exploration during final reserve", () => {
    let now = 0;
    const budget = new RunBudget({
      budgetSeconds: 100,
      finalReserveSeconds: 20,
      nowMs: () => now
    });
    const guardrails = new AgentRunGuardrails(plannerSpecTask);

    now = 85_000;
    const block = guardrails.beforeTool({ toolName: "query", isQmd: true, budget });

    expect(block?.failureSubtype).toBe("planner_final_reserve_exhausted");
    expect(block?.shouldContinue).toBe(true);
    expect(guardrails.beforeTool({ toolName: "done", isQmd: false, budget })).toBeNull();
  });

  test("caps planner spec QMD and total tool calls", () => {
    const budget = new RunBudget({ budgetSeconds: 100 });
    const guardrails = new AgentRunGuardrails(plannerSpecTask, {
      plannerSpecMaxQmdCalls: 1,
      plannerSpecMaxToolCalls: 2
    });

    expect(guardrails.beforeTool({ toolName: "query", isQmd: true, budget })).toBeNull();
    guardrails.recordTool({ isQmd: true });
    expect(guardrails.beforeTool({ toolName: "get", isQmd: true, budget })?.failureSubtype)
      .toBe("planner_qmd_call_cap_exceeded");

    const localOnly = new AgentRunGuardrails(plannerSpecTask, {
      plannerSpecMaxQmdCalls: 10,
      plannerSpecMaxToolCalls: 1
    });
    expect(localOnly.beforeTool({ toolName: "read_file", isQmd: false, budget })).toBeNull();
    localOnly.recordTool({ isQmd: false });
    expect(localOnly.beforeTool({ toolName: "read_file", isQmd: false, budget })?.failureSubtype)
      .toBe("max_tool_iterations");
  });

  test("reports context budget overages", () => {
    const guardrails = new AgentRunGuardrails(plannerSpecTask, { contextMaxChars: 10 });

    expect(guardrails.checkContextSize(9)).toBeNull();
    expect(guardrails.checkContextSize(11)?.failureSubtype).toBe("context_budget_exceeded");
  });
});
