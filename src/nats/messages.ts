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

export function taskSubject(projectId: string, taskId: string, event: string): string {
  return `autoforge.task.${projectId}.${taskId}.${event}`;
}
