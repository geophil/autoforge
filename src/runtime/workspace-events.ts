import { z } from "zod";

export const WorkspaceLifecyclePayloadSchema = z.object({
  workspace_id: z.string().min(1),
  provider: z.string().min(1),
  task_id: z.string().min(1),
  dispatch_id: z.string().min(1)
});

export const WorkspaceCreatedPayloadSchema = WorkspaceLifecyclePayloadSchema.extend({
  root_path: z.string().optional()
});

export const WorkspaceDestroyedPayloadSchema = WorkspaceLifecyclePayloadSchema.extend({
  reason: z.string().optional()
});

export type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayloadSchema>;
export type WorkspaceDestroyedPayload = z.infer<typeof WorkspaceDestroyedPayloadSchema>;
