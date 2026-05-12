import type { AgentTask } from "../executors/interface";
import type { Workspace } from "../runtime/workspace";
import { buildContextEnvelopeFromTask, hashContextEnvelope } from "./context-envelope";

export interface BuildAgentDispatchEnvelopeInput {
  id: string;
  type: AgentTask["type"];
  systemPrompt: string;
  basePrompt: string;
  steeringPrompt?: string;
  workspace: Workspace;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
  model?: string;
  lessons?: string;
}

export interface AgentDispatchEnvelope {
  task: AgentTask;
  contextEnvelopeHash: string;
}

export function buildAgentDispatchEnvelope(input: BuildAgentDispatchEnvelopeInput): AgentDispatchEnvelope {
  const prompt =
    input.steeringPrompt && input.steeringPrompt.trim().length > 0
      ? `${input.steeringPrompt}\n\n${input.basePrompt}`
      : input.basePrompt;
  const task: AgentTask = {
    id: input.id,
    type: input.type,
    systemPrompt: input.systemPrompt,
    prompt,
    workspace: input.workspace,
    budgetSeconds: input.budgetSeconds,
    environment: input.environment,
    skillFiles: input.skillFiles,
    metadata: input.metadata,
    model: input.model,
    lessons: input.lessons
  };
  return {
    task,
    contextEnvelopeHash: hashContextEnvelope(buildContextEnvelopeFromTask(task))
  };
}
