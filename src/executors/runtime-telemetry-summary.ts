import type { AgentResult } from "./interface";
import { getModelCost } from "../runtime/pricing";

export interface RuntimeTelemetrySummary {
  agentType: string;
  phase: string | null;
  finalStatus: AgentResult["status"];
  modelCallCount: number;
  toolCallCount: number;
  modelCounts: {
    total: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  };
  toolCounts: {
    total: number;
    byName: Record<string, number>;
    byStatus: Record<string, number>;
    qmd: number;
    errors: number;
  };
  tokenTotals: {
    input: number;
    output: number;
    cached: number;
    cacheCreation: number;
  };
  cacheHitRatio: number;
  estimatedCachedInputSavings: number;
  totalEstimatedCost: number;
  stablePrefixVersion: string | null;
  stablePrefixHash: string | null;
  qmdAllowanceUsedMs: number | null;
  qmdAllowanceRemainingMs: number | null;
  qmd: {
    callCount: number;
    elapsedMs: number;
    allowanceUsedMs: number | null;
    allowanceRemainingMs: number | null;
  };
  rawToolOutputBytes: number;
  returnedToolOutputBytes: number;
  artifactBytes: number;
  toolOutputBytes: {
    raw: number;
    returnedToModel: number;
    artifact: number;
    summary: number;
  };
  maxHistoryChars: number;
  maxTranscriptChars: number;
  utilityCallCount: number;
  utilityEstimatedCost: number;
  compaction: {
    count: number;
    fallbackCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    maxPreHistoryChars: number;
    maxPostHistoryChars: number;
  };
  failureSubtypeCounts: Record<string, number>;
}

export function buildRuntimeTelemetrySummary(args: {
  result: AgentResult;
  agentType: string;
  phase?: string | null;
}): RuntimeTelemetrySummary {
  const telemetry = args.result.metrics.telemetry;
  const modelEvents = telemetry?.events.models ?? [];
  const toolEvents = telemetry?.events.tools ?? [];
  const compactionEvents = telemetry?.events.compactions ?? [];
  const tokenTotals = {
    input: telemetry?.totalTokens.input ?? args.result.metrics.tokenInput ?? 0,
    output: telemetry?.totalTokens.output ?? args.result.metrics.tokenOutput ?? 0,
    cached: telemetry?.totalTokens.cached ?? 0,
    cacheCreation: telemetry?.totalTokens.cacheCreation ?? 0
  };
  const failureSubtypeCounts: Record<string, number> = {};
  for (const event of [...modelEvents, ...toolEvents, ...compactionEvents]) {
    if (!event.failureSubtype) continue;
    failureSubtypeCounts[event.failureSubtype] = (failureSubtypeCounts[event.failureSubtype] ?? 0) + 1;
  }
  const qmdEvents = toolEvents.filter((event) => event.qmdAllowanceUsedMs !== undefined || event.qmdAllowanceRemainingMs !== undefined);
  const lastQmd = qmdEvents.at(-1);
  const firstStable = modelEvents.find((event) => event.stablePrefixHash);
  const rawToolOutputBytes = toolEvents.reduce((sum, event) => sum + event.rawOutputBytes, 0);
  const returnedToolOutputBytes = toolEvents.reduce((sum, event) => sum + (event.returnedToModelBytes ?? event.truncatedOutputBytes), 0);
  const artifactBytes = toolEvents.reduce((sum, event) => sum + (event.artifactBytes ?? 0), 0);
  const estimatedCachedInputSavings = modelEvents.reduce((sum, event) => {
    const cachedTokens = event.tokens.cached ?? 0;
    if (cachedTokens <= 0) return sum;
    const cost = getModelCost(event.provider, event.model);
    return sum + (cachedTokens * Math.max(cost.input - cost.cached, 0)) / 1_000_000;
  }, 0);
  return {
    agentType: args.agentType,
    phase: args.phase ?? null,
    finalStatus: args.result.status,
    modelCallCount: modelEvents.length,
    toolCallCount: toolEvents.length,
    modelCounts: {
      total: modelEvents.length,
      byProvider: countBy(modelEvents, (event) => event.provider),
      byModel: countBy(modelEvents, (event) => event.model)
    },
    toolCounts: {
      total: toolEvents.length,
      byName: countBy(toolEvents, (event) => event.toolName),
      byStatus: countBy(toolEvents, (event) => event.status),
      qmd: qmdEvents.length,
      errors: toolEvents.filter((event) => event.status === "error").length
    },
    tokenTotals,
    cacheHitRatio: tokenTotals.input > 0 ? tokenTotals.cached / tokenTotals.input : 0,
    estimatedCachedInputSavings,
    totalEstimatedCost: telemetry?.totalEstimatedCost ?? args.result.metrics.estimatedCost ?? 0,
    stablePrefixVersion: firstStable?.stablePrefixVersion ?? null,
    stablePrefixHash: firstStable?.stablePrefixHash ?? null,
    qmdAllowanceUsedMs: lastQmd?.qmdAllowanceUsedMs ?? null,
    qmdAllowanceRemainingMs: lastQmd?.qmdAllowanceRemainingMs ?? null,
    qmd: {
      callCount: qmdEvents.length,
      elapsedMs: qmdEvents.reduce((sum, event) => sum + (event.qmdElapsedMs ?? 0), 0),
      allowanceUsedMs: lastQmd?.qmdAllowanceUsedMs ?? null,
      allowanceRemainingMs: lastQmd?.qmdAllowanceRemainingMs ?? null
    },
    rawToolOutputBytes,
    returnedToolOutputBytes,
    artifactBytes,
    toolOutputBytes: {
      raw: rawToolOutputBytes,
      returnedToModel: returnedToolOutputBytes,
      artifact: artifactBytes,
      summary: toolEvents.reduce((sum, event) => sum + (event.summaryBytes ?? 0), 0)
    },
    maxHistoryChars: Math.max(0, ...modelEvents.map((event) => event.historyChars ?? 0), ...toolEvents.map((event) => event.historyChars ?? 0)),
    maxTranscriptChars: Math.max(0, ...modelEvents.map((event) => event.transcriptChars ?? 0), ...toolEvents.map((event) => event.transcriptChars ?? 0)),
    utilityCallCount: telemetry?.utilityCallCount ?? modelEvents.filter((event) => event.purpose && event.purpose !== "agent_turn").length,
    utilityEstimatedCost: telemetry?.utilityEstimatedCost ?? modelEvents
      .filter((event) => event.purpose && event.purpose !== "agent_turn")
      .reduce((sum, event) => sum + event.estimatedCost, 0),
    compaction: {
      count: telemetry?.compactionCount ?? compactionEvents.length,
      fallbackCount: telemetry?.compactionFallbackCount ?? compactionEvents.filter((event) => event.usedFallback).length,
      inputTokens: telemetry?.compactionInputTokens ?? compactionEvents.reduce((sum, event) => sum + event.inputTokens, 0),
      outputTokens: telemetry?.compactionOutputTokens ?? compactionEvents.reduce((sum, event) => sum + event.outputTokens, 0),
      estimatedCost: telemetry?.compactionEstimatedCost ?? compactionEvents.reduce((sum, event) => sum + event.estimatedCost, 0),
      maxPreHistoryChars: telemetry?.maxPreCompactionHistoryChars ?? Math.max(0, ...compactionEvents.map((event) => event.preHistoryChars)),
      maxPostHistoryChars: telemetry?.maxPostCompactionHistoryChars ?? Math.max(0, ...compactionEvents.map((event) => event.postHistoryChars))
    },
    failureSubtypeCounts
  };
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
