import type { AgentResult, AgentTask } from "../executors/interface";
import { buildRuntimeTelemetrySummary } from "../executors/runtime-telemetry-summary";
import type { AgentType, TaskStatus, Tier } from "../types/core";
import type { ModelRoutingDecision, ModelRoutingInput } from "./model-routing";

export interface AgentRuntimeTelemetryEvent {
  agent: AgentType;
  type: "agent_runtime_telemetry";
  status: TaskStatus;
  payload: Record<string, unknown>;
  budgetSeconds: number;
  elapsedSeconds: number;
  tokenUsage?: { input: number; output: number; estimatedCost?: number };
  executorUsed: string;
}

export function buildAgentRuntimeTelemetryEvent(args: {
  result: AgentResult;
  task: AgentTask;
  executorName: string;
  routing: ModelRoutingDecision;
  agentType: AgentType;
  phase: ModelRoutingInput["phase"];
  taskTier: Tier;
  filesInScope?: string[];
}): AgentRuntimeTelemetryEvent {
  const summary = buildRuntimeTelemetrySummary({
    result: args.result,
    agentType: args.agentType,
    phase: args.phase
  });

  return {
    agent: args.agentType,
    type: "agent_runtime_telemetry",
    status: statusForAgentResult(args.result),
    payload: {
      ...summary,
      executor: args.executorName,
      model: args.task.model ?? null,
      routedTier: args.routing.tier,
      taskTier: args.taskTier,
      filesInScope: args.filesInScope ?? []
    },
    budgetSeconds: args.task.budgetSeconds,
    elapsedSeconds: args.result.metrics.elapsedSeconds,
    tokenUsage: args.result.metrics.tokenInput !== undefined
      ? {
          input: args.result.metrics.tokenInput,
          output: args.result.metrics.tokenOutput ?? 0,
          estimatedCost: args.result.metrics.estimatedCost
        }
      : undefined,
    executorUsed: args.executorName
  };
}

export function statusForAgentResult(result: AgentResult): TaskStatus {
  if (result.status === "DONE") return "done";
  if (result.status === "DONE_WITH_CONCERNS") return "done_with_concerns";
  if (result.status === "BLOCKED") return "blocked";
  if (result.status === "NEEDS_CONTEXT") return "needs_context";
  if (result.status === "TIMEOUT") return "timeout";
  return "failed";
}
