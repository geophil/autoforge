import { getModelCost } from "./pricing";
import type { ModelProvider } from "./model-provider";
import type { UtilityModelPurpose, ModelSelectionDecision } from "./model-selection";
import type { TelemetryLedger } from "../executors/telemetry";
import type { AgentType } from "../types/core";
import { isTimeoutLikeError } from "./runtime-failure-classifier";

export interface UtilityModelCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
}

export class UtilityModelCaller {
  readonly providerName: string;

  constructor(
    private readonly provider: ModelProvider,
    private readonly ledger: TelemetryLedger,
    private readonly agentType: AgentType
  ) {
    this.providerName = provider.name;
  }

  async call(args: {
    selection: ModelSelectionDecision & { purpose: UtilityModelPurpose };
    prompt: string;
  }): Promise<UtilityModelCallResult> {
    const startedAt = Date.now();
    try {
      const response = await this.provider.message({
        model: args.selection.model,
        systemPrompt: utilitySystemPrompt(args.selection.purpose),
        history: [{ role: "user", content: [{ type: "text", text: args.prompt }] }],
        tools: [],
        maxTokens: args.selection.maxTokens,
        timeoutSeconds: args.selection.timeoutSeconds
      });
      if (response.stopReason === "error") {
        throw new Error("Utility model provider returned error stop reason");
      }
      const endedAt = Date.now();
      const cost = getModelCost(this.provider.name, args.selection.model);
      const cachedTokens = response.usage.cached ?? 0;
      const billableInputTokens = Math.max(response.usage.input - cachedTokens, 0);
      const estimatedCost = (
        (billableInputTokens * cost.input) +
        (cachedTokens * cost.cached) +
        (response.usage.output * cost.output)
      ) / 1_000_000;
      this.ledger.recordModelCall({
        provider: this.provider.name,
        model: args.selection.model,
        agentType: this.agentType,
        purpose: args.selection.purpose,
        tokens: {
          input: response.usage.input,
          output: response.usage.output,
          cached: cachedTokens,
          cacheCreation: response.usage.cacheCreation ?? 0
        },
        latencyMs: endedAt - startedAt,
        timestamp: startedAt,
        retryAttempt: 0,
        estimatedCost
      });
      return {
        text: response.content.map(textFromBlock).filter(Boolean).join("\n").trim(),
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        estimatedCost,
        latencyMs: endedAt - startedAt
      };
    } catch (error) {
      this.ledger.recordModelCall({
        provider: this.provider.name,
        model: args.selection.model,
        agentType: this.agentType,
        purpose: args.selection.purpose,
        tokens: { input: 0, output: 0, cached: 0 },
        latencyMs: Date.now() - startedAt,
        timestamp: startedAt,
        retryAttempt: 0,
        estimatedCost: 0,
        failureSubtype: isTimeoutLikeError(error) ? "utility_model_call_timeout" : "utility_model_call_failed"
      });
      throw error;
    }
  }
}

function utilitySystemPrompt(purpose: UtilityModelPurpose): string {
  if (purpose === "compaction") {
    return [
      "You compact agent execution history into strict JSON.",
      "Preserve implementation-critical details and omit conversational filler.",
      "Return JSON only, with no markdown fences."
    ].join("\n");
  }
  return "You perform a bounded utility model task. Return concise structured output.";
}

function textFromBlock(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}
