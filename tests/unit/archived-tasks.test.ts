import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "archived-tasks-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function insertTask(db: DbClient, id: string, archivedAt?: string) {
  db.sqlite
    .query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at${archivedAt !== undefined ? ", archived_at" : ""})
       VALUES (?,?,?,?,?,?,?,?,?,?${archivedAt !== undefined ? ",?" : ""})`
    )
    .run(...([id, "proj-1", "some task", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z", ...(archivedAt !== undefined ? [archivedAt] : [])] as Parameters<typeof db.sqlite.query extends (q: string) => { run: (...args: infer A) => unknown } ? never : never>));
}

describe("tasks schema — archived_at column", () => {
  test("fresh DB from schema.sql has archived_at as nullable TEXT on tasks", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === "archived_at");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
  });

  test("initSchema on an existing DB without archived_at adds the column without throwing", () => {
    // Create a DB without archived_at by creating the table manually first
    const dir = mkdtempSync(join(tmpdir(), "archived-tasks-existing-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    // Create tasks table without archived_at
    db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        description TEXT NOT NULL,
        state TEXT NOT NULL,
        tier TEXT NOT NULL,
        assessment TEXT NOT NULL,
        plan TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        pr_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Verify archived_at is NOT present before initSchema
    const colsBefore = db.sqlite
      .query("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(colsBefore.map((c) => c.name)).not.toContain("archived_at");

    // initSchema should not throw even though table already exists
    expect(() => db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    )).not.toThrow();

    // archived_at should now be present
    const colsAfter = db.sqlite
      .query("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(colsAfter.map((c) => c.name)).toContain("archived_at");
  });

  test("initSchema is idempotent — calling twice does not throw", () => {
    const db = freshDb();
    expect(() => db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    )).not.toThrow();
  });
});

describe("DbClient.listTasks — archivedAt field", () => {
  test("returns archivedAt as undefined for a non-archived task", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("t-active", "proj-1", "desc", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");

    const tasks = db.listTasks();
    const task = tasks.find((t) => t.id === "t-active");
    expect(task).toBeDefined();
    expect(task!.archivedAt).toBeUndefined();
  });

  test("returns archivedAt as a string for an archived task", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run("t-archived", "proj-1", "desc", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z", "2026-04-19T12:00:00Z");

    const tasks = db.listTasks({ includeArchived: true });
    const task = tasks.find((t) => t.id === "t-archived");
    expect(task).toBeDefined();
    expect(task!.archivedAt).toBe("2026-04-19T12:00:00Z");
  });
});

describe("DbClient.getTask — archivedAt field", () => {
  test("returns archivedAt as undefined for a non-archived row", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("t-get-active", "proj-1", "desc", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");

    const task = db.getTask("t-get-active");
    expect(task).not.toBeNull();
    expect(task!.archivedAt).toBeUndefined();
  });

  test("returns archivedAt for an archived row", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run("t-get-archived", "proj-1", "desc", "completed", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z", "2026-04-19T09:00:00Z");

    const task = db.getTask("t-get-archived");
    expect(task).not.toBeNull();
    expect(task!.archivedAt).toBe("2026-04-19T09:00:00Z");
  });
});
