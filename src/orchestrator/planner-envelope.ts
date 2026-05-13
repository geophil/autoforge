import type { Tier } from "../types/core";
import { buildAgentDispatchEnvelope, type AgentDispatchEnvelope } from "./dispatch-envelope";

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
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
}

export type PlannerDispatchEnvelope = AgentDispatchEnvelope;

export function buildPlannerDispatchEnvelope(input: BuildPlannerDispatchEnvelopeInput): PlannerDispatchEnvelope {
  return buildAgentDispatchEnvelope({
    id: input.taskId,
    type: "planner",
    systemPrompt: input.systemPrompt,
    basePrompt: input.userPrompt,
    steeringPrompt: input.steeringPrompt,
    budgetSeconds: input.budgetSeconds,
    environment: input.environment,
    skillFiles: input.skillFiles,
    metadata: { description: input.description, tier: input.tier, attempt: input.attempt },
    model: input.model,
    lessons: input.lessons
  });
}
