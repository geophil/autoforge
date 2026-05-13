import {
  WorkspaceCreatedPayloadSchema,
  WorkspaceDestroyedPayloadSchema,
  type WorkspaceCreatedPayload,
  type WorkspaceDestroyedPayload
} from "./workspace-events";

export interface WorkspaceCreatedPayloadInput {
  workspaceId: string;
  provider: string;
  taskId: string;
  dispatchId: string;
  rootPath?: string;
}

export function workspaceCreatedPayload(input: WorkspaceCreatedPayloadInput): WorkspaceCreatedPayload {
  return WorkspaceCreatedPayloadSchema.parse({
    workspace_id: input.workspaceId,
    provider: input.provider,
    task_id: input.taskId,
    dispatch_id: input.dispatchId,
    ...(input.rootPath ? { root_path: input.rootPath } : {})
  });
}

/**
 * Recovery helper: walk a task's event log and produce compensating
 * `workspace_destroyed` payloads for any `workspace_created` event that
 * lacks a paired destroy. Used by the orchestrator's cleanupWorktree path
 * when the in-memory workspace handle has been lost (process restart),
 * so the event-log invariant (every created has a destroyed) survives
 * crashes. The actual container, if any, is reaped separately by the
 * startup orphan reaper.
 */
export function pendingWorkspaceDestroyPayloads(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
  reason: string
): WorkspaceDestroyedPayload[] {
  const created = new Map<string, WorkspaceCreatedPayload>();
  const destroyed = new Set<string>();

  for (const event of events) {
    if (event.type === "workspace_created") {
      const parsed = WorkspaceCreatedPayloadSchema.safeParse(event.payload);
      if (parsed.success) {
        created.set(parsed.data.workspace_id, parsed.data);
      }
    }
    if (event.type === "workspace_destroyed") {
      const parsed = WorkspaceDestroyedPayloadSchema.safeParse(event.payload);
      if (parsed.success) {
        destroyed.add(parsed.data.workspace_id);
      }
    }
  }

  return [...created.values()]
    .filter((workspace) => !destroyed.has(workspace.workspace_id))
    .map((workspace) => WorkspaceDestroyedPayloadSchema.parse({
      workspace_id: workspace.workspace_id,
      provider: workspace.provider,
      task_id: workspace.task_id,
      dispatch_id: workspace.dispatch_id,
      reason
    }));
}
