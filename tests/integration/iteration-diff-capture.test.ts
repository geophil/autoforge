import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import type { AgentTask, AgentResult } from "../../src/executors/interface";
import { createTestService } from "../helpers/create-service";

describe("iteration diff capture wiring", () => {
  test("rework capture is upsert-idempotent and cleanup removes iteration tags", async () => {
    let reviewerCalls = 0;
    let coderCalls = 0;
    const handlers: Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>> = {
      coder: async (task) => {
        coderCalls += 1;
        await task.workspace.writeFile("src/feature.ts", `export const version = ${coderCalls};\n`);
        return {
          status: "DONE",
          artifacts: [],
          metrics: { elapsedSeconds: 0.1 }
        };
      },
      reviewer: () => {
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          return {
            status: "DONE_WITH_CONCERNS",
            artifacts: [],
            output: {
              findings: [
                {
                  id: "finding-1",
                  severity: "MAJOR",
                  category: "correctness",
                  description: "Need one rework pass.",
                  resolved: false
                }
              ]
            },
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        return {
          status: "DONE",
          artifacts: [],
          output: { findings: [] },
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    };

    const { service, db, cleanup } = createTestService(handlers);
    try {
      const task = await service.submitTask("autoforge", "Implement rework diff capture", { reviewPlan: false });
      expect(task.state).toBe("awaiting_approval");
      expect(task.iteration).toBe(1);

      const rowsAfterRework = db.sqlite
        .query("SELECT * FROM task_iteration_diffs WHERE task_id = ? ORDER BY from_iteration, to_iteration")
        .all(task.id);
      expect(rowsAfterRework).toHaveLength(1);

      db.sqlite.query("DELETE FROM task_iteration_diffs WHERE task_id = ?").run(task.id);
      const worktrees = (service as unknown as { deps: { worktrees: { findWorktreePath: (taskId: string) => string | null } } }).deps.worktrees;
      const worktreePath = worktrees.findWorktreePath(task.id);
      expect(worktreePath).not.toBeNull();

      (
        service as unknown as {
          captureIterationDiff: (taskId: string, worktreePath: string, iteration: number) => void;
        }
      ).captureIterationDiff(task.id, worktreePath!, 1);

      const rowsAfterReplay = db.sqlite
        .query("SELECT * FROM task_iteration_diffs WHERE task_id = ? ORDER BY from_iteration, to_iteration")
        .all(task.id);
      expect(rowsAfterReplay).toHaveLength(1);

      const tagsBeforeCleanup = execSync(`git tag --list "autoforge/iter-${task.id}-*"`, {
        cwd: process.cwd(),
        encoding: "utf8"
      })
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(tagsBeforeCleanup.length).toBeGreaterThan(0);

      await service.approveTask(task.id);

      const tagsAfterCleanup = execSync(`git tag --list "autoforge/iter-${task.id}-*"`, {
        cwd: process.cwd(),
        encoding: "utf8"
      })
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(tagsAfterCleanup).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
