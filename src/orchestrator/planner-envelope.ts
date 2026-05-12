import type { AgentTask } from "../executors/interface";
import type { Tier } from "../types/core";
import type { Workspace } from "../runtime/workspace";
import { buildAgentDispatchEnvelope } from "./dispatch-envelope";

export interface BuildPlannerDispatchEnvelopeInput {
  taskId: string;
  description: string;
  tier: Tier;
  attempt: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  steeringPrompt?: string;
  lessons?: string;
  workspace: Workspace;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
}

export interface PlannerDispatchEnvelope {
  task: AgentTask;
  contextEnvelopeHash: string;
}

export function buildPlannerDispatchEnvelope(input: BuildPlannerDispatchEnvelopeInput): PlannerDispatchEnvelope {
  return buildAgentDispatchEnvelope({
    id: input.taskId,
    type: "planner",
    systemPrompt: input.systemPrompt,
    basePrompt: input.userPrompt,
    steeringPrompt: input.steeringPrompt,
    workspace: input.workspace,
    budgetSeconds: input.budgetSeconds,
    environment: input.environment,
    skillFiles: input.skillFiles,
    metadata: { description: input.description, tier: input.tier, attempt: input.attempt },
    model: input.model,
    lessons: input.lessons
  });
}
