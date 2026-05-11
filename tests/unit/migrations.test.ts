import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("repository migration file set is unchanged", () => {
    const files = readdirSync(resolve(process.cwd(), "src/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect(files).toEqual([
      "001_population_schema.sql",
      "002_task_diff_stats.sql",
      "003_transcripts_variant.sql",
      "004_experiments_evidence.sql",
      "005_reward_views.sql",
      "006_fix_reward_views_planner_fallback.sql",
      "007_lessons.sql",
      "008_experiments_proposed_content.sql",
      "009_fork_proposals.sql",
      "010_specialty_embedding.sql",
      "011_spec_artifacts.sql"
    ]);
  });
});

// Plan §Task 3 — dedicated coverage for migration 011.
//
// Migration 011 rewrites legacy `stage = 'planner'` rows to
// `'planner:execution_plan'` so the two-phase planner namespacing is
// retroactive. We verify the rewrite happens, the (task_id, stage, attempt)
// UNIQUE invariant is preserved, and that legacy per-task attempt counters
// remain monotonic after the rewrite (so `critiquePlan` on a legacy task can
// still walk the right attempt history under PLANNER_MAX_ITERATIONS).
describe("migration 011 — legacy planner stage rewrite", () => {
  let tempDir: string;
  let db: DbClient;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "migration-011-test-"));
    db = new DbClient(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rewrites stage='planner' to 'planner:execution_plan' and preserves UNIQUE", () => {
    // Apply migrations up through 010 only, by copying selected SQL files
    // into a scratch dir.
    const earlyMigrationsDir = join(tempDir, "early-migrations");
    mkdirSync(earlyMigrationsDir, { recursive: true });
    const allMigrations = readdirSync(resolve(process.cwd(), "src/db/migrations"))
      .filter((name) => name.endsWith(".sql") && !name.startsWith("011_"))
      .sort();
    for (const file of allMigrations) {
      const src = resolve(process.cwd(), "src/db/migrations", file);
      const dest = join(earlyMigrationsDir, file);
      writeFileSync(dest, require("node:fs").readFileSync(src, "utf8"));
    }
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), earlyMigrationsDir);

    // Insert pre-migration planner rows. Two tasks, attempts 0 and 1 each, all
    // stage='planner' (the legacy namespace).
    const insert = db.sqlite.query(`
      INSERT INTO agent_transcripts (
        id, task_id, stage, attempt, persona_version_id, created_at, executor_used,
        model, system_prompt, user_prompt, transcript, output, critique,
        token_input, token_output, elapsed_seconds
      ) VALUES (?, ?, 'planner', ?, NULL, datetime('now'), 'mock', NULL, '', '', '', NULL, NULL, NULL, NULL, NULL)
    `);
    insert.run("transcript-a-0", "task-a", 0);
    insert.run("transcript-a-1", "task-a", 1);
    insert.run("transcript-b-0", "task-b", 0);

    const preStages = db.sqlite
      .query("SELECT stage FROM agent_transcripts ORDER BY task_id, attempt")
      .all() as Array<{ stage: string }>;
    expect(preStages.map((r) => r.stage)).toEqual(["planner", "planner", "planner"]);

    // Now apply migration 011 against the same DB by re-running initSchema
    // pointed at the canonical migrations directory.
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const postStages = db.sqlite
      .query("SELECT task_id, stage, attempt FROM agent_transcripts ORDER BY task_id, attempt")
      .all() as Array<{ task_id: string; stage: string; attempt: number }>;
    expect(postStages).toEqual([
      { task_id: "task-a", stage: "planner:execution_plan", attempt: 0 },
      { task_id: "task-a", stage: "planner:execution_plan", attempt: 1 },
      { task_id: "task-b", stage: "planner:execution_plan", attempt: 0 }
    ]);

    // Re-inserting at attempt 0 with the new (post-rewrite) stage should still
    // trip the (task_id, stage, attempt) UNIQUE constraint — the rewrite did
    // not weaken the invariant.
    const collide = db.sqlite.query(`
      INSERT INTO agent_transcripts (
        id, task_id, stage, attempt, persona_version_id, created_at, executor_used,
        model, system_prompt, user_prompt, transcript, output, critique,
        token_input, token_output, elapsed_seconds
      ) VALUES (?, ?, 'planner:execution_plan', ?, NULL, datetime('now'), 'mock', NULL, '', '', '', NULL, NULL, NULL, NULL, NULL)
    `);
    expect(() =>
      collide.run("transcript-a-collide", "task-a", 0)
    ).toThrow();
  });

  test("migration 011 records itself in schema_migrations exactly once", () => {
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const count = db.sqlite
      .query("SELECT COUNT(*) AS n FROM schema_migrations WHERE migration_file = ?")
      .get("011_spec_artifacts.sql") as { n: number };
    expect(count.n).toBe(1);

    // Calling initSchema again must be a no-op for migration 011.
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const count2 = db.sqlite
      .query("SELECT COUNT(*) AS n FROM schema_migrations WHERE migration_file = ?")
      .get("011_spec_artifacts.sql") as { n: number };
    expect(count2.n).toBe(1);
  });
});
