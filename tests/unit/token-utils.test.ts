import { describe, test, expect } from "bun:test";
import { summarizeTokenUsage } from "../../src/web/token-utils";

describe("summarizeTokenUsage", () => {
  test("returns zeros for empty events array", () => {
    const result = summarizeTokenUsage([]);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  test("returns zeros when no events have tokenUsage", () => {
    const result = summarizeTokenUsage([
      { tokenUsage: null },
      { tokenUsage: null },
    ]);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  test("sums input and output tokens across all events", () => {
    const result = summarizeTokenUsage([
      { tokenUsage: { input: 100, output: 200 } },
      { tokenUsage: { input: 300, output: 400 } },
    ]);
    expect(result.inputTokens).toBe(400);
    expect(result.outputTokens).toBe(600);
  });

  test("skips events with null tokenUsage when summing", () => {
    const result = summarizeTokenUsage([
      { tokenUsage: { input: 1000, output: 500 } },
      { tokenUsage: null },
      { tokenUsage: { input: 200, output: 100 } },
    ]);
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(600);
  });

  test("estimates cost using per-token rates", () => {
    // 1M input tokens at $3/1M + 1M output tokens at $15/1M = $18
    const result = summarizeTokenUsage([
      { tokenUsage: { input: 1_000_000, output: 1_000_000 } },
    ]);
    expect(result.estimatedCostUsd).toBeCloseTo(18, 6);
  });

  test("estimated cost is proportional for smaller token counts", () => {
    const result = summarizeTokenUsage([
      { tokenUsage: { input: 1000, output: 2000 } },
    ]);
    // 1000 * 3/1M + 2000 * 15/1M = 0.003 + 0.030 = 0.033
    expect(result.estimatedCostUsd).toBeCloseTo(0.033, 6);
  });
});
