import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { AgentTask, AgentResult } from "../../src/executors/interface";
import { createTestService } from "../helpers/create-service";

/**
 * Regression coverage for PR 4: with `LocalWorkspace.destroy()` now owning
 * worktree + branch removal (mirroring `ContainerWorkspace.destroy()`'s
 * container removal), the orchestrator must still call
 * `captureTaskDiffStats` *before* `cleanupWorktree` so diff stats observe
 * the agent's writes. If that ordering ever inverted, the worktree would
 * be gone by the time `git diff` ran and the stats would silently come
 * back empty (the `git diff` failure is logged + skipped, not thrown).
 */
describe("terminal cleanup ordering vs LocalWorkspace.destroy", () => {
  test("captureTaskDiffStats records the agent's writes before cleanupWorktree removes the worktree", async () => {
    const handlers: Partial<Record<AgentTask["type"], (task: AgentTask) => Promise<AgentResult>>> = {
      coder: async (task) => {
        await task.workspace.writeFile("ordering-marker.txt", "diff capture must see this\n");
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    };

    const { service, db, cleanup } = createTestService(handlers);
    try {
      const submitted = await service.submitTask("autoforge", "exercise terminal cleanup ordering", {
        forceTier: "EXPRESS",
        reviewPlan: false
      });
      expect(submitted.state).toBe("awaiting_approval");
      const worktreePathBeforeApprove = (
        service as unknown as { deps: { worktrees: { findWorktreePath: (taskId: string) => string | null } } }
      ).deps.worktrees.findWorktreePath(submitted.id);
      expect(worktreePathBeforeApprove).not.toBeNull();
      expect(existsSync(worktreePathBeforeApprove!)).toBe(true);

      const approved = await service.approveTask(submitted.id);
      expect(["completed", "documenting"]).toContain(approved.state);

      const stats = db.sqlite
        .query("SELECT files_changed, lines_added FROM task_diff_stats WHERE task_id = ?")
        .get(submitted.id) as { files_changed: number; lines_added: number } | null;
      expect(stats).not.toBeNull();
      expect(stats!.files_changed).toBeGreaterThan(0);
      expect(stats!.lines_added).toBeGreaterThan(0);

      expect(existsSync(worktreePathBeforeApprove!)).toBe(false);

      const events = db.listEvents(submitted.id);
      const creates = events.filter((event) => event.type === "workspace_created");
      const destroys = events.filter((event) => event.type === "workspace_destroyed");
      expect(creates).toHaveLength(1);
      expect(destroys).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
