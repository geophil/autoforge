import type { AgentTask } from "../executors/interface";
import { buildContextEnvelopeFromTask, hashContextEnvelope } from "./context-envelope";

export interface BuildAgentDispatchEnvelopeInput {
  id: string;
  type: AgentTask["type"];
  systemPrompt: string;
  basePrompt: string;
  steeringPrompt?: string;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
  model?: string;
  lessons?: string;
}

/**
 * Partial `AgentTask` without `workspace`. The envelope builder is
 * workspace-agnostic — every dispatch site already owns the per-task
 * workspace (`taskWorkspaces` map) and attaches it when constructing
 * the final `AgentTask` for `executor.execute`. Keeping workspace out
 * of the envelope keeps the builder pure and avoids the previous pattern
 * where the same task workspace was threaded through both the envelope
 * input and the call site separately.
 */
export type DispatchEnvelopeTask = Omit<AgentTask, "workspace">;

export interface AgentDispatchEnvelope {
  task: DispatchEnvelopeTask;
  contextEnvelopeHash: string;
}

export function buildAgentDispatchEnvelope(input: BuildAgentDispatchEnvelopeInput): AgentDispatchEnvelope {
  const prompt =
    input.steeringPrompt && input.steeringPrompt.trim().length > 0
      ? `${input.steeringPrompt}\n\n${input.basePrompt}`
      : input.basePrompt;
  const task: DispatchEnvelopeTask = {
    id: input.id,
    type: input.type,
    systemPrompt: input.systemPrompt,
    prompt,
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
