import { createHash } from "node:crypto";
import type { AgentTask } from "../executors/interface";
import type { AgentType } from "../types/core";

export interface ContextEnvelope {
  agentType: AgentType;
  systemPrompt: string;
  userPrompt: string;
  lessons: string;
}

export function buildContextEnvelopeFromTask(task: Pick<AgentTask, "type" | "systemPrompt" | "prompt" | "lessons">): ContextEnvelope {
  return {
    agentType: task.type,
    systemPrompt: task.systemPrompt,
    userPrompt: task.prompt,
    lessons: normalizeBlock(task.lessons)
  };
}

export function hashContextEnvelope(envelope: ContextEnvelope): string {
  const stable = JSON.stringify(envelope);
  return createHash("sha256").update(stable).digest("hex");
}

function normalizeBlock(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "";
}
