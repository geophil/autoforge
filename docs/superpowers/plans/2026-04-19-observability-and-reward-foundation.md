# Autoforge Spec A — Observability and Reward Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Layers 1 and 2 of the self-improving-persona-population umbrella — a numbered-migration mechanism, population-shaped schema columns, per-task and per-iteration diff capture, dispatch-time `variant_selected` events, failure-analysis payload enrichment, a composite reward function as SQL views, and a weight-configuration loader.

**Architecture:** Pure data-layer additions. No behavioral changes to the orchestrator's task flow beyond new side-emissions (extra events, extra stats rows). The reward function is implemented as SQL views emitting five normalized components per task; composition with runtime-loaded weights happens in application code (`reward.ts`). All schema additions are forward-only via numbered migration files; existing `schema.sql` gets a new `schema_migrations` table and the `initSchema()` helper runs pending migrations in filename order.

**Tech Stack:** TypeScript, Bun runtime, `bun:sqlite`, existing event-sourced orchestrator. No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-04-19-observability-and-reward-foundation-design.md`](../specs/2026-04-19-observability-and-reward-foundation-design.md). Read it first for context. Umbrella: [`docs/superpowers/specs/2026-04-19-self-improving-persona-population-design.md`](../specs/2026-04-19-self-improving-persona-population-design.md).

---

## File Structure

**New files (create):**

```
src/db/migrations/
  001_population_schema.sql
  002_task_diff_stats.sql
  003_transcripts_variant.sql
  004_experiments_evidence.sql
  005_reward_views.sql
src/orchestrator/diff-stats.ts          # computeDiffStats + computeIterationDiff helpers
src/config/reward.ts                    # weights loader + computeComposite()
src/config/reward-weights.json          # default equal weights
tests/unit/migrations.test.ts
tests/unit/diff-stats.test.ts
tests/unit/reward-config.test.ts
tests/unit/reward-views.test.ts
tests/unit/variant-selected-event.test.ts
tests/unit/failure-analysis-payload.test.ts
```

**Modified files:**

```
src/db/schema.sql                       # + schema_migrations table
src/db/client.ts                        # migrations runner in initSchema; new helpers
src/orchestrator/service.ts             # computeDiffStats call; computeIterationDiff call;
                                        # variant_selected emission; failure_analysis payload enrichment
```

Each task below produces a self-contained change that compiles, tests pass, and can be committed.

---

## Conventions used in this plan

- **Tests use Bun's built-in runner** (`bun test`). Test files live under `tests/unit/` or `tests/integration/`, imports from `bun:test`.
- **DB tests** always create a fresh SQLite file in `tmpdir()` (see `tests/unit/archived-tasks.test.ts` for the pattern).
- **Migrations** must be idempotent safe only to the extent that `schema_migrations` guards re-running them. Each migration runs inside a transaction; a failed migration does not record itself in `schema_migrations` and is retried on next startup.
- **Commit messages** follow Conventional Commits (`feat:`, `fix:`, `test:`, etc.) and include short imperative subject, optional body. Use HEREDOC syntax when the message has multiple lines.
- **Run the full suite** (`bun test`) before every commit to catch regressions. Most tasks have a targeted unit test run during the red-green cycle, then a full suite run before commit.
- **Lint**: `bun run lint` runs `tsc --noEmit`. Run after any change to `.ts` files; fix any new errors before commit.

---

## Task 1: Migrations infrastructure

Introduce a numbered-migration mechanism. The base `schema.sql` stays authoritative; migration files under `src/db/migrations/` run after the base schema on every startup, in filename order, each recorded in a new `schema_migrations` table.

**Files:**
- Modify: `src/db/schema.sql` — add `schema_migrations` table
- Modify: `src/db/client.ts` — extend `initSchema` to run migrations
- Create: `src/db/migrations/` — empty directory (a `.gitkeep` file is sufficient)
- Test: `tests/unit/migrations.test.ts`

- [ ] **Step 1: Add `schema_migrations` table to base schema**

Open `src/db/schema.sql` and append at the end:

```sql
-- Tracks which numbered migration files have been applied on top of the base schema.
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_file TEXT PRIMARY KEY,
  applied_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Create the migrations directory**

```bash
mkdir -p src/db/migrations
touch src/db/migrations/.gitkeep
```

- [ ] **Step 3: Write failing test for the migrations runner**

Create `tests/unit/migrations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function setupDb(): { db: DbClient; dir: string; schemaPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "migrations-test-"));
  mkdirSync(join(dir, "migrations"), { recursive: true });

  const schemaPath = join(dir, "schema.sql");
  writeFileSync(schemaPath, `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_file TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  return { db, dir, schemaPath };
}

describe("DbClient migrations runner", () => {
  test("applies a pending migration and records it in schema_migrations", () => {
    const { db, dir, schemaPath } = setupDb();

    // Create one migration file.
    writeFileSync(
      join(dir, "migrations", "001_noop.sql"),
      "CREATE TABLE IF NOT EXISTS test_noop (id TEXT PRIMARY KEY);"
    );

    db.initSchema(schemaPath, join(dir, "migrations"));

    const rows = db.sqlite
      .query("SELECT migration_file FROM schema_migrations")
      .all() as Array<{ migration_file: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].migration_file).toBe("001_noop.sql");

    const tables = db.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='test_noop'")
      .all();
    expect(tables).toHaveLength(1);

    rmSync(dir, { recursive: true });
  });

  test("does not re-apply an already-applied migration on second initSchema", () => {
    const { db, dir, schemaPath } = setupDb();
    writeFileSync(
      join(dir, "migrations", "001_once.sql"),
      "CREATE TABLE IF NOT EXISTS test_once (id TEXT PRIMARY KEY);"
    );

    db.initSchema(schemaPath, join(dir, "migrations"));
    db.initSchema(schemaPath, join(dir, "migrations")); // second run: no-op

    const rows = db.sqlite
      .query("SELECT COUNT(*) as n FROM schema_migrations WHERE migration_file='001_once.sql'")
      .get() as { n: number };
    expect(rows.n).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test("applies migrations in filename order", () => {
    const { db, dir, schemaPath } = setupDb();
    writeFileSync(
      join(dir, "migrations", "002_second.sql"),
      "INSERT INTO schema_migrations (migration_file) VALUES ('fingerprint:002');"
    );
    writeFileSync(
      join(dir, "migrations", "001_first.sql"),
      "INSERT INTO schema_migrations (migration_file) VALUES ('fingerprint:001');"
    );

    db.initSchema(schemaPath, join(dir, "migrations"));

    const rows = db.sqlite
      .query(
        "SELECT migration_file FROM schema_migrations WHERE migration_file LIKE 'fingerprint:%' ORDER BY applied_at ASC"
      )
      .all() as Array<{ migration_file: string }>;
    expect(rows.map((r) => r.migration_file)).toEqual(["fingerprint:001", "fingerprint:002"]);

    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
bun test tests/unit/migrations.test.ts
```

Expected: FAIL. `db.initSchema` currently only accepts a single argument (the schema path); passing a second argument is silently ignored. The `schema_migrations` table exists (from Step 1) but there is no runner, so the `test_noop` table is never created.

- [ ] **Step 5: Implement the migrations runner**

Open `src/db/client.ts`. Add `readdirSync` to the imports at the top:

```typescript
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
```

Replace the existing `initSchema` method (around line 19) with:

```typescript
initSchema(schemaPath: string, migrationsDir?: string): void {
  const schema = readFileSync(schemaPath, "utf8");
  this.sqlite.exec(schema);
  // Idempotent migration: add archived_at to tasks if it was not yet present
  // (handles existing databases created before this column was added to schema.sql).
  const taskCols = this.sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === "archived_at")) {
    this.sqlite.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
  }

  if (migrationsDir) {
    this.applyPendingMigrations(migrationsDir);
  }
}

private applyPendingMigrations(migrationsDir: string): void {
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // Directory doesn't exist — nothing to apply.
    return;
  }

  for (const file of files) {
    const already = this.sqlite
      .query("SELECT 1 FROM schema_migrations WHERE migration_file = ?")
      .get(file);
    if (already) continue;

    const sql = readFileSync(pathJoin(migrationsDir, file), "utf8");
    const run = this.sqlite.transaction(() => {
      this.sqlite.exec(sql);
      this.sqlite
        .query("INSERT INTO schema_migrations (migration_file) VALUES (?)")
        .run(file);
    });
    run();
    console.log(`[db] Applied migration ${file}`);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
bun test tests/unit/migrations.test.ts
```

Expected: PASS (three tests).

- [ ] **Step 7: Wire the production migrations directory into the app entry point**

Find the `initSchema` call site. It is in `src/index.ts`:

```bash
grep -n "initSchema" src/index.ts
```

If the current call is `db.initSchema(schemaPath)`, change it to:

```typescript
db.initSchema(schemaPath, resolve(process.cwd(), "src/db/migrations"));
```

Add `resolve` to the `node:path` import at the top of `src/index.ts` if not already present. Confirm via `grep`.

- [ ] **Step 8: Run the full test suite**

```bash
bun test
bun run lint
```

Expected: all tests pass; no new TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/client.ts src/db/migrations/.gitkeep src/index.ts tests/unit/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add numbered-migrations runner

Introduce a schema_migrations table and a migrations directory
convention. DbClient.initSchema now accepts an optional migrations
directory path; pending *.sql files are applied in filename order,
each recorded on success. This is the foundation for Spec A's
schema evolutions.
EOF
)"
```

---

## Task 2: Population-shaped skill_versions columns

Migration 001 adds `parent_version_id`, `specialty`, `status`, `traffic_share` to `skill_versions`, backfills existing rows, and installs triggers that keep the legacy `is_active` column in sync with `status`.

**Files:**
- Create: `src/db/migrations/001_population_schema.sql`
- Test: `tests/unit/population-schema.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/population-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "pop-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function insertSkillVersion(
  db: DbClient,
  id: string,
  skillName: string,
  isActive: 0 | 1 = 0
): void {
  db.sqlite
    .query(
      `INSERT INTO skill_versions (id, skill_name, version, content, is_active)
       VALUES (?, ?, '1', 'content', ?)`
    )
    .run(id, skillName, isActive);
}

describe("skill_versions — population schema", () => {
  test("new columns exist with expected defaults", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(skill_versions)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    expect(cols.find((c) => c.name === "parent_version_id")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "specialty")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "status")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "status")?.dflt_value).toContain("candidate");
    expect(cols.find((c) => c.name === "traffic_share")?.type).toBe("REAL");
  });

  test("backfill: exactly one baseline per skill_name when multiple is_active=1 rows exist", () => {
    // Create a fresh DB, insert rows BEFORE running the population migration,
    // then re-run initSchema to apply the migration.
    const dir = mkdtempSync(join(tmpdir(), "pop-backfill-test-"));
    const dbPath = join(dir, `${randomUUID()}.sqlite`);
    const db = new DbClient(dbPath);

    // Apply base schema only (no migrations yet).
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));

    // Insert two rows that are both is_active=1 for same skill_name (simulating a prior bug).
    insertSkillVersion(db, "v1", "persona:coder", 1);
    // force created_at ordering
    db.sqlite
      .query("UPDATE skill_versions SET created_at = '2025-01-01T00:00:00Z' WHERE id = 'v1'")
      .run();
    insertSkillVersion(db, "v2", "persona:coder", 1);
    db.sqlite
      .query("UPDATE skill_versions SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'v2'")
      .run();
    insertSkillVersion(db, "v3", "persona:planner", 1);

    // Now apply migrations.
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const coderBaselines = db.sqlite
      .query(
        "SELECT id FROM skill_versions WHERE skill_name = 'persona:coder' AND status = 'baseline'"
      )
      .all() as Array<{ id: string }>;
    expect(coderBaselines).toHaveLength(1);
    // Most recent (v2) should be baseline; v1 should be demoted.
    expect(coderBaselines[0].id).toBe("v2");

    const v1 = db.sqlite
      .query("SELECT status, traffic_share FROM skill_versions WHERE id = 'v1'")
      .get() as { status: string; traffic_share: number };
    expect(v1.status).toBe("demoted");
    expect(v1.traffic_share).toBe(0.0);

    const v2 = db.sqlite
      .query("SELECT status, traffic_share FROM skill_versions WHERE id = 'v2'")
      .get() as { status: string; traffic_share: number };
    expect(v2.status).toBe("baseline");
    expect(v2.traffic_share).toBe(1.0);
  });

  test("trigger: updating status to baseline flips is_active=1; updating to demoted flips it to 0", () => {
    const db = freshDb();
    insertSkillVersion(db, "vA", "persona:coder", 0);

    // Initially demoted by backfill.
    db.sqlite
      .query("UPDATE skill_versions SET status = 'baseline' WHERE id = 'vA'")
      .run();
    let row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vA'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(1);

    db.sqlite
      .query("UPDATE skill_versions SET status = 'demoted' WHERE id = 'vA'")
      .run();
    row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vA'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(0);
  });

  test("trigger: INSERTing a row with status='active' sets is_active=1", () => {
    const db = freshDb();
    db.sqlite.exec(`
      INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
      VALUES ('vB', 'persona:reviewer', '1', 'content', 'active', 0.1)
    `);
    const row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vB'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/population-schema.test.ts
```

Expected: FAIL. Columns don't exist yet.

- [ ] **Step 3: Create migration 001**

Create `src/db/migrations/001_population_schema.sql`:

```sql
-- 001: Population-shaped columns on skill_versions + is_active compatibility triggers.

ALTER TABLE skill_versions ADD COLUMN parent_version_id TEXT;
ALTER TABLE skill_versions ADD COLUMN specialty TEXT;
ALTER TABLE skill_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE skill_versions ADD COLUMN traffic_share REAL NOT NULL DEFAULT 0.0;

-- Backfill: for each skill_name, the most recent is_active=1 row becomes baseline.
-- All other rows (including older is_active=1 duplicates, if any) become demoted.
UPDATE skill_versions
   SET status = 'demoted', traffic_share = 0.0
 WHERE 1=1;

UPDATE skill_versions
   SET status = 'baseline', traffic_share = 1.0
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (PARTITION BY skill_name ORDER BY created_at DESC) AS rn
       FROM skill_versions
      WHERE is_active = 1
   ) ranked
   WHERE rn = 1
 );

-- Keep is_active in sync with status for backward compatibility.
CREATE TRIGGER IF NOT EXISTS skill_versions_is_active_sync_update
AFTER UPDATE OF status ON skill_versions
FOR EACH ROW
BEGIN
  UPDATE skill_versions
     SET is_active = CASE WHEN NEW.status IN ('baseline', 'active') THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS skill_versions_is_active_sync_insert
AFTER INSERT ON skill_versions
FOR EACH ROW
BEGIN
  UPDATE skill_versions
     SET is_active = CASE WHEN NEW.status IN ('baseline', 'active') THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/population-schema.test.ts
```

Expected: PASS (four tests).

- [ ] **Step 5: Run the full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/001_population_schema.sql tests/unit/population-schema.test.ts
git commit -m "feat(db): add population-shaped columns to skill_versions (Spec A §4.1)"
```

---

## Task 3: experiments operation + evidence columns

Migration 004 adds `operation` and `evidence` columns to the `experiments` table. Existing rows backfill with `operation = 'edit'`, `evidence = NULL`.

**Files:**
- Create: `src/db/migrations/004_experiments_evidence.sql`
- Test: `tests/unit/experiments-schema.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/experiments-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "exp-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("experiments — operation and evidence columns", () => {
  test("columns exist with correct types and defaults", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(experiments)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    const op = cols.find((c) => c.name === "operation");
    expect(op?.type).toBe("TEXT");
    expect(op?.dflt_value).toContain("edit");

    const ev = cols.find((c) => c.name === "evidence");
    expect(ev?.type).toBe("TEXT");
    expect(ev?.notnull).toBe(0);
  });

  test("inserting an experiments row without operation defaults to 'edit'", () => {
    const db = freshDb();
    const id = randomUUID();
    db.sqlite.query(
      `INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before)
       VALUES (?, 'h', 'd', 'first_pass_rate', 0.5)`
    ).run(id);

    const row = db.sqlite
      .query("SELECT operation, evidence FROM experiments WHERE id = ?")
      .get(id) as { operation: string; evidence: string | null };
    expect(row.operation).toBe("edit");
    expect(row.evidence).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/experiments-schema.test.ts
```

Expected: FAIL. Columns don't exist.

- [ ] **Step 3: Create migration 004**

Create `src/db/migrations/004_experiments_evidence.sql`:

```sql
-- 004: operation + evidence columns on experiments.

ALTER TABLE experiments ADD COLUMN operation TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE experiments ADD COLUMN evidence TEXT;

-- Existing rows are backfilled to operation='edit' by the DEFAULT clause when the
-- column is added. No separate UPDATE needed.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/experiments-schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/004_experiments_evidence.sql tests/unit/experiments-schema.test.ts
git commit -m "feat(db): add operation and evidence columns to experiments (Spec A §4.2)"
```

---

## Task 4: agent_transcripts persona_version_id column

Migration 003 adds `persona_version_id TEXT` to `agent_transcripts`, and performs a one-time backfill by looking up the matching event per `(task_id, stage, attempt)` tuple.

**Files:**
- Create: `src/db/migrations/003_transcripts_variant.sql`
- Test: `tests/unit/transcripts-variant-schema.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/transcripts-variant-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "trans-var-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("agent_transcripts — persona_version_id column", () => {
  test("column exists as nullable TEXT", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(agent_transcripts)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === "persona_version_id");
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
  });

  test("backfill: existing transcripts get persona_version_id from matching event", () => {
    const dir = mkdtempSync(join(tmpdir(), "trans-backfill-test-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));

    // Seed a task, an event with persona_version_id in payload, and a transcript.
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1', 'p1', 'desc', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
    ).run();
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES ('e1', 't1', '2026-04-19T00:01:00Z', 'p1', 'planner', 'planner_done', 'done',
               '{"persona_version_id":"pv1"}', 600)`
    ).run();
    db.sqlite.query(
      `INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, system_prompt, user_prompt, transcript)
       VALUES ('tr1', 't1', 'planner', 0, '2026-04-19T00:01:00Z', 'anthropic-sdk', 'sp', 'up', '[]')`
    ).run();

    // Run the migration.
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const row = db.sqlite
      .query("SELECT persona_version_id FROM agent_transcripts WHERE id = 'tr1'")
      .get() as { persona_version_id: string | null };
    expect(row.persona_version_id).toBe("pv1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/transcripts-variant-schema.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create migration 003**

Create `src/db/migrations/003_transcripts_variant.sql`:

```sql
-- 003: agent_transcripts gains persona_version_id, backfilled from matching events.

ALTER TABLE agent_transcripts ADD COLUMN persona_version_id TEXT;

-- Backfill: for each transcript row, find the matching event by (task_id, stage, attempt)
-- and copy persona_version_id from its payload. Stage in transcripts maps to agent in events.
-- Attempt matches event ordering per (task_id, agent).
UPDATE agent_transcripts AS at
   SET persona_version_id = (
     SELECT json_extract(e.payload, '$.persona_version_id')
       FROM events e
      WHERE e.task_id = at.task_id
        AND e.agent = at.stage
        AND json_extract(e.payload, '$.persona_version_id') IS NOT NULL
      ORDER BY e.timestamp ASC
      LIMIT 1 OFFSET (at.attempt - 0)  -- attempt is 0-indexed in this codebase
   )
 WHERE at.persona_version_id IS NULL;
```

**Note on the backfill SQL:** the `OFFSET (at.attempt - 0)` reads the Nth matching event, skipping earlier attempts. Attempts are 0-indexed in `agent_transcripts` (confirm by reading `src/types/transcripts.ts` and `src/db/client.ts :: insertAgentTranscript` if present). If attempts are 1-indexed, change the offset to `at.attempt - 1`.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/transcripts-variant-schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/003_transcripts_variant.sql tests/unit/transcripts-variant-schema.test.ts
git commit -m "feat(db): add persona_version_id to agent_transcripts with backfill (Spec A §4.3)"
```

---

## Task 5: task_diff_stats and task_iteration_diffs tables

Migration 002 creates both diff tables. No capture logic yet (that's Tasks 6 and 7) — this task only adds the schema.

**Files:**
- Create: `src/db/migrations/002_task_diff_stats.sql`
- Test: `tests/unit/diff-stats-schema.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/diff-stats-schema.test.ts`:

```typescript
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

describe("task_diff_stats and task_iteration_diffs tables", () => {
  test("task_diff_stats exists with expected columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(task_diff_stats)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "task_id",
        "files_changed",
        "files_added",
        "files_modified",
        "files_deleted",
        "lines_added",
        "lines_deleted",
        "test_files_changed",
        "captured_at"
      ])
    );
  });

  test("task_iteration_diffs exists with composite PK", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(task_iteration_diffs)")
      .all() as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(["from_iteration", "task_id", "to_iteration"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/diff-stats-schema.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create migration 002**

Create `src/db/migrations/002_task_diff_stats.sql`:

```sql
-- 002: task_diff_stats (whole-task cumulative) + task_iteration_diffs (per-rework delta).

CREATE TABLE IF NOT EXISTS task_diff_stats (
  task_id            TEXT PRIMARY KEY REFERENCES tasks(id),
  files_changed      INTEGER NOT NULL,
  files_added        INTEGER NOT NULL,
  files_modified     INTEGER NOT NULL,
  files_deleted      INTEGER NOT NULL,
  lines_added        INTEGER NOT NULL,
  lines_deleted      INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  captured_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_iteration_diffs (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  from_iteration     INTEGER NOT NULL,
  to_iteration       INTEGER NOT NULL,
  files_changed      INTEGER NOT NULL,
  lines_added        INTEGER NOT NULL,
  lines_deleted      INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  diff_summary       TEXT,
  captured_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, from_iteration, to_iteration)
);

CREATE INDEX IF NOT EXISTS idx_task_iteration_diffs_task
  ON task_iteration_diffs(task_id);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/diff-stats-schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/002_task_diff_stats.sql tests/unit/diff-stats-schema.test.ts
git commit -m "feat(db): add task_diff_stats and task_iteration_diffs tables (Spec A §4.4)"
```

---

## Task 6: computeDiffStats helper and wiring

The `computeDiffStats(worktreePath, baseRef)` helper runs `git diff --numstat <baseRef>...HEAD` inside the worktree and parses the output into a row shape matching `task_diff_stats`. The orchestrator calls it immediately before `cleanupWorktree` on every task's terminal state.

**Files:**
- Create: `src/orchestrator/diff-stats.ts`
- Test: `tests/unit/diff-stats.test.ts`
- Modify: `src/orchestrator/service.ts` — call `computeDiffStats` before `cleanupWorktree`
- Modify: `src/db/client.ts` — add `insertTaskDiffStats` helper

- [ ] **Step 1: Write failing test for `computeDiffStats`**

Create `tests/unit/diff-stats.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { computeDiffStats } from "../../src/orchestrator/diff-stats";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-stats-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  execSync("git commit --allow-empty -q -m init", { cwd: dir });
  return dir;
}

describe("computeDiffStats", () => {
  test("counts added lines and added files correctly", () => {
    const dir = initRepo();
    const baseRef = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "src", "b.test.ts"), "test\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m change", { cwd: dir });

    const stats = computeDiffStats(dir, baseRef);
    expect(stats.files_changed).toBe(2);
    expect(stats.files_added).toBe(2);
    expect(stats.files_modified).toBe(0);
    expect(stats.files_deleted).toBe(0);
    expect(stats.lines_added).toBe(4);
    expect(stats.lines_deleted).toBe(0);
    expect(stats.test_files_changed).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test("returns null when git invocation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "diff-stats-no-git-"));
    const stats = computeDiffStats(dir, "HEAD");
    expect(stats).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("counts modifications and deletions", () => {
    const dir = initRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\n");
    writeFileSync(join(dir, "src", "to-delete.ts"), "bye\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m setup", { cwd: dir });
    const baseRef = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    writeFileSync(join(dir, "src", "a.ts"), "line1-CHANGED\nline2\nline3\n");
    execSync(`git rm -q "${join(dir, "src", "to-delete.ts")}"`, { cwd: dir });
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m modify", { cwd: dir });

    const stats = computeDiffStats(dir, baseRef);
    expect(stats!.files_modified).toBe(1);
    expect(stats!.files_deleted).toBe(1);

    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/diff-stats.test.ts
```

Expected: FAIL. Module doesn't exist.

- [ ] **Step 3: Implement `computeDiffStats`**

Create `src/orchestrator/diff-stats.ts`:

```typescript
import { execSync } from "node:child_process";

export interface TaskDiffStats {
  files_changed: number;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
}

const TEST_FILE_PATTERN = /(\.test\.|\.spec\.|\/tests?\/)/;

/**
 * Runs `git diff --numstat <baseRef>...HEAD` + `git diff --name-status <baseRef>...HEAD`
 * inside the worktree, parsing both into a row shape matching task_diff_stats.
 *
 * Returns null if git invocation fails (not a git worktree, no base ref, etc.).
 * The caller treats a null return as "skip the insert" — a missing row is
 * later interpreted as neutral simplicity (0.5) by the task_quality_score view.
 */
export function computeDiffStats(worktreePath: string, baseRef: string): TaskDiffStats | null {
  try {
    const numstat = execSync(`git diff --numstat ${baseRef}...HEAD`, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const nameStatus = execSync(`git diff --name-status ${baseRef}...HEAD`, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    let lines_added = 0;
    let lines_deleted = 0;
    let test_files_changed = 0;
    const numstatLines = numstat.split("\n").filter((l) => l.trim().length > 0);
    for (const line of numstatLines) {
      const [added, deleted, path] = line.split(/\t+/);
      if (added !== "-" && deleted !== "-") {
        lines_added += Number(added);
        lines_deleted += Number(deleted);
      }
      if (TEST_FILE_PATTERN.test(path ?? "")) test_files_changed += 1;
    }

    let files_added = 0;
    let files_modified = 0;
    let files_deleted = 0;
    const nsLines = nameStatus.split("\n").filter((l) => l.trim().length > 0);
    for (const line of nsLines) {
      const status = line.charAt(0);
      if (status === "A") files_added += 1;
      else if (status === "M") files_modified += 1;
      else if (status === "D") files_deleted += 1;
    }

    return {
      files_changed: files_added + files_modified + files_deleted,
      files_added,
      files_modified,
      files_deleted,
      lines_added,
      lines_deleted,
      test_files_changed
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/diff-stats.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add DB helper `insertTaskDiffStats`**

In `src/db/client.ts`, add this method to the `DbClient` class (place it near other insert helpers — `appendEvent` or `upsertPromptAsset`):

```typescript
insertTaskDiffStats(taskId: string, stats: {
  files_changed: number;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
}): void {
  this.sqlite.query(`
    INSERT OR REPLACE INTO task_diff_stats
      (task_id, files_changed, files_added, files_modified, files_deleted,
       lines_added, lines_deleted, test_files_changed)
    VALUES
      ($task_id, $files_changed, $files_added, $files_modified, $files_deleted,
       $lines_added, $lines_deleted, $test_files_changed)
  `).run({
    $task_id: taskId,
    $files_changed: stats.files_changed,
    $files_added: stats.files_added,
    $files_modified: stats.files_modified,
    $files_deleted: stats.files_deleted,
    $lines_added: stats.lines_added,
    $lines_deleted: stats.lines_deleted,
    $test_files_changed: stats.test_files_changed
  });
}
```

- [ ] **Step 6: Wire `computeDiffStats` into the orchestrator**

Open `src/orchestrator/service.ts`. Add the import at the top:

```typescript
import { computeDiffStats } from "./diff-stats";
```

Find every call site of `this.cleanupWorktree(<taskId>)`. There are several (successful completion, failure paths, staleness sweep, cancelTask, plan rejection, etc.). Use:

```bash
grep -n "cleanupWorktree" src/orchestrator/service.ts
```

For each call site, immediately **before** the `cleanupWorktree` call, insert:

```typescript
this.captureTaskDiffStats(taskId);
```

Then add this private method to the class (near `cleanupWorktree` or `recordEvent`):

```typescript
private captureTaskDiffStats(taskId: string): void {
  try {
    const worktree = this.deps.worktrees.get(taskId);
    if (!worktree) return;
    const stats = computeDiffStats(worktree.path, worktree.baseRef ?? "HEAD");
    if (stats) {
      this.deps.db.insertTaskDiffStats(taskId, stats);
    }
  } catch (err) {
    console.warn(`[diff-stats] Failed for task ${taskId}: ${(err as Error).message}`);
  }
}
```

**Important:** `this.deps.worktrees.get(taskId)` must return an object with `path` and `baseRef`. If the existing Worktrees interface has a different shape, adapt accordingly — `baseRef` may be accessible from `worktree.baseRef` or from a separate API. Check `src/orchestrator/worktrees.ts` (or equivalent) for the actual shape. If `baseRef` isn't captured at creation, add it there in a small helper change as part of this step.

- [ ] **Step 7: Write integration test for the orchestrator wiring**

Append to `tests/unit/diff-stats.test.ts` (or create a new integration-style test in `tests/integration/task-diff-stats.test.ts`):

```typescript
// Keep the existing tests above. Append:

import { DbClient } from "../../src/db/client";
import { resolve } from "node:path";
import { randomUUID as rUuid } from "node:crypto";

describe("task_diff_stats capture via orchestrator", () => {
  test("a completed task writes one row to task_diff_stats", async () => {
    // Full orchestrator integration is substantial — this test only verifies the
    // DbClient helper writes the row and INSERT OR REPLACE on a duplicate.
    const dir = mkdtempSync(join(tmpdir(), "task-diff-stats-"));
    const db = new DbClient(join(dir, `${rUuid()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1', 'p1', 'd', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
    ).run();

    db.insertTaskDiffStats("t1", {
      files_changed: 2, files_added: 1, files_modified: 1, files_deleted: 0,
      lines_added: 10, lines_deleted: 3, test_files_changed: 1
    });
    db.insertTaskDiffStats("t1", {
      files_changed: 3, files_added: 2, files_modified: 1, files_deleted: 0,
      lines_added: 20, lines_deleted: 5, test_files_changed: 2
    });

    const row = db.sqlite
      .query("SELECT lines_added FROM task_diff_stats WHERE task_id = 't1'")
      .get() as { lines_added: number };
    expect(row.lines_added).toBe(20); // INSERT OR REPLACE upserted.

    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 8: Run all tests + lint**

```bash
bun test
bun run lint
```

Expected: all pass. Existing orchestrator tests should still pass because the new `captureTaskDiffStats` call is wrapped in try/catch and is a no-op when `worktrees.get` returns undefined.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator/diff-stats.ts src/orchestrator/service.ts src/db/client.ts tests/unit/diff-stats.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): capture task_diff_stats on terminal task states

New helper computeDiffStats runs `git diff --numstat` inside the
worktree and parses both numstat and name-status output. Called
before cleanupWorktree on every terminal state. Failures are
tolerated (null return ⇒ skip insert).
EOF
)"
```

---

## Task 7: computeIterationDiff helper and rework-loop wiring

Captures the delta between iteration N and iteration N+1 (the rework diff). Called once per rework transition; stores one row in `task_iteration_diffs`.

**Files:**
- Modify: `src/orchestrator/diff-stats.ts` — add `computeIterationDiff`
- Modify: `src/db/client.ts` — add `insertTaskIterationDiff` helper
- Modify: `src/orchestrator/service.ts` — call `computeIterationDiff` at rework loop start
- Test: extend `tests/unit/diff-stats.test.ts`

- [ ] **Step 1: Write failing test for `computeIterationDiff`**

Append to `tests/unit/diff-stats.test.ts`:

```typescript
import { computeIterationDiff } from "../../src/orchestrator/diff-stats";

describe("computeIterationDiff", () => {
  test("returns per-iteration delta between two commit refs", () => {
    const dir = initRepo();
    writeFileSync(join(dir, "iter0.ts"), "a\nb\n");
    execSync("git add -A && git commit -q -m iter0", { cwd: dir });
    const iter0Ref = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    writeFileSync(join(dir, "iter1.ts"), "x\ny\nz\n");
    execSync("git add -A && git commit -q -m iter1", { cwd: dir });
    const iter1Ref = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    const delta = computeIterationDiff(dir, iter0Ref, iter1Ref);
    expect(delta!.files_changed).toBe(1);
    expect(delta!.lines_added).toBe(3);

    rmSync(dir, { recursive: true });
  });

  test("returns null when refs are invalid", () => {
    const dir = initRepo();
    const result = computeIterationDiff(dir, "bogus1", "bogus2");
    expect(result).toBeNull();
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/diff-stats.test.ts
```

Expected: FAIL. `computeIterationDiff` is not exported.

- [ ] **Step 3: Implement `computeIterationDiff`**

Append to `src/orchestrator/diff-stats.ts`:

```typescript
export interface TaskIterationDiff {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
  diff_summary: string | null;
}

/**
 * Returns the diff between two iteration refs.
 * Unlike computeDiffStats, this is per-iteration-transition, not cumulative.
 * diff_summary is a short (<500 char) text snippet of the diff for reflector context.
 */
export function computeIterationDiff(
  worktreePath: string,
  fromRef: string,
  toRef: string
): TaskIterationDiff | null {
  try {
    const numstat = execSync(`git diff --numstat ${fromRef}..${toRef}`, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const summary = execSync(`git diff --stat ${fromRef}..${toRef}`, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).slice(0, 500);

    let files_changed = 0;
    let lines_added = 0;
    let lines_deleted = 0;
    let test_files_changed = 0;
    const lines = numstat.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const [added, deleted, path] = line.split(/\t+/);
      files_changed += 1;
      if (added !== "-" && deleted !== "-") {
        lines_added += Number(added);
        lines_deleted += Number(deleted);
      }
      if (TEST_FILE_PATTERN.test(path ?? "")) test_files_changed += 1;
    }

    return { files_changed, lines_added, lines_deleted, test_files_changed, diff_summary: summary };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/diff-stats.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add DB helper `insertTaskIterationDiff`**

In `src/db/client.ts`:

```typescript
insertTaskIterationDiff(taskId: string, fromIter: number, toIter: number, stats: {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
  diff_summary: string | null;
}): void {
  this.sqlite.query(`
    INSERT OR REPLACE INTO task_iteration_diffs
      (task_id, from_iteration, to_iteration, files_changed, lines_added, lines_deleted, test_files_changed, diff_summary)
    VALUES
      ($task_id, $from_iter, $to_iter, $files_changed, $lines_added, $lines_deleted, $test_files_changed, $diff_summary)
  `).run({
    $task_id: taskId,
    $from_iter: fromIter,
    $to_iter: toIter,
    $files_changed: stats.files_changed,
    $lines_added: stats.lines_added,
    $lines_deleted: stats.lines_deleted,
    $test_files_changed: stats.test_files_changed,
    $diff_summary: stats.diff_summary
  });
}
```

- [ ] **Step 6: Wire `computeIterationDiff` into the rework loop**

In `src/orchestrator/service.ts`, locate the rework loop. Grep for the iteration counter:

```bash
grep -n "iteration + 1\|task.iteration" src/orchestrator/service.ts
```

There is a rework transition that advances iteration. The engineer will find where an iteration commit completes (the coder's changes are committed before the next review cycle begins). **Immediately before** the transition into the next iteration, add:

```typescript
try {
  const worktree = this.deps.worktrees.get(taskId);
  if (worktree) {
    const fromRef = this.deps.db.getIterationCommitRef(taskId, currentIteration);
    const toRef = this.deps.db.getIterationCommitRef(taskId, currentIteration + 1);
    if (fromRef && toRef) {
      const delta = computeIterationDiff(worktree.path, fromRef, toRef);
      if (delta) {
        this.deps.db.insertTaskIterationDiff(taskId, currentIteration, currentIteration + 1, delta);
      }
    }
  }
} catch (err) {
  console.warn(`[iteration-diff] Skipped for task ${taskId}: ${(err as Error).message}`);
}
```

**Note on ref tracking:** the orchestrator must know the commit ref at the end of each iteration. Two options:
- If the worktree module already records per-iteration commits (check `src/orchestrator/worktrees.ts`), expose them via a `getIterationCommitRef(taskId, iter)` DB helper or a worktree-level helper.
- Otherwise, add a new `task_iteration_refs` lightweight map — *but* this increases scope beyond Spec A. A simpler fallback: at the start of each iteration, tag the current HEAD as `autoforge/iter-<taskId>-<iter>` via `git tag`. Then `computeIterationDiff` uses those tag names as refs.

If the infrastructure is not already there, implement the git-tag fallback inside the orchestrator's iteration transition (tag HEAD before each coder invocation). Keep the change minimal — one `execSync(\`git tag autoforge/iter-${taskId}-${iter}\`, { cwd: worktree.path })` line in the rework loop setup.

- [ ] **Step 7: Run full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/diff-stats.ts src/orchestrator/service.ts src/db/client.ts tests/unit/diff-stats.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): capture per-iteration diffs during rework

Adds computeIterationDiff and insertTaskIterationDiff. The rework loop
tags the worktree HEAD at the start of each iteration; the diff
between consecutive iteration tags is stored in task_iteration_diffs.
This is the supervision signal Spec B's reflector consumes.
EOF
)"
```

---

## Task 8: variant_selected event emission at dispatch

Every time `executor.execute()` is invoked for a task's agent (planner, coder, reviewer, doc), emit a `variant_selected` event with the stub `rationale: 'only_eligible'`. Spec C later replaces the stub with real dispatch logic; Spec A only establishes the emission point and payload shape.

**Files:**
- Modify: `src/orchestrator/service.ts` — emit `variant_selected` before each agent dispatch
- Test: `tests/unit/variant-selected-event.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/variant-selected-event.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "variant-selected-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("variant_selected event payload shape", () => {
  test("an emitted variant_selected event has all required fields", () => {
    const db = freshDb();
    // Seed a task.
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1', 'p1', 'd', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
    ).run();
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES ('e1', 't1', '2026-04-19T00:01:00Z', 'p1', 'orchestrator', 'variant_selected', 'done',
               '{"agent_type":"coder","selected_variant_id":"v1","selected_variant_specialty":null,"eligible_variant_ids":["v1"],"selection_rationale":"only_eligible","shadow_variant_ids":[]}', 600)`
    ).run();

    const row = db.sqlite
      .query(
        `SELECT
           json_extract(payload, '$.agent_type') AS agent_type,
           json_extract(payload, '$.selected_variant_id') AS selected_variant_id,
           json_extract(payload, '$.selection_rationale') AS selection_rationale,
           json_extract(payload, '$.shadow_variant_ids') AS shadow_variant_ids
         FROM events WHERE event_type = 'variant_selected'`
      )
      .get() as {
        agent_type: string;
        selected_variant_id: string;
        selection_rationale: string;
        shadow_variant_ids: string;
      };

    expect(row.agent_type).toBe("coder");
    expect(row.selected_variant_id).toBe("v1");
    expect(row.selection_rationale).toBe("only_eligible");
    expect(JSON.parse(row.shadow_variant_ids)).toEqual([]);
  });
});
```

This test is a schema / payload-shape assertion; it passes as soon as we agree on the payload fields. The behavioral test (service.ts actually emits it) is covered by Step 3 below.

- [ ] **Step 2: Run test to verify it passes**

```bash
bun test tests/unit/variant-selected-event.test.ts
```

Expected: PASS (it only checks that events can be inserted with this shape).

- [ ] **Step 3: Write behavioral test — service emits the event**

Append to `tests/unit/variant-selected-event.test.ts`:

```typescript
import { OrchestratorService } from "../../src/orchestrator/service";

// The orchestrator is complex to instantiate in isolation. For this behavior test,
// inspect the events table after submitting a test task through an integration
// helper already used by the codebase. Look at tests/integration/happy-path.test.ts
// for the setup pattern. The test's single assertion:
//   After a task completes, events of type 'variant_selected' exist with
//   agent_type matching each agent that ran (planner, coder, reviewer, [doc]).

// Implement this test by extending the existing happy-path integration test:
// add the assertion at the end. Do NOT duplicate the entire integration scaffold.
```

Open `tests/integration/happy-path.test.ts`. At the end of the successful-completion test case (after assertions about state and PR creation), add:

```typescript
  const variantEvents = db.sqlite
    .query(
      "SELECT json_extract(payload, '$.agent_type') AS agent_type FROM events WHERE event_type = 'variant_selected' AND task_id = ?"
    )
    .all(taskId) as Array<{ agent_type: string }>;

  const agentTypes = variantEvents.map((e) => e.agent_type);
  expect(agentTypes).toContain("planner");
  expect(agentTypes).toContain("coder");
  expect(agentTypes).toContain("reviewer");
```

Replace `taskId` with the actual variable the existing test uses for the task id (read the file to find it).

- [ ] **Step 4: Run test to verify it fails**

```bash
bun test tests/integration/happy-path.test.ts
```

Expected: FAIL. No `variant_selected` events are being emitted yet.

- [ ] **Step 5: Implement `variant_selected` emission**

Open `src/orchestrator/service.ts`. Add a private helper:

```typescript
private emitVariantSelected(
  taskId: string,
  projectId: string,
  agentType: AgentType,
  variantId: string,
  specialty: string | null = null
): void {
  this.recordEvent({
    taskId,
    projectId,
    agent: "orchestrator",
    type: "variant_selected",
    status: "done",
    payload: {
      agent_type: agentType,
      selected_variant_id: variantId,
      selected_variant_specialty: specialty,
      eligible_variant_ids: [variantId],
      selection_rationale: "only_eligible",
      shadow_variant_ids: [],
      injected_lesson_ids: []  // Spec B will populate this; emit empty array in Spec A
    },
    budgetSeconds: 60
  });
}
```

Find every call to `this.routeExecutor(` — these are the dispatch points. Grep:

```bash
grep -n "routeExecutor\|personas.snapshotId\|skills.snapshotIds" src/orchestrator/service.ts
```

For each agent-type dispatch (planner, coder, reviewer, doc, meta), **immediately after** the persona / skill snapshot IDs are loaded and **before** `executor.execute()`:

```typescript
const plannerPersonaId = this.personas.snapshotId("planner");
const plannerSkillIds = this.skills.snapshotIds("planner");
this.emitVariantSelected(taskId, projectId, "planner", plannerPersonaId);  // NEW
```

Do this for every agent dispatch point. For `meta` agent sessions (in `submitMetaTask`), also emit with `agentType: "meta"`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test
```

Expected: happy-path integration test now passes with the new assertion; all other tests continue to pass.

- [ ] **Step 7: Lint + commit**

```bash
bun run lint
git add src/orchestrator/service.ts tests/unit/variant-selected-event.test.ts tests/integration/happy-path.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): emit variant_selected event at every agent dispatch

Stub rationale='only_eligible' for Spec A. Spec C will replace with
real dispatch policy that populates rationale, eligible_variant_ids,
and shadow_variant_ids meaningfully.
EOF
)"
```

---

## Task 9: Extend failure_analysis payload

Existing `failure_analysis` emission points (in service.ts at `state.failed` transitions, staleness sweep, cancelTask, plan rejection, pauseForIntervention) already capture `stage_failed`, `failure_reason`, `failure_category`, `planner_fallback`, and some context. Spec A requires additionally: `executor_used`, `persona_version_id`, `skill_version_ids`, `tool_stats`.

**Files:**
- Modify: `src/orchestrator/service.ts` — enrich every failure_analysis payload
- Test: `tests/unit/failure-analysis-payload.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/failure-analysis-payload.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "fa-payload-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("failure_analysis payload contract", () => {
  test("payload includes persona_version_id, skill_version_ids, executor_used, tool_stats keys", () => {
    const db = freshDb();
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1', 'p1', 'd', 'failed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
    ).run();

    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES ('e1', 't1', '2026-04-19T00:01:00Z', 'p1', 'orchestrator', 'failure_analysis', 'failed',
               '{"stage_failed":"executing","failure_reason":"x","failure_category":"coder_failed","executor_used":"anthropic-sdk","persona_version_id":"pv1","skill_version_ids":["sv1"],"tool_stats":{"read_count":3,"write_count":1,"bash_count":0,"search_count":2,"iterations":4},"planner_fallback":false,"iteration":0}', 60)`
    ).run();

    const row = db.sqlite
      .query(
        `SELECT
           json_extract(payload, '$.executor_used') AS executor_used,
           json_extract(payload, '$.persona_version_id') AS persona_version_id,
           json_extract(payload, '$.skill_version_ids') AS skill_version_ids,
           json_extract(payload, '$.tool_stats.read_count') AS read_count
         FROM events WHERE event_type = 'failure_analysis'`
      )
      .get() as {
        executor_used: string;
        persona_version_id: string;
        skill_version_ids: string;
        read_count: number;
      };

    expect(row.executor_used).toBe("anthropic-sdk");
    expect(row.persona_version_id).toBe("pv1");
    expect(JSON.parse(row.skill_version_ids)).toEqual(["sv1"]);
    expect(row.read_count).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline assertion — payload shape only)**

```bash
bun test tests/unit/failure-analysis-payload.test.ts
```

Expected: PASS — this test only asserts the payload shape can be stored. The behavioral test (service.ts actually emits this shape) is the next step.

- [ ] **Step 3: Add behavioral assertion in existing rework integration test**

Open `tests/integration/rework-flow.test.ts`. Find a test scenario where a rework loop fails (hits the rework limit, or the coder returns BLOCKED). Inspect the emitted `failure_analysis` event payload and assert that all required keys exist:

```typescript
  const fa = db.sqlite
    .query(
      "SELECT payload FROM events WHERE task_id = ? AND event_type = 'failure_analysis' ORDER BY timestamp DESC LIMIT 1"
    )
    .get(taskId) as { payload: string };
  const parsed = JSON.parse(fa.payload) as Record<string, unknown>;

  expect(parsed.executor_used).toBeDefined();
  expect(parsed.persona_version_id).toBeDefined();
  expect(parsed.skill_version_ids).toBeDefined();
  // tool_stats is present for SDK executor; null for claude-code; key should always exist.
  expect("tool_stats" in parsed).toBe(true);
```

- [ ] **Step 4: Run the integration test — it should fail**

```bash
bun test tests/integration/rework-flow.test.ts
```

Expected: FAIL. Current payloads don't include `executor_used`, `persona_version_id`, `skill_version_ids`, or `tool_stats`.

- [ ] **Step 5: Enrich every failure_analysis emission**

In `src/orchestrator/service.ts`, find every `type: "failure_analysis"` call. There are several (line refs approximate — grep to find them):

```bash
grep -n 'type: "failure_analysis"' src/orchestrator/service.ts
```

For each call, the surrounding context usually has access to:
- `executor.name` (the executor that ran) — available where an executor was used
- `personaVersionId` and `skillVersionIds` — if the failure occurred during or after agent dispatch, these are in scope
- `result.metrics.toolStats` — from the most recent `AgentResult` when applicable

Extend each `payload: { ... }` object to include these:

```typescript
payload: {
  stage_failed: "executing",
  failure_reason: "...",
  failure_category: "coder_failed",
  planner_fallback: false,
  executor_used: executor?.name ?? null,          // NEW
  persona_version_id: personaVersionId ?? null,   // NEW
  skill_version_ids: skillVersionIds ?? [],       // NEW
  tool_stats: result?.metrics.toolStats ?? null,  // NEW
  iteration: task.iteration
}
```

If a specific emission site does not have access to one of these values (e.g., the staleness sweep has no current executor), pass `null` explicitly for that field — the contract is "the key is always present; its value may be null."

For the staleness-sweep emission specifically, the task's **most recent** executor event can provide `executor_used`. Either join from events or accept `executor_used: null` for stale-task failures.

Be methodical: visit each emission site in turn, apply the enrichment, and verify nothing is broken.

- [ ] **Step 6: Run all tests**

```bash
bun test
```

Expected: rework-flow behavioral test now passes; all other tests continue to pass.

- [ ] **Step 7: Lint + commit**

```bash
bun run lint
git add src/orchestrator/service.ts tests/unit/failure-analysis-payload.test.ts tests/integration/rework-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): enrich failure_analysis payload with variant provenance

Every failure_analysis event now carries executor_used,
persona_version_id, skill_version_ids, and tool_stats. Missing values
are null rather than absent. Enables per-variant failure attribution
for the curator meta (Spec B).
EOF
)"
```

---

## Task 10: Reward config file and loader

The composite reward is computed in application code from the five per-task components emitted by `task_quality_score` (Task 11). Weights live in a JSON file and are validated at startup.

**Files:**
- Create: `src/config/reward-weights.json`
- Create: `src/config/reward.ts`
- Test: `tests/unit/reward-config.test.ts`
- Modify: `src/index.ts` — call the validator at startup

- [ ] **Step 1: Create the config file**

`src/config/reward-weights.json`:

```json
{
  "version": 1,
  "weights": {
    "correctness": 0.2,
    "simplicity": 0.2,
    "alignment": 0.2,
    "fidelity": 0.2,
    "efficiency": 0.2
  }
}
```

- [ ] **Step 2: Write failing test**

Create `tests/unit/reward-config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { getRewardWeights, computeComposite, validateRewardWeights } from "../../src/config/reward";

describe("reward config", () => {
  test("getRewardWeights loads the default config", () => {
    const w = getRewardWeights();
    expect(w.correctness).toBe(0.2);
    expect(w.simplicity).toBe(0.2);
    expect(w.alignment).toBe(0.2);
    expect(w.fidelity).toBe(0.2);
    expect(w.efficiency).toBe(0.2);
  });

  test("computeComposite applies weights correctly", () => {
    const composite = computeComposite({
      r_correctness: 1.0,
      r_simplicity: 0.5,
      r_alignment: 0.8,
      r_fidelity: 1.0,
      r_efficiency: 0.6
    });
    // All weights 0.2: (1.0 + 0.5 + 0.8 + 1.0 + 0.6) * 0.2 = 3.9 * 0.2 = 0.78
    expect(composite).toBeCloseTo(0.78, 5);
  });

  test("validateRewardWeights throws when weights do not sum to 1.0", () => {
    expect(() =>
      validateRewardWeights({
        correctness: 0.3,
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2,
        efficiency: 0.2
      })
    ).toThrow(/sum/);
  });

  test("validateRewardWeights throws on missing key", () => {
    expect(() =>
      validateRewardWeights({
        correctness: 0.2,
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2
      } as never)
    ).toThrow(/missing|efficiency/i);
  });

  test("validateRewardWeights throws on negative value", () => {
    expect(() =>
      validateRewardWeights({
        correctness: -0.1,
        simplicity: 0.3,
        alignment: 0.3,
        fidelity: 0.3,
        efficiency: 0.2
      })
    ).toThrow(/negative/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/unit/reward-config.test.ts
```

Expected: FAIL. Module doesn't exist.

- [ ] **Step 4: Implement `src/config/reward.ts`**

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RewardTerm =
  | "correctness"
  | "simplicity"
  | "alignment"
  | "fidelity"
  | "efficiency";

export type RewardWeights = Record<RewardTerm, number>;

export interface RewardComponents {
  r_correctness: number;
  r_simplicity: number;
  r_alignment: number;
  r_fidelity: number;
  r_efficiency: number;
}

const ALL_TERMS: RewardTerm[] = [
  "correctness",
  "simplicity",
  "alignment",
  "fidelity",
  "efficiency"
];

let cached: RewardWeights | null = null;

export function getRewardWeights(configPath?: string): RewardWeights {
  if (cached && !configPath) return cached;
  const path = configPath ?? resolve(process.cwd(), "src/config/reward-weights.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { version: number; weights: RewardWeights };
  validateRewardWeights(parsed.weights);
  if (!configPath) cached = parsed.weights;
  return parsed.weights;
}

export function validateRewardWeights(weights: RewardWeights): void {
  for (const term of ALL_TERMS) {
    if (!(term in weights)) {
      throw new Error(`Reward weights missing key: ${term}`);
    }
    if (weights[term] < 0) {
      throw new Error(`Reward weight for ${term} is negative: ${weights[term]}`);
    }
  }
  const sum = ALL_TERMS.reduce((acc, t) => acc + weights[t], 0);
  if (Math.abs(sum - 1.0) > 1e-6) {
    throw new Error(`Reward weights sum to ${sum}, expected 1.0 (±1e-6)`);
  }
}

export function computeComposite(components: RewardComponents, weights?: RewardWeights): number {
  const w = weights ?? getRewardWeights();
  return (
    w.correctness * components.r_correctness +
    w.simplicity * components.r_simplicity +
    w.alignment * components.r_alignment +
    w.fidelity * components.r_fidelity +
    w.efficiency * components.r_efficiency
  );
}

export function resetRewardWeightsCache(): void {
  // For tests that want to reload from disk.
  cached = null;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/unit/reward-config.test.ts
```

Expected: PASS (five tests).

- [ ] **Step 6: Wire the validator into startup**

Open `src/index.ts`. Near the top, after imports but before the orchestrator is instantiated:

```typescript
import { getRewardWeights } from "./config/reward";

// Validate reward weights at startup — throws if malformed.
getRewardWeights();
```

- [ ] **Step 7: Run the full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/config/reward.ts src/config/reward-weights.json src/index.ts tests/unit/reward-config.test.ts
git commit -m "feat(config): reward weights loader with startup validation (Spec A §6.2)"
```

---

## Task 11: Reward views

Migration 005 creates `task_quality_score` (per-task, five components), `variant_performance` (per-variant aggregates), `niche_performance` (per-variant × tier/project/category), and `population_health` (per-agent-type rollup).

**Files:**
- Create: `src/db/migrations/005_reward_views.sql`
- Test: `tests/unit/reward-views.test.ts`

- [ ] **Step 1: Write failing test for `task_quality_score`**

Create `tests/unit/reward-views.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "reward-views-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedTerminalTask(db: DbClient, opts: {
  taskId: string;
  state: "completed" | "failed";
  tier: string;
  iteration: number;
  findingCount?: number;
  blockingFindingCount?: number;
  diffLines?: number;
  totalCost?: number;
  plannerFallback?: boolean;
}): void {
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?, 'p', 'd', ?, ?, '{}', '[]', ?, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
  ).run(opts.taskId, opts.state, opts.tier, opts.iteration);

  if (opts.totalCost !== undefined) {
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, estimated_cost)
       VALUES (?, ?, '2026-04-19T00:01:00Z', 'p', 'coder', 'subtask_done', 'done', '{}', 600, ?)`
    ).run(randomUUID(), opts.taskId, opts.totalCost);
  }

  for (let i = 0; i < (opts.findingCount ?? 0); i++) {
    const isBlocking = i < (opts.blockingFindingCount ?? 0);
    db.sqlite.query(
      `INSERT INTO review_findings (id, task_id, severity, category, description)
       VALUES (?, ?, ?, 'x', 'y')`
    ).run(randomUUID(), opts.taskId, isBlocking ? "CRITICAL" : "MINOR");
  }

  if (opts.diffLines !== undefined) {
    db.insertTaskDiffStats(opts.taskId, {
      files_changed: 1, files_added: 1, files_modified: 0, files_deleted: 0,
      lines_added: opts.diffLines, lines_deleted: 0, test_files_changed: 0
    });
  }

  if (opts.plannerFallback) {
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES (?, ?, '2026-04-19T00:02:00Z', 'p', 'orchestrator', 'failure_analysis', 'failed',
               '{"planner_fallback":true}', 60)`
    ).run(randomUUID(), opts.taskId);
  }
}

describe("task_quality_score view", () => {
  test("a clean completed EXPRESS task scores max on correctness, efficiency", () => {
    const db = freshDb();
    seedTerminalTask(db, {
      taskId: "t1", state: "completed", tier: "EXPRESS", iteration: 0,
      findingCount: 0, diffLines: 10, totalCost: 0.01
    });

    const row = db.sqlite
      .query("SELECT * FROM task_quality_score WHERE task_id = 't1'")
      .get() as {
        r_correctness: number; r_simplicity: number; r_alignment: number;
        r_fidelity: number; r_efficiency: number;
      };

    expect(row.r_correctness).toBeCloseTo(1.0);
    // simplicity: 1 / (1 + 10/50) = 1/1.2 ≈ 0.833
    expect(row.r_simplicity).toBeCloseTo(0.833, 2);
    expect(row.r_alignment).toBeCloseTo(1.0); // no findings
    expect(row.r_fidelity).toBeCloseTo(1.0); // no planner fallback, no scope drift
    expect(row.r_efficiency).toBeGreaterThan(0.5);
  });

  test("missing task_diff_stats row ⇒ r_simplicity = 0.5 (neutral)", () => {
    const db = freshDb();
    seedTerminalTask(db, {
      taskId: "t2", state: "completed", tier: "STANDARD", iteration: 0,
      findingCount: 0  // no diffLines ⇒ no task_diff_stats row
    });

    const row = db.sqlite
      .query("SELECT r_simplicity FROM task_quality_score WHERE task_id = 't2'")
      .get() as { r_simplicity: number };
    expect(row.r_simplicity).toBeCloseTo(0.5);
  });

  test("blocking finding ⇒ r_correctness = 0 and r_alignment < 1", () => {
    const db = freshDb();
    seedTerminalTask(db, {
      taskId: "t3", state: "completed", tier: "STANDARD", iteration: 0,
      findingCount: 2, blockingFindingCount: 1, diffLines: 50, totalCost: 0.05
    });

    const row = db.sqlite
      .query("SELECT r_correctness, r_alignment FROM task_quality_score WHERE task_id = 't3'")
      .get() as { r_correctness: number; r_alignment: number };
    expect(row.r_correctness).toBe(0);
    expect(row.r_alignment).toBeCloseTo(0.5); // 1 - (1/2)
  });

  test("planner_fallback ⇒ r_fidelity decreases", () => {
    const db = freshDb();
    seedTerminalTask(db, {
      taskId: "t4", state: "failed", tier: "STANDARD", iteration: 0,
      plannerFallback: true, diffLines: 30, totalCost: 0.03
    });

    const row = db.sqlite
      .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't4'")
      .get() as { r_fidelity: number };
    expect(row.r_fidelity).toBeCloseTo(0.5); // (0.5 * 0) + (0.5 * 1) = 0.5
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/reward-views.test.ts
```

Expected: FAIL. View doesn't exist.

- [ ] **Step 3: Create migration 005 — start with `task_quality_score`**

Create `src/db/migrations/005_reward_views.sql`:

```sql
-- 005: Reward views — task_quality_score (per task), variant_performance (per variant),
-- niche_performance (per variant × dimension), population_health (per agent type).
-- View contracts per Spec A §6.

DROP VIEW IF EXISTS task_quality_score;

CREATE VIEW task_quality_score AS
SELECT
  t.id          AS task_id,
  t.project_id,
  t.tier,

  -- correctness: 1 if completed with no blocking findings, else 0
  CASE
    WHEN t.state = 'completed'
         AND COALESCE(o.blocking_finding_count, 0) = 0
    THEN 1.0 ELSE 0.0
  END AS r_correctness,

  -- simplicity: 1 / (1 + lines_changed / tier_baseline); 0.5 if stats missing
  CASE
    WHEN d.task_id IS NULL THEN 0.5
    ELSE 1.0 / (1.0 +
      (CAST(d.lines_added + d.lines_deleted AS REAL) /
        CASE t.tier
          WHEN 'EXPRESS'  THEN 50.0
          WHEN 'STANDARD' THEN 200.0
          WHEN 'THOROUGH' THEN 800.0
          ELSE 200.0
        END))
  END AS r_simplicity,

  -- alignment: 1 - (critical_findings / max(total_findings, 1))
  CASE
    WHEN COALESCE(o.finding_count, 0) = 0 THEN 1.0
    ELSE 1.0 - (CAST(o.blocking_finding_count AS REAL) / CAST(o.finding_count AS REAL))
  END AS r_alignment,

  -- fidelity: 0.5 * (1 - planner_fallback) + 0.5 * (1 - scope_drift)
  -- planner_fallback from failure_analysis events; scope_drift from subtask counts
  0.5 * (1.0 - COALESCE(fa.planner_fallback, 0))
    + 0.5 * (1.0 - COALESCE(sd.scope_drift, 0.0)) AS r_fidelity,

  -- efficiency: 0.5 * cost term + 0.5 * iteration term
  0.5 * (1.0 / (1.0 +
    COALESCE(o.total_cost, 0.0) /
      CASE t.tier
        WHEN 'EXPRESS'  THEN 0.50
        WHEN 'STANDARD' THEN 2.00
        WHEN 'THOROUGH' THEN 8.00
        ELSE 2.00
      END))
  + 0.5 * (1.0 / (1.0 + t.iteration)) AS r_efficiency,

  t.created_at
FROM tasks t
LEFT JOIN task_outcomes o ON o.task_id = t.id
LEFT JOIN task_diff_stats d ON d.task_id = t.id
LEFT JOIN (
  SELECT task_id,
         MAX(CAST(json_extract(payload, '$.planner_fallback') AS INTEGER)) AS planner_fallback
    FROM events
   WHERE event_type = 'failure_analysis'
   GROUP BY task_id
) fa ON fa.task_id = t.id
LEFT JOIN (
  SELECT t2.id AS task_id,
         CASE
           WHEN (SELECT COUNT(*) FROM subtasks WHERE task_id = t2.id) >
                1.3 * COALESCE(
                  NULLIF(CAST(json_extract(t2.plan, '$.subtask_count') AS REAL), 0),
                  0.0
                )
           THEN 1.0 ELSE 0.0
         END AS scope_drift
    FROM tasks t2
) sd ON sd.task_id = t.id
WHERE t.state IN ('completed', 'failed');
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/reward-views.test.ts
```

Expected: PASS (four tests). If any fail, re-examine the SQL view logic against the test's seed data.

- [ ] **Step 5: Add `variant_performance`**

Append to `src/db/migrations/005_reward_views.sql`:

```sql
DROP VIEW IF EXISTS variant_performance;

CREATE VIEW variant_performance AS
SELECT
  vs.variant_id,
  sv.skill_name    AS variant_name,
  sv.specialty,
  sv.status,
  vs.agent_type,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity)  AS avg_simplicity,
  AVG(tqs.r_alignment)   AS avg_alignment,
  AVG(tqs.r_fidelity)    AS avg_fidelity,
  AVG(tqs.r_efficiency)  AS avg_efficiency
FROM (
  SELECT task_id,
         json_extract(payload, '$.selected_variant_id') AS variant_id,
         json_extract(payload, '$.agent_type')          AS agent_type
    FROM events
   WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN skill_versions sv ON sv.id = vs.variant_id
GROUP BY vs.variant_id, vs.agent_type;
```

Write a companion test in `tests/unit/reward-views.test.ts`:

```typescript
describe("variant_performance view", () => {
  test("returns per-variant aggregates", () => {
    const db = freshDb();
    // Seed a baseline coder variant.
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vCoder', 'persona:coder', '1', 'c', 'baseline', 1.0)`
    ).run();

    // Seed two tasks attributed to vCoder via variant_selected events.
    for (const tid of ["qa1", "qa2"]) {
      seedTerminalTask(db, {
        taskId: tid, state: "completed", tier: "STANDARD", iteration: 0,
        findingCount: 0, diffLines: 30, totalCost: 0.05
      });
      db.sqlite.query(
        `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
         VALUES (?, ?, '2026-04-19T00:03:00Z', 'p', 'orchestrator', 'variant_selected', 'done',
                 '{"agent_type":"coder","selected_variant_id":"vCoder","selection_rationale":"only_eligible","shadow_variant_ids":[]}', 60)`
      ).run(randomUUID(), tid);
    }

    const row = db.sqlite
      .query("SELECT task_count, avg_correctness FROM variant_performance WHERE variant_id = 'vCoder'")
      .get() as { task_count: number; avg_correctness: number };
    expect(row.task_count).toBe(2);
    expect(row.avg_correctness).toBeCloseTo(1.0);
  });
});
```

Run: `bun test tests/unit/reward-views.test.ts`. Expected: PASS.

- [ ] **Step 6: Add `niche_performance` view**

Append to `src/db/migrations/005_reward_views.sql`. This is three UNION'd sub-queries (one per dimension: tier, project, finding-category).

```sql
DROP VIEW IF EXISTS niche_performance;

CREATE VIEW niche_performance AS
-- By tier
SELECT
  vs.variant_id,
  vs.agent_type,
  'tier' AS dimension,
  t.tier AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity)  AS avg_simplicity,
  AVG(tqs.r_alignment)   AS avg_alignment,
  AVG(tqs.r_fidelity)    AS avg_fidelity,
  AVG(tqs.r_efficiency)  AS avg_efficiency
FROM (
  SELECT task_id,
         json_extract(payload, '$.selected_variant_id') AS variant_id,
         json_extract(payload, '$.agent_type')          AS agent_type
    FROM events WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN tasks t ON t.id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, t.tier

UNION ALL

-- By project
SELECT
  vs.variant_id,
  vs.agent_type,
  'project' AS dimension,
  t.project_id AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity)  AS avg_simplicity,
  AVG(tqs.r_alignment)   AS avg_alignment,
  AVG(tqs.r_fidelity)    AS avg_fidelity,
  AVG(tqs.r_efficiency)  AS avg_efficiency
FROM (
  SELECT task_id,
         json_extract(payload, '$.selected_variant_id') AS variant_id,
         json_extract(payload, '$.agent_type')          AS agent_type
    FROM events WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN tasks t ON t.id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, t.project_id

UNION ALL

-- By finding-category (free-text; one row per distinct finding category that appeared on any task this variant handled)
SELECT
  vs.variant_id,
  vs.agent_type,
  'finding_category' AS dimension,
  rf.category AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity)  AS avg_simplicity,
  AVG(tqs.r_alignment)   AS avg_alignment,
  AVG(tqs.r_fidelity)    AS avg_fidelity,
  AVG(tqs.r_efficiency)  AS avg_efficiency
FROM (
  SELECT task_id,
         json_extract(payload, '$.selected_variant_id') AS variant_id,
         json_extract(payload, '$.agent_type')          AS agent_type
    FROM events WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN review_findings rf ON rf.task_id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, rf.category;
```

Write a minimal test — the dimensions are correctly distinguishable:

```typescript
describe("niche_performance view", () => {
  test("returns rows grouped by dimension", () => {
    const db = freshDb();
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vCoderNich', 'persona:coder', '1', 'c', 'baseline', 1.0)`
    ).run();
    seedTerminalTask(db, {
      taskId: "n1", state: "completed", tier: "EXPRESS", iteration: 0,
      findingCount: 1, diffLines: 20, totalCost: 0.01
    });
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES (?, 'n1', '2026-04-19T00:04:00Z', 'p', 'orchestrator', 'variant_selected', 'done',
               '{"agent_type":"coder","selected_variant_id":"vCoderNich","selection_rationale":"only_eligible","shadow_variant_ids":[]}', 60)`
    ).run(randomUUID());

    const rows = db.sqlite
      .query("SELECT DISTINCT dimension FROM niche_performance WHERE variant_id = 'vCoderNich'")
      .all() as Array<{ dimension: string }>;
    const dims = rows.map((r) => r.dimension).sort();
    expect(dims).toEqual(["finding_category", "project", "tier"]);
  });
});
```

Run: `bun test tests/unit/reward-views.test.ts`. Expected: PASS.

- [ ] **Step 7: Add `population_health` view**

Append to `src/db/migrations/005_reward_views.sql`:

```sql
DROP VIEW IF EXISTS population_health;

CREATE VIEW population_health AS
SELECT
  vs.agent_type,
  COUNT(DISTINCT CASE WHEN sv.status IN ('baseline', 'active') THEN sv.id END) AS active_variant_count,
  COUNT(DISTINCT CASE WHEN sv.status = 'candidate' THEN sv.id END)             AS candidate_variant_count,
  COUNT(DISTINCT CASE WHEN sv.status = 'retired' THEN sv.id END)               AS retired_variant_count,
  SUM(CASE WHEN sv.status IN ('baseline', 'active') THEN sv.traffic_share ELSE 0 END) AS total_allocated_share,
  AVG(vp.avg_correctness) AS ensemble_avg_correctness,
  AVG(vp.avg_simplicity)  AS ensemble_avg_simplicity,
  AVG(vp.avg_alignment)   AS ensemble_avg_alignment,
  AVG(vp.avg_fidelity)    AS ensemble_avg_fidelity,
  AVG(vp.avg_efficiency)  AS ensemble_avg_efficiency
FROM (
  SELECT DISTINCT json_extract(payload, '$.agent_type') AS agent_type
    FROM events WHERE event_type = 'variant_selected'
) vs
LEFT JOIN skill_versions sv ON sv.skill_name = 'persona:' || vs.agent_type
LEFT JOIN variant_performance vp ON vp.agent_type = vs.agent_type AND vp.variant_id = sv.id
GROUP BY vs.agent_type;
```

Write a minimal test:

```typescript
describe("population_health view", () => {
  test("returns a row per agent type with variant counts", () => {
    const db = freshDb();
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vBase', 'persona:coder', '1', 'c', 'baseline', 1.0)`
    ).run();
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vCand', 'persona:coder', '2', 'c2', 'candidate', 0.0)`
    ).run();
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES ('eh1', 'dummy', '2026-04-19T00:05:00Z', 'p', 'orchestrator', 'variant_selected', 'done',
               '{"agent_type":"coder","selected_variant_id":"vBase","selection_rationale":"only_eligible","shadow_variant_ids":[]}', 60)`
    ).run();

    const row = db.sqlite
      .query("SELECT active_variant_count, candidate_variant_count FROM population_health WHERE agent_type = 'coder'")
      .get() as { active_variant_count: number; candidate_variant_count: number };
    expect(row.active_variant_count).toBe(1);
    expect(row.candidate_variant_count).toBe(1);
  });
});
```

Run: `bun test tests/unit/reward-views.test.ts`. Expected: PASS.

- [ ] **Step 8: Verify `agent_performance` view still returns identical rows (compatibility test)**

Spec A §11 success criterion #6: the pre-existing `agent_performance` view must continue to work. Add one more test:

```typescript
describe("agent_performance (existing view) unchanged", () => {
  test("view still returns rows after all migrations", () => {
    const db = freshDb();
    // Seed a persona_version_id event so agent_performance has data.
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vAP', 'persona:coder', '1', 'c', 'baseline', 1.0)`
    ).run();
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('tAP', 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
    ).run();
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, estimated_cost)
       VALUES ('eAP', 'tAP', '2026-04-19T00:01:00Z', 'p', 'coder', 'subtask_done', 'done',
               '{"persona_version_id":"vAP"}', 600, 0.02)`
    ).run();

    const rows = db.sqlite
      .query("SELECT * FROM agent_performance WHERE persona_version_id = 'vAP'")
      .all();
    expect(rows).toHaveLength(1);
  });
});
```

Run: `bun test tests/unit/reward-views.test.ts`. Expected: PASS.

- [ ] **Step 9: Run the full suite + lint**

```bash
bun test
bun run lint
```

Expected: everything passes — all Spec A tests plus every pre-existing test.

- [ ] **Step 10: Commit**

```bash
git add src/db/migrations/005_reward_views.sql tests/unit/reward-views.test.ts
git commit -m "$(cat <<'EOF'
feat(db): reward views — task_quality_score, variant_performance, niche_performance, population_health

task_quality_score emits five normalized components per terminal
task (correctness, simplicity, alignment, fidelity, efficiency).
Composite score is computed in application code via
src/config/reward.computeComposite() with weights from
reward-weights.json. variant_performance and niche_performance
aggregate across variant and dimension. population_health rolls up
per-agent-type population statistics.
EOF
)"
```

---

## Final verification

After all tasks complete, run the full verification pass.

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: every test passes, including all Spec A new tests and every pre-existing test.

- [ ] **Step 2: Lint**

```bash
bun run lint
```

Expected: zero new errors.

- [ ] **Step 3: Manual sanity query against a freshly-initialized DB**

```bash
bun run dev &
SERVER_PID=$!
sleep 3
kill $SERVER_PID 2>/dev/null
ls data/*.sqlite 2>/dev/null | head -1 | xargs -I {} sqlite3 {} ".schema skill_versions"
```

Expected output: the `skill_versions` table has columns `id, skill_name, version, content, experiment_id, created_at, is_active, parent_version_id, specialty, status, traffic_share`.

- [ ] **Step 4: Verify `schema_migrations` is populated**

```bash
sqlite3 data/<the-file>.sqlite "SELECT migration_file, applied_at FROM schema_migrations ORDER BY applied_at"
```

Expected: five rows, in the order `001_population_schema.sql`, `002_task_diff_stats.sql`, `003_transcripts_variant.sql`, `004_experiments_evidence.sql`, `005_reward_views.sql`.

- [ ] **Step 5: Final commit — update plan status**

No code change needed. This plan is now executed; open the spec and this plan doc for the next person, and mark the umbrella's spec status.

```bash
git log --oneline -n 12
```

Expected: a clean chain of ~11 commits from this plan.

---

## Plan self-review

After every task is complete, re-read [Spec A](../specs/2026-04-19-observability-and-reward-foundation-design.md) with fresh eyes and confirm:

1. **§3 Migrations mechanism** — implemented in Task 1.
2. **§4.1 skill_versions columns + triggers** — Task 2.
3. **§4.2 experiments columns** — Task 3.
4. **§4.3 agent_transcripts column** — Task 4.
5. **§4.4 task_diff_stats + task_iteration_diffs** — Task 5 (schema) + Task 6 (cumulative capture) + Task 7 (per-iteration capture).
6. **§4.5 schema_migrations** — Task 1.
7. **§4.6 is_active triggers** — Task 2.
8. **§5.1 failure_analysis payload enrichment** — Task 9.
9. **§5.2 variant_selected event** — Task 8.
10. **§5.3 finding categories (deferred to Spec B)** — no action needed.
11. **§6 Reward function** — views in Task 11, config in Task 10.
12. **§7 Capture points** — all touched files are in tasks above.
13. **§8 Implementation sequence** — this plan's task order matches the spec's sequence.
14. **§9 Testing strategy** — every item in the spec's testing strategy has a corresponding test in the plan.
15. **§10 Risks** — mitigations (null-safety on missing rows, per-migration transactions, COALESCE fallbacks) are implemented.
16. **§11 Success criteria** — every criterion has a test that enforces it.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-observability-and-reward-foundation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Requires the `superpowers:subagent-driven-development` sub-skill.

2. **Inline Execution** — Execute tasks in the current session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
