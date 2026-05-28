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
              historyChars: 200
            }],
            tools: [{
              toolName: "exec",
              status: "error",
              latencyMs: 10,
              rawOutputBytes: 40,
              truncatedOutputBytes: 20,
              returnedToModelBytes: 8,
              artifactBytes: 100,
              historyChars: 250,
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
        tokenTotals: { input: 100, output: 20, cached: 60, cacheCreation: 15 },
        cacheHitRatio: 0.6,
        estimatedCachedInputSavings: expect.any(Number),
        stablePrefixVersion: "prompt-prefix-v1",
        stablePrefixHash: "hash-a",
        rawToolOutputBytes: 40,
        returnedToolOutputBytes: 8,
        artifactBytes: 100,
        maxHistoryChars: 250,
        failureSubtypeCounts: { model_call_timeout: 1 }
      });
  });
});
