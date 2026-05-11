import { z } from "zod";
import type { AgentType, TaskStatus } from "../types/core";

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative()
});

export const AutoforgeMessageSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string(),
  projectId: z.string(),
  timestamp: z.string(),
  agent: z.custom<AgentType>(),
  type: z.string(),
  status: z.custom<TaskStatus>(),
  payload: z.unknown(),
  budgetSeconds: z.number().int().nonnegative(),
  elapsedSeconds: z.number().nonnegative().optional(),
  tokenUsage: TokenUsageSchema.optional()
});

export type AutoforgeMessage<T = unknown> = Omit<z.infer<typeof AutoforgeMessageSchema>, "payload"> & {
  payload: T;
};

export const WorkspaceToolRequestSchema = z.object({
  correlationId: z.string().min(1),
  workspaceId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({})
});

export const WorkspaceToolResponseSchema = z.object({
  correlationId: z.string().min(1),
  workspaceId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional()
});

export const WorkspaceToolStreamSchema = z.object({
  correlationId: z.string().min(1),
  workspaceId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string()
});

export type WorkspaceToolRequest = z.infer<typeof WorkspaceToolRequestSchema>;
export type WorkspaceToolResponse = z.infer<typeof WorkspaceToolResponseSchema>;
export type WorkspaceToolStream = z.infer<typeof WorkspaceToolStreamSchema>;

export function taskSubject(projectId: string, taskId: string, event: string): string {
  return `autoforge.task.${projectId}.${taskId}.${event}`;
}

export function workspaceSubject(
  workspaceId: string,
  kind: "request" | "response" | "stream",
  correlationId?: string
): string {
  if (kind === "request") {
    return `autoforge.workspace.${workspaceId}.tool.request`;
  }
  if (!correlationId) {
    throw new Error(`workspace ${kind} subject requires a correlation id`);
  }
  return `autoforge.workspace.${workspaceId}.tool.${kind}.${correlationId}`;
}
