import type { AgentResult } from "./interface";
import { getModelCost } from "../runtime/pricing";

export interface RuntimeTelemetrySummary {
  agentType: string;
  phase: string | null;
  finalStatus: AgentResult["status"];
  modelCallCount: number;
  toolCallCount: number;
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
  rawToolOutputBytes: number;
  returnedToolOutputBytes: number;
  artifactBytes: number;
  maxHistoryChars: number;
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
  const tokenTotals = {
    input: telemetry?.totalTokens.input ?? args.result.metrics.tokenInput ?? 0,
    output: telemetry?.totalTokens.output ?? args.result.metrics.tokenOutput ?? 0,
    cached: telemetry?.totalTokens.cached ?? 0,
    cacheCreation: telemetry?.totalTokens.cacheCreation ?? 0
  };
  const failureSubtypeCounts: Record<string, number> = {};
  for (const event of [...modelEvents, ...toolEvents]) {
    if (!event.failureSubtype) continue;
    failureSubtypeCounts[event.failureSubtype] = (failureSubtypeCounts[event.failureSubtype] ?? 0) + 1;
  }
  const qmdEvents = toolEvents.filter((event) => event.qmdAllowanceUsedMs !== undefined || event.qmdAllowanceRemainingMs !== undefined);
  const lastQmd = qmdEvents.at(-1);
  const firstStable = modelEvents.find((event) => event.stablePrefixHash);
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
    tokenTotals,
    cacheHitRatio: tokenTotals.input > 0 ? tokenTotals.cached / tokenTotals.input : 0,
    estimatedCachedInputSavings,
    totalEstimatedCost: telemetry?.totalEstimatedCost ?? args.result.metrics.estimatedCost ?? 0,
    stablePrefixVersion: firstStable?.stablePrefixVersion ?? null,
    stablePrefixHash: firstStable?.stablePrefixHash ?? null,
    qmdAllowanceUsedMs: lastQmd?.qmdAllowanceUsedMs ?? null,
    qmdAllowanceRemainingMs: lastQmd?.qmdAllowanceRemainingMs ?? null,
    rawToolOutputBytes: toolEvents.reduce((sum, event) => sum + event.rawOutputBytes, 0),
    returnedToolOutputBytes: toolEvents.reduce((sum, event) => sum + (event.returnedToModelBytes ?? event.truncatedOutputBytes), 0),
    artifactBytes: toolEvents.reduce((sum, event) => sum + (event.artifactBytes ?? 0), 0),
    maxHistoryChars: Math.max(0, ...modelEvents.map((event) => event.historyChars ?? 0), ...toolEvents.map((event) => event.historyChars ?? 0)),
    failureSubtypeCounts
  };
}
