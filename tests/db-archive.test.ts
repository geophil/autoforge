import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "db-archive-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function insertTask(db: DbClient, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .run(taskId, "proj-1", "some task", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");
}

function insertArchivedTask(db: DbClient, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(taskId, "proj-1", "some task", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z", "2026-04-19T01:00:00Z");
}

function insertSubtask(db: DbClient, subtaskId: string, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO subtasks (id, task_id, sequence, description, files_in_scope, dependencies, state, agent_type, budget_seconds) VALUES (?,?,?,?,?,?,?,?,?)"
    )
    .run(subtaskId, taskId, 1, "do something", "[]", "[]", "pending", "coder", 300);
}

function insertReviewFinding(db: DbClient, findingId: string, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO review_findings (id, task_id, severity, category, description) VALUES (?,?,?,?,?)"
    )
    .run(findingId, taskId, "MINOR", "style", "some finding");
}

function insertEvent(db: DbClient, eventId: string, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds) VALUES (?,?,?,?,?,?,?,?,?)"
    )
    .run(eventId, taskId, "2026-04-19T00:00:00Z", "proj-1", "orchestrator", "task.started", "ok", "{}", 300);
}

function insertTranscript(db: DbClient, transcriptId: string, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, system_prompt, user_prompt, transcript) VALUES (?,?,?,?,?,?,?,?,?)"
    )
    .run(transcriptId, taskId, "plan", 1, "2026-04-19T00:00:00Z", "sdk", "sys", "usr", "[]");
}

function insertRoutingCalibration(db: DbClient, calId: string, taskId: string): void {
  db.sqlite
    .query(
      "INSERT INTO routing_calibration (id, task_id, tier_assigned) VALUES (?,?,?)"
    )
    .run(calId, taskId, "STANDARD");
}

function insertTaskDiffStats(db: DbClient, taskId: string): void {
  db.sqlite
    .query(
      `INSERT INTO task_diff_stats (
        task_id,
        files_changed,
        files_added,
        files_modified,
        files_deleted,
        lines_added,
        lines_deleted,
        test_files_changed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, 3, 1, 2, 0, 10, 4, 1);
}

function insertTaskIterationDiff(db: DbClient, taskId: string, fromIteration: number, toIteration: number): void {
  db.sqlite
    .query(
      `INSERT INTO task_iteration_diffs (
        task_id,
        from_iteration,
        to_iteration,
        files_changed,
        lines_added,
        lines_deleted,
        test_files_changed
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, fromIteration, toIteration, 2, 5, 1, 1);
}

function insertLessonForTask(db: DbClient, taskId: string): string {
  db.sqlite.query(
    "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('v-lesson','persona:coder','1','seed','baseline',1.0)"
  ).run();
  return db.insertLesson({
    agentType: "coder",
    lineageRootId: "v-lesson",
    sourceTaskId: taskId,
    sourceVariantId: "v-lesson",
    triggerPattern: "archived task evidence",
    body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
    outcomeKind: "corrective"
  });
}

describe("DbClient.archiveTask", () => {
  test("sets archived_at to a non-null ISO-ish timestamp", () => {
    const db = freshDb();
    insertTask(db, "task-1");
    db.archiveTask("task-1");
    const task = db.getTask("task-1");
    expect(task).not.toBeNull();
    expect(task!.archivedAt).toBeDefined();
    expect(typeof task!.archivedAt).toBe("string");
    expect(task!.archivedAt!.length).toBeGreaterThan(0);
  });

  test("listTasks returns archivedAt after archiving", () => {
    const db = freshDb();
    insertTask(db, "task-2");
    db.archiveTask("task-2");
    const tasks = db.listTasks({ includeArchived: true });
    const task = tasks.find((t) => t.id === "task-2");
    expect(task).toBeDefined();
    expect(task!.archivedAt).toBeDefined();
    expect(typeof task!.archivedAt).toBe("string");
  });

  test("throws a descriptive error when taskId does not exist", () => {
    const db = freshDb();
    expect(() => db.archiveTask("nonexistent-id")).toThrow(/not found/i);
  });
});

describe("DbClient.unarchiveTask", () => {
  test("clears archived_at back to undefined", () => {
    const db = freshDb();
    insertArchivedTask(db, "task-3");
    db.unarchiveTask("task-3");
    const task = db.getTask("task-3");
    expect(task).not.toBeNull();
    expect(task!.archivedAt).toBeUndefined();
  });

  test("throws a descriptive error when taskId does not exist", () => {
    const db = freshDb();
    expect(() => db.unarchiveTask("nonexistent-id")).toThrow(/not found/i);
  });
});

describe("DbClient.deleteTaskPermanently", () => {
  test("removes the task row and all dependent rows in one transaction", () => {
    const db = freshDb();
    insertArchivedTask(db, "task-4");
    insertSubtask(db, "sub-1", "task-4");
    insertReviewFinding(db, "finding-1", "task-4");
    insertEvent(db, "evt-1", "task-4");
    insertTranscript(db, "transcript-1", "task-4");
    insertRoutingCalibration(db, "cal-1", "task-4");

    db.deleteTaskPermanently("task-4");

    expect(db.getTask("task-4")).toBeNull();
    const subtasks = db.sqlite.query("SELECT * FROM subtasks WHERE task_id = ?").all("task-4");
    expect(subtasks).toHaveLength(0);
    const findings = db.sqlite.query("SELECT * FROM review_findings WHERE task_id = ?").all("task-4");
    expect(findings).toHaveLength(0);
    const events = db.sqlite.query("SELECT * FROM events WHERE task_id = ?").all("task-4");
    expect(events).toHaveLength(0);
    const transcripts = db.sqlite.query("SELECT * FROM agent_transcripts WHERE task_id = ?").all("task-4");
    expect(transcripts).toHaveLength(0);
    const calibrations = db.sqlite.query("SELECT * FROM routing_calibration WHERE task_id = ?").all("task-4");
    expect(calibrations).toHaveLength(0);
  });

  test("throws when task is not archived and leaves all rows intact", () => {
    const db = freshDb();
    insertTask(db, "task-5");
    insertSubtask(db, "sub-2", "task-5");

    expect(() => db.deleteTaskPermanently("task-5")).toThrow(/archived/i);

    // rows remain intact
    expect(db.getTask("task-5")).not.toBeNull();
    const subtasks = db.sqlite.query("SELECT * FROM subtasks WHERE task_id = ?").all("task-5");
    expect(subtasks).toHaveLength(1);
  });

  test("throws a descriptive error when taskId does not exist", () => {
    const db = freshDb();
    expect(() => db.deleteTaskPermanently("nonexistent-id")).toThrow(/not found/i);
  });

  test("deletes task_diff_stats and task_iteration_diffs before removing the archived task", () => {
    const db = freshDb();
    insertArchivedTask(db, "task-6");
    insertTaskDiffStats(db, "task-6");
    insertTaskIterationDiff(db, "task-6", 0, 1);

    expect(() => db.deleteTaskPermanently("task-6")).not.toThrow();

    expect(db.getTask("task-6")).toBeNull();
    const diffStats = db.sqlite.query("SELECT * FROM task_diff_stats WHERE task_id = ?").all("task-6");
    expect(diffStats).toHaveLength(0);
    const iterationDiffs = db.sqlite.query("SELECT * FROM task_iteration_diffs WHERE task_id = ?").all("task-6");
    expect(iterationDiffs).toHaveLength(0);
  });

  test("refuses to delete archived tasks that have durable lessons", () => {
    const db = freshDb();
    insertArchivedTask(db, "task-with-lesson");
    const lessonId = insertLessonForTask(db, "task-with-lesson");

    expect(() => db.deleteTaskPermanently("task-with-lesson")).toThrow(/lesson/i);

    expect(db.getTask("task-with-lesson")).not.toBeNull();
    const lesson = db.sqlite
      .query("SELECT status FROM lessons WHERE id = ?")
      .get(lessonId) as { status: string } | null;
    expect(lesson).not.toBeNull();
    expect(lesson!.status).toBe("active");
  });
});

describe("DbClient.rebuildProjectionsFromEvents", () => {
  test("rebuilds tasks from events without deleting durable observability rows", () => {
    const db = freshDb();
    insertTask(db, "task-rebuild");
    insertEvent(db, "evt-rebuild", "task-rebuild");
    insertSubtask(db, "sub-rebuild", "task-rebuild");
    insertReviewFinding(db, "finding-rebuild", "task-rebuild");
    insertRoutingCalibration(db, "cal-rebuild", "task-rebuild");
    insertTaskDiffStats(db, "task-rebuild");
    insertTaskIterationDiff(db, "task-rebuild", 0, 1);

    expect(() => db.rebuildProjectionsFromEvents()).not.toThrow();

    expect(db.getTask("task-rebuild")).not.toBeNull();
    expect(db.sqlite.query("SELECT * FROM subtasks").all()).toHaveLength(0);
    expect(db.sqlite.query("SELECT * FROM review_findings").all()).toHaveLength(0);
    expect(db.sqlite.query("SELECT * FROM routing_calibration WHERE task_id = ?").all("task-rebuild")).toHaveLength(1);
    expect(db.sqlite.query("SELECT * FROM task_diff_stats WHERE task_id = ?").all("task-rebuild")).toHaveLength(1);
    expect(db.sqlite.query("SELECT * FROM task_iteration_diffs WHERE task_id = ?").all("task-rebuild")).toHaveLength(1);
  });
});
