import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

describe("DbClient migrations", () => {
  let tempDir: string;
  let migrationsDir: string;
  let db: DbClient;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "db-migrations-test-"));
    migrationsDir = join(tempDir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    db = new DbClient(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("applies a pending migration and records it in schema_migrations", () => {
    writeFileSync(
      join(migrationsDir, "001_add_runtime_flag.sql"),
      [
        "ALTER TABLE tasks ADD COLUMN runtime_flag TEXT;",
        "UPDATE tasks SET runtime_flag = 'pending';"
      ].join("\n")
    );

    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), migrationsDir);

    const cols = db.sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("runtime_flag");

    const migration = db.sqlite
      .query("SELECT migration_file FROM schema_migrations WHERE migration_file = ?")
      .get("001_add_runtime_flag.sql") as { migration_file: string } | null;
    expect(migration?.migration_file).toBe("001_add_runtime_flag.sql");
  });

  test("does not re-apply an already-applied migration on second initSchema", () => {
    writeFileSync(
      join(migrationsDir, "001_seed_reapply_guard.sql"),
      [
        "CREATE TABLE IF NOT EXISTS migration_test_runs (run_count INTEGER NOT NULL);",
        "INSERT INTO migration_test_runs (run_count) VALUES (1);"
      ].join("\n")
    );

    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), migrationsDir);
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), migrationsDir);

    const row = db.sqlite
      .query("SELECT COUNT(*) AS count, SUM(run_count) AS total FROM migration_test_runs")
      .get() as { count: number; total: number };
    expect(row.count).toBe(1);
    expect(row.total).toBe(1);

    const migrationCount = db.sqlite
      .query("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_file = ?")
      .get("001_seed_reapply_guard.sql") as { count: number };
    expect(migrationCount.count).toBe(1);
  });

  test("applies migrations in filename order", () => {
    writeFileSync(join(migrationsDir, "002_record_second.sql"), "INSERT INTO migration_order_log (name) VALUES ('second');");
    writeFileSync(
      join(migrationsDir, "001_create_order_log.sql"),
      [
        "CREATE TABLE IF NOT EXISTS migration_order_log (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  name TEXT NOT NULL",
        ");",
        "INSERT INTO migration_order_log (name) VALUES ('first');"
      ].join("\n")
    );
    writeFileSync(join(migrationsDir, "003_record_third.sql"), "INSERT INTO migration_order_log (name) VALUES ('third');");

    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), migrationsDir);

    const rows = db.sqlite
      .query("SELECT name FROM migration_order_log ORDER BY id ASC")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(["first", "second", "third"]);
  });

  test("missing migrations directory => initSchema no-ops cleanly and does not throw", () => {
    const missingDir = join(tempDir, "does-not-exist");

    expect(() => db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), missingDir)).not.toThrow();

    const count = db.sqlite
      .query("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  test("failed migration rolls back and is NOT recorded in schema_migrations", () => {
    writeFileSync(
      join(migrationsDir, "001_broken_migration.sql"),
      [
        "CREATE TABLE migration_failure_log (id INTEGER PRIMARY KEY);",
        "INSERT INTO definitely_missing_table (id) VALUES (1);"
      ].join("\n")
    );

    expect(() => db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), migrationsDir)).toThrow(
      "Failed to apply migration 001_broken_migration.sql"
    );

    const tables = db.sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all("migration_failure_log") as Array<{ name: string }>;
    expect(tables).toHaveLength(0);

    const migrationCount = db.sqlite
      .query("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_file = ?")
      .get("001_broken_migration.sql") as { count: number };
    expect(migrationCount.count).toBe(0);
  });
});
