import { describe, expect, test } from "bun:test";
import { RunBudget } from "../../src/runtime/run-budget";

describe("RunBudget", () => {
  test("QMD elapsed time consumes QMD allowance without reducing base budget", () => {
    let now = 1_000;
    const budget = new RunBudget({
      budgetSeconds: 60,
      qmdTotalAllowanceSeconds: 10,
      qmdCallTimeoutSeconds: 3,
      finalReserveSeconds: 15,
      nowMs: () => now
    });

    now += 5_000;
    expect(budget.baseRemainingMs()).toBe(55_000);
    budget.observeQmdElapsed(4_000);
    expect(budget.baseRemainingMs()).toBe(59_000);
    expect(budget.qmdAllowanceRemainingMs()).toBe(6_000);
  });

  test("caps QMD calls by per-call timeout, allowance, and wall clock", () => {
    let now = 0;
    const budget = new RunBudget({
      budgetSeconds: 60,
      qmdTotalAllowanceSeconds: 5,
      qmdCallTimeoutSeconds: 20,
      nowMs: () => now
    });

    expect(budget.timeoutForQmdCall().timeoutMs).toBe(5_000);
    budget.observeQmdElapsed(5_000);
    expect(budget.timeoutForQmdCall().failureSubtype).toBe("qmd_allowance_exceeded");
    expect(budget.timeoutForQmdCall().timeoutMs).toBe(0);
  });

  test("model timeout respects configured cap and final reserve detection", () => {
    let now = 0;
    const budget = new RunBudget({
      budgetSeconds: 120,
      modelCallTimeoutSeconds: 30,
      finalReserveSeconds: 20,
      nowMs: () => now
    });

    expect(budget.timeoutForModelCall().timeoutSeconds).toBe(30);
    expect(budget.isInFinalReserve()).toBe(false);
    now = 105_000;
    expect(budget.isInFinalReserve()).toBe(true);
    expect(budget.timeoutForModelCall().timeoutSeconds).toBe(15);
  });
});
