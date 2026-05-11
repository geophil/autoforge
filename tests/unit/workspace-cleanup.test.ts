import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestService } from "../helpers/create-service";
import type { AutoforgeMessage } from "../../src/nats/messages";
import {
  pendingWorkspaceDestroyPayloads,
  workspaceCreatedPayload
} from "../../src/runtime/workspace-cleanup";

describe("workspace cleanup helpers", () => {
  test("returns one destroy payload for each created workspace without a destroy event", () => {
    const created = workspaceCreatedPayload({
      workspaceId: "task-1:planner",
      provider: "local",
      taskId: "task-1",
      dispatchId: "planner",
      rootPath: "/tmp/worktree"
    });

    expect(pendingWorkspaceDestroyPayloads([
      { type: "workspace_created", payload: created }
    ], "terminal_task")).toEqual([{
      workspace_id: "task-1:planner",
      provider: "local",
      task_id: "task-1",
      dispatch_id: "planner",
      reason: "terminal_task"
    }]);
  });

  test("does not return duplicate destroy payloads for already destroyed workspaces", () => {
    const created = workspaceCreatedPayload({
      workspaceId: "task-1:planner",
      provider: "local",
      taskId: "task-1",
      dispatchId: "planner"
    });

    expect(pendingWorkspaceDestroyPayloads([
      { type: "workspace_created", payload: created },
      {
        type: "workspace_destroyed",
        payload: {
          workspace_id: "task-1:planner",
          provider: "local",
          task_id: "task-1",
          dispatch_id: "planner",
          reason: "terminal_task"
        }
      }
    ], "terminal_task")).toEqual([]);
  });

  test("sweepStaleTasks emits workspace_destroyed once for stale terminalized tasks", async () => {
    const { service, db, cleanup } = createTestService();
    const taskId = "stale-workspace-task";
    const projectId = "autoforge";
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    try {
      appendAndApply(db, {
        id: randomUUID(),
        taskId,
        projectId,
        timestamp: oldTimestamp,
        agent: "orchestrator",
        type: "created",
        status: "in_progress",
        payload: {
          description: "stale task",
          state: "executing",
          tier: "EXPRESS",
          assessment: {
            scope: "small",
            novelty: "low",
            risk: "low",
            coupling: "low",
            rationale: "test",
            similarPastTasks: []
          },
          planSubtasks: [],
          iteration: 0
        },
        budgetSeconds: 60
      });
      appendAndApply(db, {
        id: randomUUID(),
        taskId,
        projectId,
        timestamp: oldTimestamp,
        agent: "orchestrator",
        type: "workspace_created",
        status: "done",
        payload: workspaceCreatedPayload({
          workspaceId: `${taskId}:coder`,
          provider: "local",
          taskId,
          dispatchId: "coder"
        }),
        budgetSeconds: 0
      });

      await service.sweepStaleTasks();
      await service.sweepStaleTasks();

      const destroyed = db.listEvents(taskId).filter((event) => event.type === "workspace_destroyed");
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0].payload).toMatchObject({
        workspace_id: `${taskId}:coder`,
        provider: "local",
        task_id: taskId,
        dispatch_id: "coder",
        reason: "terminal_task"
      });
    } finally {
      cleanup();
    }
  });
});

function appendAndApply(db: ReturnType<typeof createTestService>["db"], message: AutoforgeMessage): void {
  db.appendEvent(message);
  db.applyEvent(message);
}
