import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestService } from "../helpers/create-service";
import type { AutoforgeMessage } from "../../src/nats/messages";
import {
  pendingWorkspaceDestroyPayloads,
  workspaceCreatedPayload
} from "../../src/runtime/workspace-cleanup";

describe("workspace cleanup helpers", () => {
  test("task dispatch destroys factory-created workspaces after execution", async () => {
    let destroyCount = 0;
    const { service, cleanup } = createTestService({}, {}, {
      workspaceFactory: {
        create: async ({ rootPath, taskId, dispatchId }) => {
          const { LocalWorkspace } = await import("../../src/runtime/local-workspace");
          const workspace = new LocalWorkspace({ rootPath, taskId, dispatchId });
          const originalDestroy = workspace.destroy.bind(workspace);
          workspace.destroy = async () => {
            destroyCount += 1;
            await originalDestroy();
          };
          return workspace;
        }
      }
    });

    try {
      const task = await service.submitTask("autoforge", "no-op plan", { reviewPlan: false });

      expect(task.state).toBe("awaiting_approval");
      expect(destroyCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

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

  test("planner failure is preserved when workspace destroy throws", async () => {
    const { service, db, cleanup } = createTestService(
      {
        planner: async () => ({
          status: "FAILED",
          artifacts: [],
          blockReason: "planner_failed_primary",
          metrics: { elapsedSeconds: 0.1 }
        })
      },
      {},
      {
        workspaceFactory: {
          create: async ({ rootPath, taskId, dispatchId }) => {
            const { LocalWorkspace } = await import("../../src/runtime/local-workspace");
            const workspace = new LocalWorkspace({ rootPath, taskId, dispatchId });
            workspace.destroy = async () => {
              throw new Error("workspace_destroy_failed_secondary");
            };
            return workspace;
          }
        }
      }
    );

    try {
      const task = await service.submitTask("autoforge", "no-op plan", { reviewPlan: false });
      expect(task.state).toBe("awaiting_intervention");
      const failureAnalysis = db.listEvents(task.id).find((event) => event.type === "failure_analysis");
      expect(failureAnalysis).toBeDefined();
      expect(JSON.stringify(failureAnalysis?.payload ?? {})).toContain("planner_failed_primary");
      expect(JSON.stringify(failureAnalysis?.payload ?? {})).not.toContain("workspace_destroy_failed_secondary");
    } finally {
      cleanup();
    }
  });
});

function appendAndApply(db: ReturnType<typeof createTestService>["db"], message: AutoforgeMessage): void {
  db.appendEvent(message);
  db.applyEvent(message);
}
