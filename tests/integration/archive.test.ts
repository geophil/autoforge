import { describe, expect, test, afterEach } from "bun:test";
import { createTestService, cleanupAllTestServices } from "../helpers/create-service";
import type { DbClient } from "../../src/db/client";

afterEach(() => {
  cleanupAllTestServices();
});

function insertTask(db: DbClient, id: string, state: string, archivedAt?: string): void {
  const cols = archivedAt !== undefined ? ", archived_at" : "";
  const placeholders = archivedAt !== undefined ? ",?" : "";
  const args: unknown[] = [
    id, "proj-test", "some task", state, "STANDARD", "{}", "[]", 0,
    "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z",
    ...(archivedAt !== undefined ? [archivedAt] : [])
  ];
  db.sqlite
    .query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at${cols})
       VALUES (?,?,?,?,?,?,?,?,?,?${placeholders})`
    )
    .run(...(args as Parameters<ReturnType<typeof db.sqlite.query>["run"]>));
}

describe("OrchestratorService.archiveTask", () => {
  test("throws when task is in a non-terminal state", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-exec", "executing");
    await expect(service.archiveTask("task-exec")).rejects.toThrow(/terminal/i);
  });

  test("succeeds for completed task and marks archived_at", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-done", "completed");
    const task = await service.archiveTask("task-done");
    expect(task.archivedAt).toBeDefined();
    expect(typeof task.archivedAt).toBe("string");
    expect(task.archivedAt!.length).toBeGreaterThan(0);
  });

  test("succeeds for failed task and marks archived_at", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-fail", "failed");
    const task = await service.archiveTask("task-fail");
    expect(task.archivedAt).toBeDefined();
  });

  test("records a task_archived event", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-ev", "completed");
    await service.archiveTask("task-ev");
    const events = db.listEvents("task-ev");
    const archived = events.find((e) => e.type === "task_archived");
    expect(archived).toBeDefined();
  });
});

describe("OrchestratorService.unarchiveTask", () => {
  test("restores the task to the active (non-archived) list", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-arc", "completed", "2026-04-19T01:00:00Z");

    // Before: not in default listTasks (archived excluded by default)
    const before = service.listTasks();
    expect(before.find((t) => t.id === "task-arc")).toBeUndefined();

    await service.unarchiveTask("task-arc");

    // After: appears in default listTasks
    const after = service.listTasks();
    const found = after.find((t) => t.id === "task-arc");
    expect(found).toBeDefined();
    expect(found!.archivedAt).toBeUndefined();
  });

  test("records a task_unarchived event", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-uev", "completed", "2026-04-19T01:00:00Z");
    await service.unarchiveTask("task-uev");
    const events = db.listEvents("task-uev");
    const unarchived = events.find((e) => e.type === "task_unarchived");
    expect(unarchived).toBeDefined();
  });
});

describe("OrchestratorService.deleteTaskPermanently", () => {
  test("throws when task is not archived", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-notarc", "completed");
    await expect(service.deleteTaskPermanently("task-notarc")).rejects.toThrow(/archived/i);
  });

  test("succeeds when task is archived and removes it from DB", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-del", "completed", "2026-04-19T01:00:00Z");
    await service.deleteTaskPermanently("task-del");
    expect(db.getTask("task-del")).toBeNull();
  });

  test("records task_deleted event before delete (event is cascade-deleted)", async () => {
    const { service, db } = createTestService();
    insertTask(db, "task-devt", "completed", "2026-04-19T01:00:00Z");
    // The event is recorded then the task+events are deleted — no error expected
    await expect(service.deleteTaskPermanently("task-devt")).resolves.toBeUndefined();
    // task and its events are gone
    expect(db.getTask("task-devt")).toBeNull();
    const events = db.listEvents("task-devt");
    expect(events).toHaveLength(0);
  });
});

describe("OrchestratorService.listTasks — archive filtering", () => {
  test("by default excludes archived tasks", () => {
    const { service, db } = createTestService();
    insertTask(db, "t-active", "completed");
    insertTask(db, "t-archived", "completed", "2026-04-19T01:00:00Z");

    const tasks = service.listTasks();
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("t-active");
    expect(ids).not.toContain("t-archived");
  });

  test("with includeArchived:true returns both active and archived", () => {
    const { service, db } = createTestService();
    insertTask(db, "t-act2", "completed");
    insertTask(db, "t-arc2", "completed", "2026-04-19T01:00:00Z");

    const tasks = service.listTasks({ includeArchived: true });
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("t-act2");
    expect(ids).toContain("t-arc2");
  });

  test("with onlyArchived:true returns only archived tasks", () => {
    const { service, db } = createTestService();
    insertTask(db, "t-act3", "completed");
    insertTask(db, "t-arc3", "completed", "2026-04-19T01:00:00Z");

    const tasks = service.listTasks({ onlyArchived: true });
    const ids = tasks.map((t) => t.id);
    expect(ids).not.toContain("t-act3");
    expect(ids).toContain("t-arc3");
  });
});
