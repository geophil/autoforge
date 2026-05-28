import { describe, expect, test } from "bun:test";
import { buildRuntimeTelemetrySummary } from "../../src/executors/runtime-telemetry-summary";
import type { AgentResult } from "../../src/executors/interface";

describe("buildRuntimeTelemetrySummary", () => {
  test("builds compact cache and tool telemetry from raw events", () => {
    const result: AgentResult = {
      status: "DONE",
      artifacts: [],
      metrics: {
        elapsedSeconds: 1,
        tokenInput: 100,
        tokenOutput: 20,
        telemetry: {
          totalEstimatedCost: 0.01,
          totalTokens: { input: 100, output: 20, cached: 60, cacheCreation: 15 },
          cacheHitRatio: 0.6,
          retryCount: 0,
          mostExpensiveModel: "model-a",
          mostExpensivePhase: "coder",
          toolOutputContributionBytes: 8,
          events: {
            models: [{
              provider: "anthropic",
              model: "model-a",
              agentType: "coder",
              tokens: { input: 100, output: 20, cached: 60, cacheCreation: 15 },
              latencyMs: 50,
              timestamp: 1,
              retryAttempt: 0,
              estimatedCost: 0.01,
              stablePrefixVersion: "prompt-prefix-v1",
              stablePrefixHash: "hash-a",
              historyChars: 200,
              transcriptChars: 120
            }],
            tools: [{
              toolName: "exec",
              status: "error",
              latencyMs: 10,
              rawOutputBytes: 40,
              truncatedOutputBytes: 20,
              returnedToModelBytes: 8,
              artifactBytes: 100,
              summaryBytes: 12,
              historyChars: 250,
              transcriptChars: 150,
              failureSubtype: "model_call_timeout"
            }]
          }
        }
      }
    };

    expect(buildRuntimeTelemetrySummary({ result, agentType: "coder", phase: "implementation" }))
      .toMatchObject({
        agentType: "coder",
        phase: "implementation",
        finalStatus: "DONE",
        modelCallCount: 1,
        toolCallCount: 1,
        modelCounts: {
          total: 1,
          byProvider: { anthropic: 1 },
          byModel: { "model-a": 1 }
        },
        toolCounts: {
          total: 1,
          byName: { exec: 1 },
          byStatus: { error: 1 },
          qmd: 0,
          errors: 1
        },
        tokenTotals: { input: 100, output: 20, cached: 60, cacheCreation: 15 },
        cacheHitRatio: 0.6,
        estimatedCachedInputSavings: expect.any(Number),
        stablePrefixVersion: "prompt-prefix-v1",
        stablePrefixHash: "hash-a",
        rawToolOutputBytes: 40,
        returnedToolOutputBytes: 8,
        artifactBytes: 100,
        toolOutputBytes: { raw: 40, returnedToModel: 8, artifact: 100, summary: 12 },
        maxHistoryChars: 250,
        maxTranscriptChars: 150,
        failureSubtypeCounts: { model_call_timeout: 1 }
      });
  });

  test("builds a zero summary when telemetry is unavailable", () => {
    const result: AgentResult = {
      status: "FAILED",
      artifacts: [],
      metrics: {
        elapsedSeconds: 1,
        tokenInput: 12,
        tokenOutput: 3,
        estimatedCost: 0.004
      }
    };

    expect(buildRuntimeTelemetrySummary({ result, agentType: "reviewer" })).toEqual({
      agentType: "reviewer",
      phase: null,
      finalStatus: "FAILED",
      modelCallCount: 0,
      toolCallCount: 0,
      modelCounts: { total: 0, byProvider: {}, byModel: {} },
      toolCounts: { total: 0, byName: {}, byStatus: {}, qmd: 0, errors: 0 },
      tokenTotals: { input: 12, output: 3, cached: 0, cacheCreation: 0 },
      cacheHitRatio: 0,
      estimatedCachedInputSavings: 0,
      totalEstimatedCost: 0.004,
      stablePrefixVersion: null,
      stablePrefixHash: null,
      qmdAllowanceUsedMs: null,
      qmdAllowanceRemainingMs: null,
      qmd: { callCount: 0, elapsedMs: 0, allowanceUsedMs: null, allowanceRemainingMs: null },
      rawToolOutputBytes: 0,
      returnedToolOutputBytes: 0,
      artifactBytes: 0,
      toolOutputBytes: { raw: 0, returnedToModel: 0, artifact: 0, summary: 0 },
      maxHistoryChars: 0,
      maxTranscriptChars: 0,
      failureSubtypeCounts: {}
    });
  });

  test("summarizes timeout and QMD usage from representative tool events", () => {
    const result: AgentResult = {
      status: "TIMEOUT",
      artifacts: [],
      metrics: {
        elapsedSeconds: 3,
        tokenInput: 0,
        tokenOutput: 0,
        telemetry: {
          totalEstimatedCost: 0,
          totalTokens: { input: 0, output: 0, cached: 0, cacheCreation: 0 },
          cacheHitRatio: 0,
          retryCount: 0,
          mostExpensiveModel: "",
          mostExpensivePhase: "",
          toolOutputContributionBytes: 30,
          events: {
            models: [{
              provider: "anthropic",
              model: "claude-3-haiku-20240307",
              agentType: "planner",
              tokens: { input: 0, output: 0 },
              latencyMs: 100,
              timestamp: 1,
              retryAttempt: 0,
              estimatedCost: 0,
              failureSubtype: "model_call_timeout",
              historyChars: 500
            }],
            tools: [
              {
                toolName: "qmd_setup",
                status: "success",
                latencyMs: 10,
                rawOutputBytes: 2,
                truncatedOutputBytes: 2,
                returnedToModelBytes: 0,
                qmdElapsedMs: 10,
                qmdAllowanceUsedMs: 10,
                qmdAllowanceRemainingMs: 990
              },
              {
                toolName: "get",
                status: "error",
                latencyMs: 20,
                rawOutputBytes: 100,
                truncatedOutputBytes: 30,
                returnedToModelBytes: 30,
                qmdElapsedMs: 20,
                qmdAllowanceUsedMs: 30,
                qmdAllowanceRemainingMs: 970,
                failureSubtype: "qmd_call_timeout"
              }
            ]
          }
        }
      }
    };

    const summary = buildRuntimeTelemetrySummary({ result, agentType: "planner", phase: "spec" });

    expect(summary.finalStatus).toBe("TIMEOUT");
    expect(summary.toolCounts).toMatchObject({
      total: 2,
      byName: { qmd_setup: 1, get: 1 },
      byStatus: { success: 1, error: 1 },
      qmd: 2,
      errors: 1
    });
    expect(summary.qmd).toEqual({
      callCount: 2,
      elapsedMs: 30,
      allowanceUsedMs: 30,
      allowanceRemainingMs: 970
    });
    expect(summary.failureSubtypeCounts).toEqual({
      model_call_timeout: 1,
      qmd_call_timeout: 1
    });
  });

  test("estimates cached input savings for priced cache-hit ledgers", () => {
    const result: AgentResult = {
      status: "DONE_WITH_CONCERNS",
      artifacts: [],
      metrics: {
        elapsedSeconds: 2,
        telemetry: {
          totalEstimatedCost: 0.02,
          totalTokens: { input: 1000, output: 100, cached: 800, cacheCreation: 50 },
          cacheHitRatio: 0.8,
          retryCount: 0,
          mostExpensiveModel: "claude-3-5-sonnet-20241022",
          mostExpensivePhase: "coder",
          toolOutputContributionBytes: 0,
          events: {
            models: [{
              provider: "anthropic",
              model: "claude-3-5-sonnet-20241022",
              agentType: "coder",
              tokens: { input: 1000, output: 100, cached: 800, cacheCreation: 50 },
              latencyMs: 40,
              timestamp: 1,
              retryAttempt: 0,
              estimatedCost: 0.02,
              stablePrefixVersion: "prompt-prefix-v2",
              stablePrefixHash: "hash-cache"
            }],
            tools: []
          }
        }
      }
    };

    const summary = buildRuntimeTelemetrySummary({ result, agentType: "coder" });

    expect(summary.finalStatus).toBe("DONE_WITH_CONCERNS");
    expect(summary.cacheHitRatio).toBe(0.8);
    expect(summary.estimatedCachedInputSavings).toBeCloseTo(0.00216);
    expect(summary.stablePrefixVersion).toBe("prompt-prefix-v2");
    expect(summary.stablePrefixHash).toBe("hash-cache");
  });
});
