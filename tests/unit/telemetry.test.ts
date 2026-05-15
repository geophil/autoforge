import { describe, expect, test } from "bun:test";
import { TelemetryLedger } from "../../src/executors/telemetry";

describe("TelemetryLedger", () => {
  test("aggregates model and tool events into a summary", () => {
    const ledger = new TelemetryLedger();
    
    ledger.recordModelCall({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      agentType: "coder",
      tokens: { input: 1000, output: 500, cached: 0 },
      latencyMs: 1500,
      timestamp: Date.now(),
      retryAttempt: 0,
      estimatedCost: 0.0105 // (1000*3 + 500*15) / 1000000 = 0.0105
    });

    ledger.recordToolCall({
      toolName: "read_file",
      status: "success",
      latencyMs: 50,
      rawOutputBytes: 1500,
      truncatedOutputBytes: 1500
    });

    const summary = ledger.getSummary();
    expect(summary.totalEstimatedCost).toBeCloseTo(0.0105);
    expect(summary.totalTokens.input).toBe(1000);
    expect(summary.totalTokens.output).toBe(500);
    expect(summary.mostExpensiveModel).toBe("claude-3-5-sonnet-20241022");
    expect(summary.mostExpensivePhase).toBe("coder");
    expect(summary.toolOutputContributionBytes).toBe(1500);
    expect(summary.retryCount).toBe(0);
  });

  test("aggregates cached tokens separately in the summary", () => {
    const ledger = new TelemetryLedger();

    ledger.recordModelCall({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      agentType: "coder",
      tokens: { input: 1000, output: 200, cached: 750 },
      latencyMs: 10,
      timestamp: 1,
      retryAttempt: 0,
      estimatedCost: 0.006225
    });

    expect(ledger.getSummary().totalTokens).toEqual({
      input: 1000,
      output: 200,
      cached: 750
    });
  });
});
