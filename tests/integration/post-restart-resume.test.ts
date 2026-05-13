import { describe, expect, test } from "bun:test";
import type { Workspace } from "../../src/runtime/workspace";
import { createTestService } from "../helpers/create-service";

// After a process restart the in-memory `taskWorkspaces` map is empty,
// but tasks paused at human-gate states (awaiting_spec_approval,
// awaiting_plan_approval, awaiting_approval) survive in the event log
// and are intentionally excluded from the staleness sweep. Operator
// entry points that resume work must lazily ensure the per-task
// workspace exists, otherwise `requireTaskWorkspace` throws and the
// human gate becomes unrecoverable. We simulate the restart by clearing
// the private `taskWorkspaces` map between the submit and the operator
// action — every other restart-relevant piece of state (worktree on
// disk, sqlite event log) is already preserved by the test fixture.
function clearWorkspaceCache(service: object): void {
  const cache = (service as unknown as { taskWorkspaces: Map<string, Workspace> }).taskWorkspaces;
  cache.clear();
}

describe("operator entry points after orchestrator restart", () => {
  test("approveSpec recreates the workspace when the cache is empty", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");

    clearWorkspaceCache(service);

    const planGate = await service.approveSpec(task.id);
    expect(planGate.state).toBe("awaiting_plan_approval");
  });

  test("critiqueSpec recreates the workspace when the cache is empty", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");

    clearWorkspaceCache(service);

    const after = await service.critiqueSpec(task.id, "please make the spec narrower");
    expect(after.state).toBe("awaiting_spec_approval");
  });

  test("critiquePlan recreates the workspace when the cache is empty", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");
    await service.approveSpec(task.id);
    expect(service.getTask(task.id)?.state).toBe("awaiting_plan_approval");

    clearWorkspaceCache(service);

    const after = await service.critiquePlan(task.id, "please split subtask 1");
    expect(after.state).toBe("awaiting_plan_approval");
  });

  test("approvePlan recreates the workspace when the cache is empty", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    await service.approveSpec(task.id);
    expect(service.getTask(task.id)?.state).toBe("awaiting_plan_approval");

    clearWorkspaceCache(service);

    const after = await service.approvePlan(task.id);
    expect(after.state).toBe("awaiting_approval");
  });

  test("approveTask recreates the workspace when the cache is empty", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "tiny tweak", {
      forceTier: "EXPRESS"
    });
    expect(task.state).toBe("awaiting_approval");

    clearWorkspaceCache(service);

    const after = await service.approveTask(task.id);
    expect(["completed", "documenting"]).toContain(after.state);
  });

  // The lazy resume must not break the workspace event-log invariant. The
  // workspace.id is logically `${taskId}:task` (deterministic across
  // incarnations), so `ensureTaskWorkspace`'s `alreadyRecorded` guard
  // suppresses a duplicate `workspace_created` and the single paired
  // `workspace_destroyed` is emitted when `cleanupWorktree` runs.
  test("lazy resume does not duplicate workspace_created and pairs cleanly with workspace_destroyed", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "tiny tweak", {
      forceTier: "EXPRESS"
    });
    expect(task.state).toBe("awaiting_approval");

    const beforeCreates = db
      .listEvents(task.id)
      .filter((event) => event.type === "workspace_created").length;
    expect(beforeCreates).toBe(1);

    clearWorkspaceCache(service);

    const after = await service.approveTask(task.id);
    expect(["completed", "documenting"]).toContain(after.state);

    const events = db.listEvents(task.id);
    const creates = events.filter((event) => event.type === "workspace_created");
    const destroys = events.filter((event) => event.type === "workspace_destroyed");

    expect(creates).toHaveLength(1);
    expect(destroys).toHaveLength(1);
    expect(destroys[0].payload.workspace_id).toBe(creates[0].payload.workspace_id);
  });
});
