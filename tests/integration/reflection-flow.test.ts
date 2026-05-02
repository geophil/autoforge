import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("reflection flow", () => {
  test("a successfully completed task either produces a lesson row or logs a skip", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      const task = await service.submitTask(
        "autoforge",
        "Add a trivial comment to the README",
        { reviewPlan: false }
      );
      expect(task.state).toBe("awaiting_approval");

      const approved = await service.approveTask(task.id);
      expect(approved.state).toBe("completed");

      const lessons = db.sqlite
        .query("SELECT id FROM lessons WHERE source_task_id = ?")
        .all(task.id) as Array<{ id: string }>;
      const reflectorEvents = db.sqlite
        .query(
          "SELECT id FROM events WHERE task_id = ? AND event_type IN ('reflector_skipped', 'reflector_failed', 'lesson_inserted')"
        )
        .all(task.id) as Array<{ id: string }>;

      // Either we got a lesson row or we logged a skip/fail/insert event.
      expect(lessons.length + reflectorEvents.length).toBeGreaterThanOrEqual(1);

      // Mock executor returns { lesson: { skip: true, reason: "mock-executor" } },
      // so at minimum we expect a reflector_skipped event with the mock reason.
      const skipped = db.sqlite
        .query(
          "SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE task_id = ? AND event_type = 'reflector_skipped'"
        )
        .all(task.id) as Array<{ reason: string }>;
      expect(skipped.length).toBeGreaterThanOrEqual(1);
      expect(skipped[0].reason).toBe("mock-executor");
    } finally {
      cleanup();
    }
  });

  test("task failed with failure_category='stalled' and elapsed < 60 skips reflection entirely", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      const taskId = "stalled-1";
      const now = new Date().toISOString();
      db.sqlite
        .query(
          `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
           VALUES (?, 'p', 'd', 'failed', 'STANDARD', '{}', '[]', 0, ?, ?)`
        )
        .run(taskId, now, now);
      db.sqlite
        .query(
          `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
           VALUES ('e1', ?, ?, 'p', 'orchestrator', 'failure_analysis', 'failed',
                   json_object('failure_category', 'stalled', 'elapsed_seconds', 10, 'planner_fallback', 0), 60)`
        )
        .run(taskId, now);

      const result = await service.reflectOnTask(taskId);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("stalled");

      const lessons = db.sqlite
        .query("SELECT id FROM lessons WHERE source_task_id = ?")
        .all(taskId);
      expect(lessons).toHaveLength(0);

      const skipped = db.sqlite
        .query(
          "SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE task_id = ? AND event_type = 'reflector_skipped'"
        )
        .get(taskId) as { reason: string } | null;
      expect(skipped).not.toBeNull();
      expect(skipped!.reason).toContain("stalled");
    } finally {
      cleanup();
    }
  });

  test("rollback_applied clears prior failure_analysis from reflection context", async () => {
    let reflectorCalled = false;
    const { service, db, cleanup } = createTestService({
      reflector: async () => {
        reflectorCalled = true;
        return {
          status: "DONE",
          artifacts: [],
          output: { lesson: { skip: true, reason: "rolled-forward" } },
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    });
    try {
      const taskId = "rolled-back-1";
      const now = new Date().toISOString();
      db.sqlite
        .query(
          `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
           VALUES (?, 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, ?, ?)`
        )
        .run(taskId, now, now);
      db.sqlite
        .query(
          `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
           VALUES ('f1', ?, ?, 'p', 'orchestrator', 'failure_analysis', 'failed',
                   json_object('failure_category', 'stalled', 'elapsed_seconds', 10, 'planner_fallback', 0), 60)`
        )
        .run(taskId, now);
      db.sqlite
        .query(
          `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
           VALUES ('r1', ?, datetime(?, '+1 second'), 'p', 'orchestrator', 'rollback_applied', 'done',
                   json_object('checkpoint_id', 'cp-1'), 60)`
        )
        .run(taskId, now);

      const result = await service.reflectOnTask(taskId);
      expect(reflectorCalled).toBe(true);
      expect(result.reason).not.toBe("stalled");
      const skipped = db.sqlite
        .query(
          "SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE task_id = ? AND event_type = 'reflector_skipped'"
        )
        .get(taskId) as { reason: string } | null;
      expect(skipped).not.toBeNull();
      expect(skipped!.reason).toBe("rolled-forward");
    } finally {
      cleanup();
    }
  });

  test("happy path with non-skip reflector output inserts a lesson row", async () => {
    const { service, db, cleanup } = createTestService({
      reflector: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          status: "DONE",
          artifacts: [],
          lesson: {
            skip: false,
            agent_type: "coder",
            trigger_pattern: "tasks that add README comments",
            body: "TRIGGER: readme\nOBSERVATION: clean\nPRINCIPLE: comment\nEVIDENCE: t1",
            outcome_kind: "reinforcing",
            keywords: "readme comment clean"
          }
        },
        metrics: { elapsedSeconds: 0.1 }
      })
    });
    try {
      const task = await service.submitTask("autoforge", "Add a comment to the README", { reviewPlan: false });
      await service.approveTask(task.id);

      const lessons = db.sqlite
        .query("SELECT id, agent_type, outcome_kind FROM lessons WHERE source_task_id = ?")
        .all(task.id) as Array<{ id: string; agent_type: string; outcome_kind: string }>;
      expect(lessons).toHaveLength(1);
      expect(lessons[0].agent_type).toBe("coder");
      expect(lessons[0].outcome_kind).toBe("reinforcing");

      const inserted = db.sqlite
        .query(
          "SELECT json_extract(payload, '$.lesson_id') AS id FROM events WHERE task_id = ? AND event_type = 'lesson_inserted'"
        )
        .get(task.id) as { id: string };
      expect(inserted.id).toBe(lessons[0].id);
    } finally {
      cleanup();
    }
  });

  test("reflector output with invalid agent_type is rejected (no lesson, no persona:X row)", async () => {
    const { service, db, cleanup } = createTestService({
      reflector: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          status: "DONE",
          artifacts: [],
          lesson: {
            skip: false,
            agent_type: "hacker",
            trigger_pattern: "x",
            body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
            outcome_kind: "corrective",
            keywords: "x"
          }
        },
        metrics: { elapsedSeconds: 0.1 }
      })
    });
    try {
      const task = await service.submitTask("autoforge", "whatever", { reviewPlan: false });
      await service.approveTask(task.id);

      const lessons = db.sqlite
        .query("SELECT COUNT(*) AS n FROM lessons WHERE source_task_id = ?")
        .get(task.id) as { n: number };
      expect(lessons.n).toBe(0);

      const failed = db.sqlite
        .query(
          "SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE task_id = ? AND event_type = 'reflector_failed'"
        )
        .get(task.id) as { reason: string };
      expect(failed.reason).toContain("invalid_agent_type");

      const rogue = db.sqlite
        .query("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = 'persona:hacker'")
        .get() as { n: number };
      expect(rogue.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("reflectOnTask is idempotent when a reflector event already exists", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      const task = await service.submitTask("autoforge", "test", { reviewPlan: false });
      await service.approveTask(task.id);
      const before = (
        db.sqlite
          .query(
            "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type IN ('reflector_skipped','reflector_failed','lesson_inserted')"
          )
          .get(task.id) as { n: number }
      ).n;
      expect(before).toBe(1);

      const second = await service.reflectOnTask(task.id);
      expect(second.reason).toBe("already_reflected");
      const after = (
        db.sqlite
          .query(
            "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type IN ('reflector_skipped','reflector_failed','lesson_inserted')"
          )
          .get(task.id) as { n: number }
      ).n;
      expect(after).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("critiquePlan missing-worktree failure still records reflection evidence", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
      expect(task.state).toBe("awaiting_plan_approval");

      (service as unknown as { cleanupWorktree: (taskId: string) => void }).cleanupWorktree(task.id);

      await expect(service.critiquePlan(task.id, "please rewrite the plan")).rejects.toThrow(/worktree missing/i);

      const failed = service.getTask(task.id);
      expect(failed?.state).toBe("failed");
      const reflectorEvents = db.sqlite
        .query(
          "SELECT id FROM events WHERE task_id = ? AND event_type IN ('reflector_skipped', 'reflector_failed', 'lesson_inserted')"
        )
        .all(task.id) as Array<{ id: string }>;
      expect(reflectorEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});
