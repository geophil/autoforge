import type { AgentType } from "../types/core";

export type ModelCallPurpose = "agent_turn" | "compaction" | "summarization" | "classification" | "extraction";

export interface ModelCallEvent {
  provider: string;
  model: string;
  agentType: AgentType;
  purpose?: ModelCallPurpose;
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

export interface CompactionEvent {
  purpose: "compaction";
  provider: string;
  model: string | null;
  status: "success" | "fallback";
  latencyMs: number;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  preHistoryChars: number;
  postHistoryChars: number;
  droppedTurns: number;
  retainedRecentTurns: number;
  summaryInputCharCount: number;
  summaryOutputCharCount: number;
  rawHistoryArtifact: string;
  usedFallback: boolean;
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
  utilityCallCount?: number;
  utilityEstimatedCost?: number;
  compactionCount?: number;
  compactionFallbackCount?: number;
  compactionInputTokens?: number;
  compactionOutputTokens?: number;
  compactionEstimatedCost?: number;
  maxPreCompactionHistoryChars?: number;
  maxPostCompactionHistoryChars?: number;
}

export class TelemetryLedger {
  private modelEvents: ModelCallEvent[] = [];
  private toolEvents: ToolCallEvent[] = [];
  private compactionEvents: CompactionEvent[] = [];

  recordModelCall(event: ModelCallEvent) {
    this.modelEvents.push(event);
  }

  recordToolCall(event: ToolCallEvent) {
    this.toolEvents.push(event);
  }

  recordCompaction(event: CompactionEvent) {
    this.compactionEvents.push(event);
  }

  getEvents() {
    return {
      models: [...this.modelEvents],
      tools: [...this.toolEvents],
      compactions: [...this.compactionEvents]
    };
  }

  getSummary(): TelemetrySummary {
    let totalCost = 0;
    const tokens = { input: 0, output: 0, cached: 0, cacheCreation: 0 };
    let totalToolBytes = 0;
    let retries = 0;
    let utilityCallCount = 0;
    let utilityEstimatedCost = 0;

    const costByModel: Record<string, number> = {};
    const costByPhase: Record<string, number> = {};

    for (const m of this.modelEvents) {
      totalCost += m.estimatedCost;
      tokens.input += m.tokens.input;
      tokens.output += m.tokens.output;
      tokens.cached += m.tokens.cached ?? 0;
      tokens.cacheCreation += m.tokens.cacheCreation ?? 0;
      retries += m.retryAttempt;
      if (m.purpose && m.purpose !== "agent_turn") {
        utilityCallCount += 1;
        utilityEstimatedCost += m.estimatedCost;
      }

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

    const compactionTokens = this.compactionEvents.reduce((sum, event) => {
      sum.input += event.inputTokens;
      sum.output += event.outputTokens;
      sum.cost += event.estimatedCost;
      return sum;
    }, { input: 0, output: 0, cost: 0 });

    return {
      totalEstimatedCost: totalCost,
      totalTokens: tokens,
      cacheHitRatio: tokens.input > 0 ? tokens.cached / tokens.input : 0,
      retryCount: retries,
      mostExpensiveModel,
      mostExpensivePhase,
      toolOutputContributionBytes: totalToolBytes,
      utilityCallCount,
      utilityEstimatedCost,
      compactionCount: this.compactionEvents.length,
      compactionFallbackCount: this.compactionEvents.filter((event) => event.usedFallback).length,
      compactionInputTokens: compactionTokens.input,
      compactionOutputTokens: compactionTokens.output,
      compactionEstimatedCost: compactionTokens.cost,
      maxPreCompactionHistoryChars: Math.max(0, ...this.compactionEvents.map((event) => event.preHistoryChars)),
      maxPostCompactionHistoryChars: Math.max(0, ...this.compactionEvents.map((event) => event.postHistoryChars))
    };
  }
}
