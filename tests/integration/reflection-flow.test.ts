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
});
