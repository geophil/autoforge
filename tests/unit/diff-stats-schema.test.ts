import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "diff-stats-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("diff stats schema", () => {
  test("task_diff_stats exists with expected columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(task_diff_stats)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;

    expect(cols.map((col) => col.name)).toEqual([
      "task_id",
      "files_changed",
      "files_added",
      "files_modified",
      "files_deleted",
      "lines_added",
      "lines_deleted",
      "test_files_changed",
      "captured_at"
    ]);

    expect(cols.map((col) => [col.name, col.type, col.notnull, col.pk, col.dflt_value])).toEqual([
      ["task_id", "TEXT", 1, 1, null],
      ["files_changed", "INTEGER", 1, 0, null],
      ["files_added", "INTEGER", 1, 0, null],
      ["files_modified", "INTEGER", 1, 0, null],
      ["files_deleted", "INTEGER", 1, 0, null],
      ["lines_added", "INTEGER", 1, 0, null],
      ["lines_deleted", "INTEGER", 1, 0, null],
      ["test_files_changed", "INTEGER", 1, 0, null],
      ["captured_at", "TEXT", 1, 0, "datetime('now')"]
    ]);
  });

  test("task_iteration_diffs exists with composite PK (task_id, from_iteration, to_iteration)", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(task_iteration_diffs)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
    const indexes = db.sqlite
      .query("PRAGMA index_list(task_iteration_diffs)")
      .all() as Array<{ name: string }>;

    expect(cols.map((col) => col.name)).toEqual([
      "task_id",
      "from_iteration",
      "to_iteration",
      "files_changed",
      "lines_added",
      "lines_deleted",
      "test_files_changed",
      "diff_summary",
      "captured_at"
    ]);

    expect(cols.map((col) => [col.name, col.type, col.notnull, col.pk, col.dflt_value])).toEqual([
      ["task_id", "TEXT", 1, 1, null],
      ["from_iteration", "INTEGER", 1, 2, null],
      ["to_iteration", "INTEGER", 1, 3, null],
      ["files_changed", "INTEGER", 1, 0, null],
      ["lines_added", "INTEGER", 1, 0, null],
      ["lines_deleted", "INTEGER", 1, 0, null],
      ["test_files_changed", "INTEGER", 1, 0, null],
      ["diff_summary", "TEXT", 0, 0, null],
      ["captured_at", "TEXT", 1, 0, "datetime('now')"]
    ]);

    expect(indexes.some((index) => index.name === "idx_task_iteration_diffs_task")).toBe(true);
  });

  test("task_diff_stats enforces foreign keys against tasks", () => {
    const db = freshDb();

    expect(() =>
      db.sqlite
        .query(`
          INSERT INTO task_diff_stats (
            task_id,
            files_changed,
            files_added,
            files_modified,
            files_deleted,
            lines_added,
            lines_deleted,
            test_files_changed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run("missing-task", 1, 0, 1, 0, 3, 1, 0)
    ).toThrow();
  });
});
