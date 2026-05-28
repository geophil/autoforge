import type { AgentType } from "../types/core";

export interface ModelCallEvent {
  provider: string;
  model: string;
  agentType: AgentType;
  tokens: { input: number; output: number; cached?: number; cacheCreation?: number };
  latencyMs: number;
  timestamp: number;
  retryAttempt: number;
  estimatedCost: number;
  stablePrefixVersion?: string;
  stablePrefixHash?: string;
  modelCallTimeoutSeconds?: number;
  historyChars?: number;
  transcriptChars?: number;
  failureSubtype?: string;
}

export interface ToolCallEvent {
  toolName: string;
  status: "success" | "error";
  latencyMs: number;
  rawOutputBytes: number;
  truncatedOutputBytes: number;
  artifactBytes?: number;
  summaryBytes?: number;
  returnedToModelBytes?: number;
  outputMode?: "summary" | "excerpt" | "full";
  parser?: string;
  fullOutputReason?: string;
  artifactReference?: string;
  qmdElapsedMs?: number;
  qmdAllowanceUsedMs?: number;
  qmdAllowanceRemainingMs?: number;
  historyChars?: number;
  transcriptChars?: number;
  failureSubtype?: string;
}

export interface TelemetrySummary {
  totalEstimatedCost: number;
  totalTokens: { input: number; output: number; cached: number; cacheCreation: number };
  cacheHitRatio: number;
  retryCount: number;
  mostExpensiveModel: string;
  mostExpensivePhase: string;
  toolOutputContributionBytes: number;
}

export class TelemetryLedger {
  private modelEvents: ModelCallEvent[] = [];
  private toolEvents: ToolCallEvent[] = [];

  recordModelCall(event: ModelCallEvent) {
    this.modelEvents.push(event);
  }

  recordToolCall(event: ToolCallEvent) {
    this.toolEvents.push(event);
  }

  getEvents() {
    return { models: [...this.modelEvents], tools: [...this.toolEvents] };
  }

  getSummary(): TelemetrySummary {
    let totalCost = 0;
    const tokens = { input: 0, output: 0, cached: 0, cacheCreation: 0 };
    let totalToolBytes = 0;
    let retries = 0;

    const costByModel: Record<string, number> = {};
    const costByPhase: Record<string, number> = {};

    for (const m of this.modelEvents) {
      totalCost += m.estimatedCost;
      tokens.input += m.tokens.input;
      tokens.output += m.tokens.output;
      tokens.cached += m.tokens.cached ?? 0;
      tokens.cacheCreation += m.tokens.cacheCreation ?? 0;
      retries += m.retryAttempt;

      costByModel[m.model] = (costByModel[m.model] || 0) + m.estimatedCost;
      costByPhase[m.agentType] = (costByPhase[m.agentType] || 0) + m.estimatedCost;
    }

    for (const t of this.toolEvents) {
      totalToolBytes += t.returnedToModelBytes ?? t.truncatedOutputBytes;
    }

    let mostExpensiveModel = "";
    let maxModelCost = -1;
    for (const [model, cost] of Object.entries(costByModel)) {
      if (cost > maxModelCost) {
        mostExpensiveModel = model;
        maxModelCost = cost;
      }
    }

    let mostExpensivePhase = "";
    let maxPhaseCost = -1;
    for (const [phase, cost] of Object.entries(costByPhase)) {
      if (cost > maxPhaseCost) {
        mostExpensivePhase = phase;
        maxPhaseCost = cost;
      }
    }

    return {
      totalEstimatedCost: totalCost,
      totalTokens: tokens,
      cacheHitRatio: tokens.input > 0 ? tokens.cached / tokens.input : 0,
      retryCount: retries,
      mostExpensiveModel,
      mostExpensivePhase,
      toolOutputContributionBytes: totalToolBytes
    };
  }
}
