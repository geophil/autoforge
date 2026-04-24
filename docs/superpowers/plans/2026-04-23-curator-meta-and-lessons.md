# Autoforge Spec B — Curator Meta and Lessons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Layers 3 (curation) and 5 (memory & lineage) of the self-improving-persona-population umbrella — a `lessons` table with lineage-rooted retrieval, a synchronous reflector sub-agent that writes lessons after every terminal task, dispatch-time lesson injection into system prompts, and a rewritten curator meta persona that emits structured `edit | fork | merge | promote | demote | retire` operations validated against a schema.

**Architecture:** Additive. New `lessons` table + helpers (migration 007), new `proposed_content` column on `experiments` (migration 008), new `src/personas/reflector.md`, new `src/orchestrator/reflection.ts` and `src/orchestrator/lessons.ts` modules, new `src/orchestrator/meta-operations.ts` operation handlers, new `src/schemas/meta-output.ts` Zod validator, new `POST /api/experiments/:id/approve-fork` route. Existing `buildSystemPrompt` / `buildPrompt` get a single new injection block between persona and `# Skills`. `submitMetaTask` is rewritten from a single-blob parser into a schema-validated operation dispatcher; the `edit` path no longer auto-activates — variants land as `status='candidate'`, `traffic_share=0.0` (Spec C will route real traffic).

**Tech Stack:** TypeScript, Bun runtime, `bun:sqlite`, existing event-sourced orchestrator, Zod validators (consistent with `src/web/routes/*`, `src/nats/messages.ts`, `src/config/env.ts`). No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-04-19-curator-meta-and-lessons-design.md`](../specs/2026-04-19-curator-meta-and-lessons-design.md). Umbrella: [`docs/superpowers/specs/2026-04-19-self-improving-persona-population-design.md`](../specs/2026-04-19-self-improving-persona-population-design.md). Depends on: [Spec A](../specs/2026-04-19-observability-and-reward-foundation-design.md) (landed in commits `f11b4af` and `fc1bd2c`).

**One deliberate deviation from the spec text:** Spec B §8 lists `src/schemas/meta-output.schema.json`. The rest of the codebase uses Zod (see `src/web/routes/meta.ts:9`, `src/nats/messages.ts:10-22`, `src/config/env.ts`) and the spec's intent is "structured validation of the meta output," not a specific library. This plan implements the validator as a Zod schema at `src/schemas/meta-output.ts`; the file name is adjusted. The validation guarantees are identical. No separate `.schema.json` artifact is written — if one is ever needed for downstream tooling we can generate it from Zod via `zod-to-json-schema` in a follow-up.

**Migration numbering note:** Spec A review follow-ups have landed as `006_fix_reward_views_planner_fallback.sql` (tightens the planner_fallback subquery in `task_quality_score`). Spec B's migrations therefore shift by one: the lessons table is **`007_lessons.sql`** and `experiments.proposed_content` is **`008_experiments_proposed_content.sql`**. Spec B §3.4's "007" becomes "008" in this plan. The migrations runner executes files in filename order (`localeCompare`), so 007 runs before 008 as intended.

---

## File Structure

**New files (create):**

```
src/db/migrations/
  007_lessons.sql
  008_experiments_proposed_content.sql
src/personas/
  reflector.md                          # reflector persona (system prompt)
  meta.md                               # rewritten — replaces existing file
src/orchestrator/
  reflection.ts                         # reflectOnTask() + reflector dispatch
  lessons.ts                            # retrieveLessonsForDispatch() + keyword extraction + lineage root resolution
  meta-operations.ts                    # handlers for edit | fork | merge | promote | demote | retire
src/schemas/
  meta-output.ts                        # Zod schema for the meta .autoforge-status.json operation object
src/web/routes/
  experiments.ts                        # POST /api/experiments/:id/approve-fork
src/config/
  reflection.ts                         # budget, caps, skip policy
tests/unit/
  lessons-schema.test.ts                # migration 007 + column/index shape
  lessons-helpers.test.ts               # insertLesson, retrieveActiveLessonsByLineage, resolveLineageRoot
  lesson-retrieval.test.ts              # retrieveLessonsForDispatch ranking + token budget
  lesson-prompt-injection.test.ts       # buildSystemPrompt / buildPrompt include lesson section
  meta-output-schema.test.ts            # Zod schema accept/reject matrix
  meta-operations.test.ts               # operation handlers (edit/promote/demote/retire/fork-stub/merge-stub)
  experiments-proposed-content-schema.test.ts  # migration 008 column shape
  approve-fork-route.test.ts            # POST /api/experiments/:id/approve-fork
tests/integration/
  reflection-flow.test.ts               # end-to-end: submit task -> complete -> lesson inserted, or skip logged
  curator-meta-flow.test.ts             # end-to-end: submit meta -> validated operation -> experiment + candidate (for edit)
  lesson-injection-dispatch.test.ts     # task dispatch pulls lessons and records injected_lesson_ids
```

**Modified files:**

```
src/types/core.ts                       # AgentType gains "reflector"
src/skills/registry.ts                  # AGENT_SKILLS["reflector"] entry
src/personas/registry.ts                # (no change expected — resolves by agent name; confirm)
src/executors/interface.ts              # AgentTask gains optional lessons?: string
src/executors/anthropic-sdk.ts          # buildSystemPrompt injects lessons section between persona and # Skills
src/executors/claude-code.ts            # buildPrompt injects lessons section between persona and # Skills
src/orchestrator/service.ts             # emitVariantSelected accepts injected_lesson_ids; reflectOnTask wiring on
                                        # state.completed / state.failed / cancelTask; submitMetaTask rewritten to
                                        # validate meta output and dispatch to meta-operations handlers; routeExecutor
                                        # gains a case for "reflector" (SDK primary, Claude Code fallback)
src/db/client.ts                        # insertLesson, retrieveActiveLessonsByLineage, resolveLineageRoot,
                                        # supersedeLessons, retireLessons, updateTrafficShare, insertMetaOperationExperiment
src/web/server.ts                       # mount experiments route
src/web/routes/meta.ts                  # response shape updated for validation failures (meta_rejected)
```

Each task below produces a self-contained change that compiles, tests pass, and can be committed independently.

---

## Conventions used in this plan

- **Tests use Bun's built-in runner** (`bun test`). Files live under `tests/unit/` or `tests/integration/`, imports from `bun:test`.
- **DB tests** create a fresh SQLite file in `tmpdir()` (see `tests/unit/archived-tasks.test.ts`, `tests/helpers/create-service.ts`).
- **Integration tests** use the `createTestService` helper (`tests/helpers/create-service.ts`) for full orchestrator wiring.
- **Migration files** run inside a single transaction each; a failed migration does not record itself in `schema_migrations` and is retried on next startup (confirmed by Spec A §3).
- **Commit messages** follow Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`). Use HEREDOC syntax when the message has multiple lines.
- **Run the full suite** (`bun test`) before every commit to catch regressions.
- **Lint**: `bun run lint` runs `tsc --noEmit`. Run after any `.ts` change; fix new errors before commit.
- **Zod usage:** `import { z } from "zod"` per existing pattern (`src/web/routes/tasks.ts:4`). Call `.parse` or `.safeParse` — prefer `.safeParse` in the meta path so validation failures become logged events, not thrown errors.

---

## Task 1: `lessons` table and DB helpers

Create migration 007, the `DbClient` helpers Spec B needs (`insertLesson`, `retrieveActiveLessonsByLineage`, `resolveLineageRoot`, `supersedeLessons`, `retireLessons`), and comprehensive unit tests. No orchestrator wiring yet — that arrives in Task 3.

**Files:**
- Create: `src/db/migrations/007_lessons.sql`
- Modify: `src/db/client.ts` — add helpers
- Create: `tests/unit/lessons-schema.test.ts`
- Create: `tests/unit/lessons-helpers.test.ts`

- [ ] **Step 1: Write failing schema test**

Create `tests/unit/lessons-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lessons-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("lessons table schema", () => {
  test("lessons table exists with required columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(lessons)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id", "agent_type", "lineage_root_id", "source_task_id", "source_variant_id",
        "trigger_pattern", "failure_category", "finding_categories", "body",
        "outcome_kind", "retrieval_keywords", "status", "superseded_by",
        "created_at", "retired_at"
      ])
    );
    const status = cols.find((c) => c.name === "status");
    expect(status?.notnull).toBe(1);
    expect(status?.dflt_value).toContain("active");
  });

  test("lineage + status index exists", () => {
    const db = freshDb();
    const idx = db.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lessons'")
      .all() as Array<{ name: string }>;
    const names = idx.map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining(["idx_lessons_lineage_active", "idx_lessons_keywords"])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/lessons-schema.test.ts
```

Expected: FAIL. Table doesn't exist.

- [ ] **Step 3: Create migration 007**

Create `src/db/migrations/007_lessons.sql`:

```sql
-- 007: Lessons table — per-lineage memory of corrective/reinforcing patterns.
-- Inserted by the reflector sub-agent after every terminal task state.
-- Retrieved at dispatch and injected into the selected variant's system prompt.

CREATE TABLE IF NOT EXISTS lessons (
  id                 TEXT PRIMARY KEY,
  agent_type         TEXT NOT NULL,
  lineage_root_id    TEXT NOT NULL REFERENCES skill_versions(id),
  source_task_id     TEXT NOT NULL REFERENCES tasks(id),
  source_variant_id  TEXT NOT NULL REFERENCES skill_versions(id),
  trigger_pattern    TEXT NOT NULL,
  failure_category   TEXT,
  finding_categories TEXT,               -- JSON array; nullable
  body               TEXT NOT NULL,      -- ≤ 200 words, TRIGGER/OBSERVATION/PRINCIPLE/EVIDENCE format
  outcome_kind       TEXT NOT NULL CHECK (outcome_kind IN ('corrective', 'reinforcing')),
  retrieval_keywords TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'retired')),
  superseded_by      TEXT REFERENCES lessons(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_lessons_lineage_active
  ON lessons(lineage_root_id, agent_type, status);

CREATE INDEX IF NOT EXISTS idx_lessons_keywords
  ON lessons(retrieval_keywords);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/lessons-schema.test.ts
```

Expected: PASS (two tests).

- [ ] **Step 5: Write failing tests for the DB helpers**

Create `tests/unit/lessons-helpers.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lessons-helpers-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedVariant(
  db: DbClient,
  id: string,
  skillName: string,
  parentId: string | null = null,
  status = "baseline"
): void {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, parent_version_id, status, traffic_share)
     VALUES (?, ?, '1', 'c', ?, ?, ?)`
  ).run(id, skillName, parentId, status, status === "baseline" ? 1.0 : 0.0);
}

function seedTask(db: DbClient, id: string, state = "completed"): void {
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?, 'p', 'd', ?, 'STANDARD', '{}', '[]', 0, '2026-04-23T00:00:00Z', '2026-04-23T00:00:00Z')`
  ).run(id, state);
}

describe("DbClient.insertLesson", () => {
  test("persists a lesson row with required fields", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder");
    seedTask(db, "t1");

    const id = db.insertLesson({
      agentType: "coder",
      lineageRootId: "vBase",
      sourceTaskId: "t1",
      sourceVariantId: "vBase",
      triggerPattern: "React styling tasks",
      failureCategory: "rework_limit",
      findingCategories: ["styling"],
      body: "TRIGGER: x\nOBSERVATION: y\nPRINCIPLE: z\nEVIDENCE: e",
      outcomeKind: "corrective",
      retrievalKeywords: "react css styling"
    });

    expect(typeof id).toBe("string");
    const row = db.sqlite
      .query("SELECT * FROM lessons WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.agent_type).toBe("coder");
    expect(row.status).toBe("active");
    expect(JSON.parse(row.finding_categories as string)).toEqual(["styling"]);
  });
});

describe("DbClient.resolveLineageRoot", () => {
  test("returns self id when parent_version_id is NULL", () => {
    const db = freshDb();
    seedVariant(db, "vSeed", "persona:coder", null);
    expect(db.resolveLineageRoot("vSeed")).toBe("vSeed");
  });

  test("walks parent chain to root", () => {
    const db = freshDb();
    seedVariant(db, "vSeed", "persona:coder", null);
    seedVariant(db, "vMid", "persona:coder.x", "vSeed", "candidate");
    seedVariant(db, "vLeaf", "persona:coder.x.y", "vMid", "candidate");
    expect(db.resolveLineageRoot("vLeaf")).toBe("vSeed");
  });

  test("handles cycles defensively (returns last-seen id)", () => {
    const db = freshDb();
    seedVariant(db, "vA", "persona:coder", null);
    seedVariant(db, "vB", "persona:coder", "vA", "candidate");
    // Introduce a cycle by direct SQL (shouldn't happen in practice but we defend).
    db.sqlite.query("UPDATE skill_versions SET parent_version_id = 'vB' WHERE id = 'vA'").run();
    // Should terminate without stack overflow and return some id in the cycle.
    const root = db.resolveLineageRoot("vB");
    expect(["vA", "vB"]).toContain(root);
  });

  test("returns null for unknown id", () => {
    const db = freshDb();
    expect(db.resolveLineageRoot("missing")).toBeNull();
  });
});

describe("DbClient.retrieveActiveLessonsByLineage", () => {
  test("filters by lineage_root_id, agent_type, status='active'", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedVariant(db, "vOther", "persona:planner", null);
    seedTask(db, "t1");

    const keep = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Wrong agent type.
    db.insertLesson({
      agentType: "planner", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Wrong lineage.
    db.insertLesson({
      agentType: "coder", lineageRootId: "vOther", sourceTaskId: "t1",
      sourceVariantId: "vOther", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Retired.
    const retired = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    db.sqlite.query("UPDATE lessons SET status='retired' WHERE id = ?").run(retired);

    const lessons = db.retrieveActiveLessonsByLineage("vRoot", "coder");
    expect(lessons.map((l) => l.id)).toEqual([keep]);
  });
});

describe("DbClient.supersedeLessons and retireLessons", () => {
  test("supersedeLessons sets status and superseded_by", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedTask(db, "t1");

    const oldId = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    const newId = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p2", body: "b2", outcomeKind: "corrective"
    });

    db.supersedeLessons([oldId], newId);
    const row = db.sqlite.query("SELECT status, superseded_by, retired_at FROM lessons WHERE id = ?")
      .get(oldId) as { status: string; superseded_by: string; retired_at: string };
    expect(row.status).toBe("superseded");
    expect(row.superseded_by).toBe(newId);
    expect(row.retired_at).not.toBeNull();
  });

  test("retireLessons only transitions active lessons", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedTask(db, "t1");

    const alive = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    const already = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    db.sqlite.query("UPDATE lessons SET status='retired' WHERE id = ?").run(already);

    const transitioned = db.retireLessons([alive, already]);
    expect(transitioned).toEqual([alive]);
    const row = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(alive) as { status: string };
    expect(row.status).toBe("retired");
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
bun test tests/unit/lessons-helpers.test.ts
```

Expected: FAIL. Helpers don't exist.

- [ ] **Step 7: Implement the DB helpers**

Open `src/db/client.ts`. Import `randomUUID` (already imported per existing code). Add these methods to the `DbClient` class, near the other insert helpers (place right after `insertTaskIterationDiff`):

```typescript
export interface LessonInsert {
  agentType: string;
  lineageRootId: string;
  sourceTaskId: string;
  sourceVariantId: string;
  triggerPattern: string;
  failureCategory?: string | null;
  findingCategories?: string[] | null;
  body: string;
  outcomeKind: "corrective" | "reinforcing";
  retrievalKeywords?: string | null;
}

export interface LessonRow {
  id: string;
  agent_type: string;
  lineage_root_id: string;
  source_task_id: string;
  source_variant_id: string;
  trigger_pattern: string;
  failure_category: string | null;
  finding_categories: string | null;  // JSON string
  body: string;
  outcome_kind: "corrective" | "reinforcing";
  retrieval_keywords: string | null;
  status: "active" | "superseded" | "retired";
  superseded_by: string | null;
  created_at: string;
  retired_at: string | null;
}
```

Add methods (inside the class):

```typescript
insertLesson(input: LessonInsert): string {
  const id = randomUUID();
  this.sqlite.query(`
    INSERT INTO lessons
      (id, agent_type, lineage_root_id, source_task_id, source_variant_id,
       trigger_pattern, failure_category, finding_categories, body,
       outcome_kind, retrieval_keywords)
    VALUES
      ($id, $agent_type, $lineage_root_id, $source_task_id, $source_variant_id,
       $trigger_pattern, $failure_category, $finding_categories, $body,
       $outcome_kind, $retrieval_keywords)
  `).run({
    $id: id,
    $agent_type: input.agentType,
    $lineage_root_id: input.lineageRootId,
    $source_task_id: input.sourceTaskId,
    $source_variant_id: input.sourceVariantId,
    $trigger_pattern: input.triggerPattern,
    $failure_category: input.failureCategory ?? null,
    $finding_categories: input.findingCategories
      ? JSON.stringify(input.findingCategories)
      : null,
    $body: input.body,
    $outcome_kind: input.outcomeKind,
    $retrieval_keywords: input.retrievalKeywords ?? null
  });
  return id;
}

resolveLineageRoot(variantId: string): string | null {
  // Walk parent_version_id chain. Cycle-safe via a visited set with a depth cap.
  const seen = new Set<string>();
  let current: string | null = variantId;
  for (let depth = 0; depth < 50 && current !== null; depth++) {
    if (seen.has(current)) {
      // Cycle — return the last traversed id.
      return current;
    }
    seen.add(current);
    const row = this.sqlite
      .query("SELECT parent_version_id FROM skill_versions WHERE id = ?")
      .get(current) as { parent_version_id: string | null } | undefined;
    if (!row) return depth === 0 ? null : current;
    if (row.parent_version_id === null) return current;
    current = row.parent_version_id;
  }
  return current;  // depth cap; unusual but defensive
}

retrieveActiveLessonsByLineage(
  lineageRootId: string,
  agentType: string,
  limit = 20
): LessonRow[] {
  return this.sqlite.query(`
    SELECT * FROM lessons
    WHERE lineage_root_id = $lineage_root_id
      AND agent_type = $agent_type
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT $limit
  `).all({
    $lineage_root_id: lineageRootId,
    $agent_type: agentType,
    $limit: limit
  }) as LessonRow[];
}

supersedeLessons(oldIds: string[], newLessonId: string): void {
  if (oldIds.length === 0) return;
  const stmt = this.sqlite.query(`
    UPDATE lessons
       SET status = 'superseded',
           superseded_by = $new_id,
           retired_at = datetime('now')
     WHERE id = $id AND status = 'active'
  `);
  this.sqlite.transaction(() => {
    for (const id of oldIds) {
      stmt.run({ $new_id: newLessonId, $id: id });
    }
  })();
}

retireLessons(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const transitioned: string[] = [];
  const stmt = this.sqlite.query(`
    UPDATE lessons
       SET status = 'retired',
           retired_at = datetime('now')
     WHERE id = $id AND status = 'active'
  `);
  this.sqlite.transaction(() => {
    for (const id of ids) {
      const info = stmt.run({ $id: id });
      if (info.changes === 1) transitioned.push(id);
    }
  })();
  return transitioned;
}
```

**Note on `deleteTaskPermanently`:** the existing helper cleans up child tables before deleting a task. Since `lessons.source_task_id REFERENCES tasks(id)` (without CASCADE), add `DELETE FROM lessons WHERE source_task_id = ?` near the existing `task_diff_stats` / `task_iteration_diffs` deletions (grep for `DELETE FROM task_diff_stats` in `client.ts`).

- [ ] **Step 8: Run tests to verify they pass**

```bash
bun test tests/unit/lessons-helpers.test.ts tests/unit/lessons-schema.test.ts
```

Expected: PASS (seven tests across both files).

- [ ] **Step 9: Run full suite + lint**

```bash
bun test
bun run lint
```

Expected: no regressions.

- [ ] **Step 10: Commit**

```bash
git add src/db/migrations/007_lessons.sql src/db/client.ts tests/unit/lessons-schema.test.ts tests/unit/lessons-helpers.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add lessons table and lineage helpers (Spec B §3.1)

Migration 007 creates the lessons table with per-lineage indices.
DbClient gains insertLesson, resolveLineageRoot (cycle-safe),
retrieveActiveLessonsByLineage, supersedeLessons, retireLessons.
deleteTaskPermanently now also cascades to lessons. This is the
storage foundation for the reflector sub-agent and dispatch-time
retrieval that arrive in later tasks.
EOF
)"
```

---

## Task 2: Reflector persona and agent-type wiring

Add `reflector` as a first-class `AgentType`, create the reflector persona file, register its skills (none at MVP), and add the executor-routing branch so reflector runs through the SDK executor with Claude Code as fallback.

**Files:**
- Create: `src/personas/reflector.md`
- Modify: `src/types/core.ts` — add `"reflector"` to `AgentType`
- Modify: `src/skills/registry.ts` — `AGENT_SKILLS["reflector"] = []`
- Modify: `src/orchestrator/service.ts` — `routeExecutor` branch for `"reflector"`
- Create: `src/config/reflection.ts` — budget/config constants
- Test: `tests/unit/reflector-persona.test.ts`

- [ ] **Step 1: Add AgentType entry**

Open `src/types/core.ts`. The first line defines `AgentType`. Add `"reflector"`:

```typescript
export type AgentType = "planner" | "coder" | "reviewer" | "doc" | "meta" | "reflector";
```

- [ ] **Step 2: Extend the skill registry**

Open `src/skills/registry.ts`. Locate `AGENT_SKILLS` (around line 10-19). Add the reflector entry:

```typescript
const AGENT_SKILLS: Record<AgentType, string[]> = {
  planner: [/* existing */],
  coder:   [/* existing */],
  reviewer:[/* existing */],
  doc:     [/* existing */],
  meta:    [/* existing */],
  reflector: []  // No attached skills at MVP; reflector is a system-utility persona.
};
```

**Preserve the exact existing arrays** for the other agents. Grep to view:

```bash
grep -n "AGENT_SKILLS" src/skills/registry.ts
```

- [ ] **Step 3: Create the reflector persona**

Create `src/personas/reflector.md`:

```markdown
# Reflector — Post-task Lesson Extractor

You are the Reflector. After every terminal task, you receive the task's outcome (completed or failed), transcripts, review findings, diff statistics, and any `failure_analysis` payload. Your job is to extract at most one generalizable lesson — or decide there isn't one.

## Principles

1. **Be conservative.** Most tasks do not warrant a lesson. When in doubt, skip.
2. **Generalize, don't restate.** A lesson must apply to a class of future tasks, not just this one.
3. **Cite concrete evidence.** Point to specific transcript lines, finding categories, or diff deltas.
4. **Respect the 200-word body limit.** The system rejects oversize lessons.
5. **Self-suppress redundancy.** You will be given the active lessons in this lineage. If a new lesson would duplicate or near-duplicate one of them, return `{"skip": true, "reason": "duplicate"}`.
6. **One lesson per task.** Never emit multiple lessons per invocation.

## What you read

The user message contains:
- `task`: id, description, tier, final state, iteration count
- `transcripts`: truncated transcript text for each agent stage (planner, coder, reviewer, doc)
- `findings`: all review findings (severity, category, description)
- `failure_analysis`: payload if the task failed
- `task_diff_stats`: cumulative diff numbers for the whole task
- `task_iteration_diffs`: per-rework deltas (the strongest supervision signal for `corrective` lessons)
- `active_lessons`: up to 20 active lessons in this agent's lineage — read these before deciding

## Output contract

You must write `.autoforge-status.json` with the following shape.

When you extract a lesson:

```json
{
  "status": "DONE",
  "artifacts": [],
  "lesson": {
    "skip": false,
    "agent_type": "coder",
    "trigger_pattern": "One sentence describing the class of tasks this lesson applies to.",
    "body": "TRIGGER: <restatement>\nOBSERVATION: <what happened>\nPRINCIPLE: <one-sentence rule>\nEVIDENCE: <specific citations>",
    "outcome_kind": "corrective",
    "failure_category": "rework_limit",
    "finding_categories": ["styling", "convention"],
    "keywords": "lowercase space-separated terms extracted from task and findings"
  }
}
```

When you decline to produce a lesson:

```json
{
  "status": "DONE",
  "artifacts": [],
  "lesson": { "skip": true, "reason": "Task too narrow — no generalizable pattern." }
}
```

## Deciding agent_type

Pick exactly one agent lineage for the lesson:
- **planner** if the root cause is planner-attributable (planner fallback, planner-stage critical findings, missing subtask)
- **coder** if the cause is coder-attributable (rework loop, PR gate, blocking findings in executing stage) — this is the default for ambiguous cases
- **reviewer** only if the cause is a miscalibrated review (false positive blocking finding)

You never emit for `meta`, `doc`, or `reflector` agent types.

## outcome_kind

- **corrective** — the task failed or required rework; the lesson is a fix to apply next time.
- **reinforcing** — the task succeeded cleanly with a notable approach worth preserving.

Clean successes usually do not warrant a lesson. Only emit `reinforcing` when the approach was non-obvious and likely to be re-discovered wastefully.

## Keywords

Lowercase the task description, strip punctuation, split on whitespace, remove common stopwords (the, a, an, to, of, for, and, or, in, on, with, is, are, be). Add 2-3 finding category words if relevant. Keep 10-20 tokens total. Emit as a single space-separated string.
```

- [ ] **Step 4: Create the reflection config module**

Create `src/config/reflection.ts`:

```typescript
/**
 * Configuration for the reflector sub-agent invoked after every terminal task state.
 *
 * Kept deliberately small — no DB-backed overrides in MVP. Tuning is a code change.
 * Spec B §4.2 budget, §4.4 self-suppression cap, §4.5 skip rules, §5.1 retrieval defaults.
 */
export const REFLECTION_CONFIG = {
  /** Budget in seconds for a single reflector dispatch (LLM call). */
  budgetSeconds: 60,

  /** Max active lessons supplied to the reflector for self-suppression (§4.4). */
  maxActiveLessonsForContext: 20,

  /** Max words allowed in a lesson.body — over-limit outputs are rejected. */
  maxLessonBodyWords: 200,

  /** Skip reflection when task stalls with less than this elapsed time (§4.5). */
  skipFailedStalledBelowSeconds: 60,

  /** Defaults for retrieveLessonsForDispatch (§5.1). */
  retrieval: {
    maxLessons: 5,
    maxTokens: 1500
  }
} as const;
```

- [ ] **Step 5: Add reflector branch to routeExecutor**

Open `src/orchestrator/service.ts`. Find `routeExecutor` (around line 1412):

```bash
grep -n "routeExecutor\|private routeExecutor" src/orchestrator/service.ts
```

The existing meta branch (at line ~1417) forces Claude Code. Add a reflector branch **above** the meta branch so the dispatcher prefers SDK for reflector with Claude Code as fallback:

```typescript
// Existing (illustrative — replace with actual code you see):
private routeExecutor(tier: Tier, agent: AgentType): AgentExecutor {
  if (agent === "reflector") {
    // SDK-first with Claude Code fallback. The SDK produces the JSON body reliably.
    return this.deps.executors.sdk ?? this.deps.executors.claudeCode;
  }
  if (agent === "meta") {
    return this.deps.executors.claudeCode;
  }
  // ... existing tier-based dispatch
}
```

**Exact wiring note:** `this.deps.executors` shape depends on the existing codebase. Open the file and adapt to whatever executor-selection pattern already exists (sdk / claudeCode / mock). If the existing pattern is `if (env.ANTHROPIC_API_KEY) return sdk else return claudeCode`, mirror it — the *policy* here is "prefer SDK for reflector."

- [ ] **Step 6: Write a persona-registration test**

Create `tests/unit/reflector-persona.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { PersonaRegistry } from "../../src/personas/registry";

describe("reflector persona", () => {
  test("PersonaRegistry.resolve returns the reflector persona file content", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflector-persona-test-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const reg = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
    const text = reg.resolve("reflector");
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("Reflector");
    expect(text).toContain("outcome_kind");
  });
});
```

Adjust the `PersonaRegistry` constructor call to match the actual signature from `src/personas/registry.ts`.

- [ ] **Step 7: Run tests + lint**

```bash
bun test tests/unit/reflector-persona.test.ts
bun run lint
```

Expected: PASS. Type check passes — `"reflector"` is now a valid `AgentType`.

- [ ] **Step 8: Commit**

```bash
git add src/types/core.ts src/skills/registry.ts src/personas/reflector.md src/config/reflection.ts src/orchestrator/service.ts tests/unit/reflector-persona.test.ts
git commit -m "$(cat <<'EOF'
feat(reflector): add reflector agent type and persona (Spec B §3.3)

Introduces "reflector" as an AgentType with an empty skill bundle and a
dedicated persona file. routeExecutor prefers the SDK executor for
reflector dispatches (Claude Code fallback) since reflection benefits
from structured JSON output. Config lives in src/config/reflection.ts.
EOF
)"
```

---

## Task 3: Reflection module and orchestrator wiring

Implement `reflectOnTask` — the synchronous reflector dispatch invoked after every terminal task state — and wire it into `OrchestratorService`.

**Files:**
- Create: `src/orchestrator/reflection.ts`
- Modify: `src/orchestrator/service.ts` — call `reflectOnTask` after terminal transitions, before `cleanupWorktree`
- Test: `tests/integration/reflection-flow.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/reflection-flow.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("reflection flow", () => {
  test("a successfully completed task either produces a lesson row or logs a skip", async () => {
    const { service, db, cleanup } = await createTestService();
    try {
      const { taskId } = await service.submitTask({
        projectId: "p",
        description: "Add a trivial comment to the README",
        tier: "STANDARD"
      });
      // Helper from the existing happy-path test: drive through the pipeline.
      // (Reuse any existing helper that runs the mock executor to completion.)
      await driveToCompletion(service, taskId);

      // Either a lesson row exists or a reflector_skipped event was logged.
      const lessons = db.sqlite
        .query("SELECT id FROM lessons WHERE source_task_id = ?")
        .all(taskId) as Array<{ id: string }>;
      const skipped = db.sqlite
        .query(
          "SELECT id FROM events WHERE task_id = ? AND event_type IN ('reflector_skipped', 'reflector_failed')"
        )
        .all(taskId) as Array<{ id: string }>;
      expect(lessons.length + skipped.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });

  test("task failed with failure_category='stalled' and elapsed < 60 skips reflection entirely", async () => {
    const { service, db, cleanup } = await createTestService();
    try {
      // Seed a task directly in failed state with the narrow skip trigger.
      const taskId = "stalled-1";
      db.sqlite.query(`
        INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
        VALUES (?, 'p', 'd', 'failed', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))
      `).run(taskId);
      db.sqlite.query(`
        INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
        VALUES ('e1', ?, datetime('now'), 'p', 'orchestrator', 'failure_analysis', 'failed',
                json_object('failure_category', 'stalled', 'elapsed_seconds', 10, 'planner_fallback', 0), 60)
      `).run(taskId);

      await service.reflectOnTask(taskId);  // Called directly for this test.

      const lessons = db.sqlite
        .query("SELECT id FROM lessons WHERE source_task_id = ?")
        .all(taskId);
      expect(lessons).toHaveLength(0);
      const skipped = db.sqlite
        .query("SELECT json_extract(payload,'$.reason') AS reason FROM events WHERE task_id=? AND event_type='reflector_skipped'")
        .get(taskId) as { reason: string };
      expect(skipped.reason).toContain("stalled");
    } finally {
      await cleanup();
    }
  });
});

// Minimal helper. Replace with whichever driver the happy-path test already uses.
async function driveToCompletion(service: any, taskId: string): Promise<void> {
  // Placeholder — mirror tests/integration/happy-path.test.ts pattern.
  // If the existing helper is called `driveToCompletion`, import and use it.
  await service.approveTask?.(taskId);
}
```

**Before running:** inspect `tests/integration/happy-path.test.ts` and `tests/helpers/create-service.ts` for the actual helper names. The second test is self-contained and can run without the driver helper.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/integration/reflection-flow.test.ts
```

Expected: FAIL. `service.reflectOnTask` doesn't exist.

- [ ] **Step 3: Implement the reflection module**

Create `src/orchestrator/reflection.ts`:

```typescript
import type { DbClient } from "../db/client";
import type { AgentExecutor } from "../executors/interface";
import type { PersonaRegistry } from "../personas/registry";
import type { SkillRegistry } from "../skills/registry";
import { REFLECTION_CONFIG } from "../config/reflection";

interface ReflectionDeps {
  db: DbClient;
  executor: AgentExecutor;         // SDK executor preferred (see routeExecutor reflector branch)
  personas: PersonaRegistry;
  skills: SkillRegistry;
  recordEvent: (e: {
    taskId: string;
    projectId: string;
    type: string;
    agent: string;
    status: string;
    payload: Record<string, unknown>;
    budgetSeconds: number;
  }) => void;
}

export interface ReflectorOutput {
  skip?: boolean;
  reason?: string;
  lesson?: {
    skip: false;
    agent_type: string;
    trigger_pattern: string;
    body: string;
    outcome_kind: "corrective" | "reinforcing";
    failure_category?: string | null;
    finding_categories?: string[] | null;
    keywords?: string | null;
  } | { skip: true; reason: string };
}

export interface ReflectionResult {
  lessonId: string | null;
  skipped: boolean;
  reason?: string;
}

/**
 * Runs the reflector sub-agent synchronously for a terminal task.
 * Called from OrchestratorService after state.completed / state.failed / cancelTask,
 * AFTER computeDiffStats and BEFORE cleanupWorktree.
 *
 * Returns { lessonId } on success, { skipped } if the reflector declined,
 * or { skipped: true, reason } for policy-based skips.
 */
export async function reflectOnTask(
  taskId: string,
  deps: ReflectionDeps
): Promise<ReflectionResult> {
  const task = deps.db.getTask(taskId);
  if (!task) return { lessonId: null, skipped: true, reason: "task_not_found" };

  // §4.5 Skipping reflection on noise
  const failureAnalysis = deps.db.sqlite.query(`
    SELECT payload FROM events
     WHERE task_id = ? AND event_type = 'failure_analysis'
     ORDER BY timestamp DESC LIMIT 1
  `).get(taskId) as { payload: string } | undefined;

  if (failureAnalysis) {
    const fa = JSON.parse(failureAnalysis.payload) as Record<string, unknown>;
    if (
      task.state === "failed" &&
      fa.failure_category === "stalled" &&
      typeof fa.elapsed_seconds === "number" &&
      fa.elapsed_seconds < REFLECTION_CONFIG.skipFailedStalledBelowSeconds
    ) {
      emitSkipped(deps, task, "task stalled under threshold — no learning signal");
      return { lessonId: null, skipped: true, reason: "stalled" };
    }
    if (fa.failure_category === "cancelled" && fa.cancel_reason === "noise") {
      emitSkipped(deps, task, "cancel reason=noise");
      return { lessonId: null, skipped: true, reason: "cancelled_noise" };
    }
  }

  // Resolve the coder variant (primary lineage for the default lesson attribution).
  const coderVariantId = await deps.personas.snapshotId("coder");
  const lineageRootId = deps.db.resolveLineageRoot(coderVariantId) ?? coderVariantId;
  const activeLessons = deps.db.retrieveActiveLessonsByLineage(
    lineageRootId, "coder", REFLECTION_CONFIG.maxActiveLessonsForContext
  );

  const userPrompt = buildReflectorPrompt(taskId, deps, activeLessons);

  const reflectorPersonaId = await deps.personas.snapshotId("reflector");
  try {
    const result = await deps.executor.execute({
      systemPrompt: deps.personas.resolve("reflector"),
      prompt: userPrompt,
      workingDirectory: undefined,       // reflector doesn't need a worktree
      skillFiles: [],
      budgetSeconds: REFLECTION_CONFIG.budgetSeconds,
      tier: "EXPRESS",
      agentType: "reflector"
    });

    if (result.status !== "DONE" || !result.output) {
      emitSkipped(deps, task, `reflector_returned_${result.status}`);
      return { lessonId: null, skipped: true, reason: "non_done_status" };
    }

    const parsed = parseReflectorOutput(result.output);
    if (!parsed.ok) {
      emitFailed(deps, task, `parse_error: ${parsed.error}`);
      return { lessonId: null, skipped: true, reason: "parse_error" };
    }

    const { lesson } = parsed;
    if (!lesson || lesson.skip === true) {
      emitSkipped(deps, task, lesson?.reason ?? "reflector declined");
      return { lessonId: null, skipped: true, reason: lesson?.reason };
    }

    // Body word-count validation.
    const wordCount = lesson.body.trim().split(/\s+/).length;
    if (wordCount > REFLECTION_CONFIG.maxLessonBodyWords) {
      emitFailed(deps, task, `body_over_word_limit:${wordCount}`);
      return { lessonId: null, skipped: true, reason: "body_over_limit" };
    }

    // Select the correct lineage based on the reflector's chosen agent_type.
    const agentVariantId = await deps.personas.snapshotId(lesson.agent_type as any);
    const agentLineageRoot = deps.db.resolveLineageRoot(agentVariantId) ?? agentVariantId;

    const id = deps.db.insertLesson({
      agentType: lesson.agent_type,
      lineageRootId: agentLineageRoot,
      sourceTaskId: taskId,
      sourceVariantId: agentVariantId,
      triggerPattern: lesson.trigger_pattern,
      failureCategory: lesson.failure_category ?? null,
      findingCategories: lesson.finding_categories ?? null,
      body: lesson.body,
      outcomeKind: lesson.outcome_kind,
      retrievalKeywords: lesson.keywords ?? null
    });

    deps.recordEvent({
      taskId,
      projectId: task.projectId,
      type: "lesson_inserted",
      agent: "reflector",
      status: "done",
      payload: { lesson_id: id, agent_type: lesson.agent_type, outcome_kind: lesson.outcome_kind },
      budgetSeconds: REFLECTION_CONFIG.budgetSeconds
    });
    return { lessonId: id, skipped: false };
  } catch (err) {
    emitFailed(deps, task, `exception:${(err as Error).message}`);
    return { lessonId: null, skipped: true, reason: "exception" };
  }
}

function buildReflectorPrompt(taskId: string, deps: ReflectionDeps, activeLessons: unknown[]): string {
  const task = deps.db.getTask(taskId)!;
  const transcripts = deps.db.listTranscriptsByTask(taskId);
  const findings = deps.db.listFindings(taskId);
  const diffStats = deps.db.sqlite
    .query("SELECT * FROM task_diff_stats WHERE task_id = ?").get(taskId);
  const iterDiffs = deps.db.sqlite
    .query("SELECT * FROM task_iteration_diffs WHERE task_id = ? ORDER BY from_iteration ASC").all(taskId);
  const faRow = deps.db.sqlite
    .query(
      "SELECT payload FROM events WHERE task_id = ? AND event_type = 'failure_analysis' ORDER BY timestamp DESC LIMIT 1"
    ).get(taskId) as { payload: string } | undefined;
  const fa = faRow ? JSON.parse(faRow.payload) : null;

  const TRUNCATE = 8000;
  const truncate = (s: string) => (s.length > TRUNCATE ? s.slice(0, TRUNCATE) + "\n…[truncated]" : s);

  return [
    `# Task ${task.id}`,
    `state: ${task.state}   tier: ${task.tier}   iteration: ${task.iteration}`,
    ``,
    `## Description`,
    task.description,
    ``,
    `## Transcripts`,
    ...transcripts.map((t) => `### ${t.stage} (attempt ${t.attempt})\n${truncate(t.transcript ?? "")}`),
    ``,
    `## Findings`,
    findings.length === 0 ? "(none)" : findings.map((f) => `- [${f.severity}] ${f.category}: ${f.description}`).join("\n"),
    ``,
    `## Diff stats (cumulative)`,
    diffStats ? JSON.stringify(diffStats) : "(none captured)",
    ``,
    `## Iteration diffs`,
    iterDiffs.length === 0 ? "(none)" : JSON.stringify(iterDiffs, null, 2),
    ``,
    `## Failure analysis`,
    fa ? JSON.stringify(fa, null, 2) : "(task did not fail)",
    ``,
    `## Active lessons in this lineage (for self-suppression)`,
    activeLessons.length === 0
      ? "(none — any extracted lesson is novel)"
      : JSON.stringify(activeLessons, null, 2),
    ``,
    `Now decide whether a generalizable lesson applies. Write .autoforge-status.json per the persona contract.`
  ].join("\n");
}

interface ParseOk { ok: true; lesson: ReflectorOutput["lesson"] }
interface ParseErr { ok: false; error: string }

function parseReflectorOutput(output: unknown): ParseOk | ParseErr {
  if (typeof output !== "object" || output === null) {
    return { ok: false, error: "output_not_object" };
  }
  const obj = output as Record<string, unknown>;
  const lesson = obj.lesson as ReflectorOutput["lesson"];
  if (!lesson) return { ok: false, error: "missing_lesson_key" };
  return { ok: true, lesson };
}

function emitSkipped(deps: ReflectionDeps, task: { id: string; projectId: string }, reason: string): void {
  deps.recordEvent({
    taskId: task.id, projectId: task.projectId, type: "reflector_skipped",
    agent: "reflector", status: "done", payload: { reason },
    budgetSeconds: REFLECTION_CONFIG.budgetSeconds
  });
}

function emitFailed(deps: ReflectionDeps, task: { id: string; projectId: string }, reason: string): void {
  deps.recordEvent({
    taskId: task.id, projectId: task.projectId, type: "reflector_failed",
    agent: "reflector", status: "failed", payload: { reason },
    budgetSeconds: REFLECTION_CONFIG.budgetSeconds
  });
}
```

- [ ] **Step 4: Wire `reflectOnTask` into `OrchestratorService`**

Open `src/orchestrator/service.ts`.

Add the import:

```typescript
import { reflectOnTask, type ReflectionResult } from "./reflection";
```

Add a public method on the class:

```typescript
async reflectOnTask(taskId: string): Promise<ReflectionResult> {
  return reflectOnTask(taskId, {
    db: this.deps.db,
    executor: this.routeExecutor("EXPRESS", "reflector"),
    personas: this.personas,
    skills: this.skills,
    recordEvent: (e) => this.recordEvent(e)
  });
}
```

Then locate every terminal-transition site that already calls `this.captureTaskDiffStats(taskId)` before `this.cleanupWorktree(...)`. These are:
- `approveTask` around line 73
- successful completion inside `submitTask` around line 185
- `approvePlan` path around line 390
- `cancelTask` around line 625
- `sweepStaleTasks` around line 785
- meta paths around 865, 898, 925

For **non-meta** paths, add `await this.reflectOnTask(taskId);` **immediately after** `captureTaskDiffStats(taskId)` and **before** `cleanupWorktree(taskId)`. Skip meta paths — Spec B §4.1 does not reflect on meta sessions. Reflector's own sessions are similarly not reflected on (they don't transition tasks in the task table).

**Cancel skip hook:** when `cancelTask` is called with `reason === "noise"`, emit a synthetic event signaling the noise cancel **before** calling `reflectOnTask`, so the reflection module can detect and skip:

```typescript
this.recordEvent({
  taskId, projectId: task.projectId, type: "failure_analysis", agent: "orchestrator",
  status: "failed",
  payload: this.failureAnalysisPayload({
    failure_category: "cancelled",
    cancel_reason: reason,
    stage_failed: task.state,
    failure_reason: reason
  }),
  budgetSeconds: 60
});
```

(If such an event is already emitted in the cancel path, just ensure `cancel_reason: reason` is in the payload.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/integration/reflection-flow.test.ts
```

Expected: PASS. The stalled-skip test works offline; the happy-path test needs a functional driver — if the driver helper doesn't exist in the codebase, simplify to the skip-test only and expand once the integration harness is available.

- [ ] **Step 6: Run full suite + lint**

```bash
bun test
bun run lint
```

Any existing test that previously completed a task synchronously now also runs the reflector once. With a mock executor returning `{ lesson: { skip: true, reason: "mock" } }`, this is cheap. Inspect the mock executor (`tests/helpers/mock-executor.ts` or similar) and **add a reflector-agent branch** if needed so the mock returns the skip shape:

```typescript
if (task.agentType === "reflector") {
  return {
    status: "DONE",
    output: { status: "DONE", artifacts: [], lesson: { skip: true, reason: "mock-executor" } },
    metrics: { elapsedSeconds: 0 }
  };
}
```

If a pre-existing test breaks because it asserts a specific event-log shape, extend its assertion to allow `reflector_skipped` events to be present.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/reflection.ts src/orchestrator/service.ts tests/integration/reflection-flow.test.ts tests/helpers/mock-executor.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): synchronous reflection after terminal states (Spec B §4)

reflectOnTask dispatches the reflector persona, persists at most one
lesson per task, and logs reflector_skipped / reflector_failed events
for policy-based and parse-failure paths. Wired in every non-meta
terminal transition between captureTaskDiffStats and cleanupWorktree.
The mock executor returns a skip output by default so existing
integration tests are unaffected.
EOF
)"
```

---

## Task 4: Lesson retrieval module

Implement `retrieveLessonsForDispatch(variantId, agentType, taskDescription, maxLessons?, maxTokens?)` with keyword extraction, ranking by keyword overlap, and a token-budget truncation step.

**Files:**
- Create: `src/orchestrator/lessons.ts`
- Test: `tests/unit/lesson-retrieval.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/lesson-retrieval.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { retrieveLessonsForDispatch, extractKeywords } from "../../src/orchestrator/lessons";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lesson-retrieval-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedLesson(
  db: DbClient,
  lineage: string,
  agentType: string,
  keywords: string,
  body = "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE"
): string {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
     VALUES (?, ?, '1', 'c', 'baseline', 1.0)
     ON CONFLICT(id) DO NOTHING`
  ).run(lineage, "persona:" + agentType);
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES ('src', 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO NOTHING`
  ).run();
  return db.insertLesson({
    agentType,
    lineageRootId: lineage,
    sourceTaskId: "src",
    sourceVariantId: lineage,
    triggerPattern: "p",
    body,
    outcomeKind: "corrective",
    retrievalKeywords: keywords
  });
}

describe("extractKeywords", () => {
  test("lowercases, strips punctuation, removes stopwords", () => {
    const out = extractKeywords("Refactor the User-Auth service for clarity and speed.");
    expect(out).toEqual(
      expect.arrayContaining(["refactor", "user", "auth", "service", "clarity", "speed"])
    );
    expect(out).not.toContain("the");
    expect(out).not.toContain("for");
    expect(out).not.toContain("and");
  });

  test("caps at 20 terms by frequency", () => {
    const text = Array.from({ length: 25 }, (_, i) => `term${i}`).join(" ");
    expect(extractKeywords(text)).toHaveLength(20);
  });
});

describe("retrieveLessonsForDispatch", () => {
  test("returns only lineage+agent matches, ordered by keyword overlap", async () => {
    const db = freshDb();
    const a = seedLesson(db, "vCoder", "coder", "react css styling");
    const b = seedLesson(db, "vCoder", "coder", "database migration");
    const c = seedLesson(db, "vCoder", "coder", "react hooks");

    const lessons = await retrieveLessonsForDispatch(
      "vCoder", "coder", "Styling a React component with CSS modules", 5, 2000, db
    );
    // 'a' matches 3 keywords, 'c' matches 1, 'b' matches 0.
    expect(lessons.map((l) => l.id)).toEqual([a, c]);
  });

  test("respects maxLessons", async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) seedLesson(db, "vCoder", "coder", "react styling css");
    const lessons = await retrieveLessonsForDispatch(
      "vCoder", "coder", "react styling", 2, 9999, db
    );
    expect(lessons).toHaveLength(2);
  });

  test("returns [] when no lesson has overlapping keywords", async () => {
    const db = freshDb();
    seedLesson(db, "vCoder", "coder", "database migration");
    const lessons = await retrieveLessonsForDispatch(
      "vCoder", "coder", "Add a dark-mode toggle", 5, 9999, db
    );
    expect(lessons).toEqual([]);
  });

  test("truncates tail to respect maxTokens (approx 4 chars = 1 token)", async () => {
    const db = freshDb();
    const bigBody = "word ".repeat(500);  // ~2500 chars ≈ 625 tokens
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    const lessons = await retrieveLessonsForDispatch(
      "vCoder", "coder", "react styling", 5, 800, db
    );
    expect(lessons.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/lesson-retrieval.test.ts
```

Expected: FAIL. Module doesn't exist.

- [ ] **Step 3: Implement `src/orchestrator/lessons.ts`**

```typescript
import type { DbClient } from "../db/client";

export interface RetrievedLesson {
  id: string;
  body: string;
  trigger_pattern: string;
  outcome_kind: "corrective" | "reinforcing";
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "with", "is", "are", "be"
]);

/** Approximate token counter: 1 token per 4 characters. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function extractKeywords(text: string, maxTerms = 20): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([t]) => t);
}

/**
 * Retrieves active lessons for a given variant's lineage, ranked by keyword
 * overlap with the task description. Returns up to maxLessons, truncated
 * further to respect the approximate token budget (body length only).
 *
 * Requires that lineage root resolution is done upstream OR that this helper
 * resolves lineage itself — we choose the latter for caller convenience.
 */
export async function retrieveLessonsForDispatch(
  variantId: string,
  agentType: string,
  taskDescription: string,
  maxLessons = 5,
  maxTokens = 1500,
  db: DbClient
): Promise<RetrievedLesson[]> {
  const lineageRootId = db.resolveLineageRoot(variantId);
  if (!lineageRootId) return [];

  const allActive = db.retrieveActiveLessonsByLineage(lineageRootId, agentType, 200);
  if (allActive.length === 0) return [];

  const taskKeywords = new Set(extractKeywords(taskDescription));
  const scored = allActive.map((row) => {
    const lessonKeywords = (row.retrieval_keywords ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let overlap = 0;
    for (const k of lessonKeywords) if (taskKeywords.has(k)) overlap += 1;
    return { row, overlap };
  });

  const ranked = scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return b.row.created_at.localeCompare(a.row.created_at);
    })
    .slice(0, maxLessons);

  const out: RetrievedLesson[] = [];
  let tokenBudget = maxTokens;
  for (const { row } of ranked) {
    const cost = approxTokens(row.body);
    if (cost > tokenBudget) break;
    tokenBudget -= cost;
    out.push({
      id: row.id,
      body: row.body,
      trigger_pattern: row.trigger_pattern,
      outcome_kind: row.outcome_kind as "corrective" | "reinforcing"
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/lesson-retrieval.test.ts
```

Expected: PASS (six tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add src/orchestrator/lessons.ts tests/unit/lesson-retrieval.test.ts
git commit -m "feat(orchestrator): keyword-based lesson retrieval with token budgeting (Spec B §5)"
```

---

## Task 5: Prompt injection and injected_lesson_ids wiring

Extend `AgentTask` with an optional `lessons` string. Each executor's prompt-builder inserts a `# Lessons from past tasks in this lineage` section between the persona and the `# Skills` block. In `OrchestratorService`, retrieval runs at each dispatch site and the retrieved ids are passed into `emitVariantSelected` so the `variant_selected` event records them.

**Files:**
- Modify: `src/executors/interface.ts` — `AgentTask.lessons?: string`
- Modify: `src/executors/anthropic-sdk.ts` — `buildSystemPrompt` injects lessons
- Modify: `src/executors/claude-code.ts` — `buildPrompt` injects lessons
- Modify: `src/orchestrator/service.ts` — retrieve lessons before each dispatch; pass into `execute`; pass ids to `emitVariantSelected`
- Test: `tests/unit/lesson-prompt-injection.test.ts`
- Test: `tests/integration/lesson-injection-dispatch.test.ts`

- [ ] **Step 1: Write failing prompt-injection unit test**

Create `tests/unit/lesson-prompt-injection.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildSystemPromptForTest } from "../../src/executors/anthropic-sdk";

describe("buildSystemPrompt lesson injection", () => {
  test("inserts # Lessons section between persona and # Skills when lessons provided", () => {
    const prompt = buildSystemPromptForTest({
      systemPrompt: "You are the coder.",
      skillFiles: [{ name: "rule-a.md", content: "Rule A content" }],
      lessons: "# Lessons from past tasks in this lineage\n\n## Lesson L1 (corrective)\nTRIGGER: ..."
    });

    const personaIdx = prompt.indexOf("You are the coder.");
    const lessonIdx = prompt.indexOf("# Lessons from past tasks");
    const skillsIdx = prompt.indexOf("# Skills");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(lessonIdx).toBeGreaterThan(personaIdx);
    expect(skillsIdx).toBeGreaterThan(lessonIdx);
  });

  test("omits lesson section entirely when lessons is undefined or empty", () => {
    const prompt = buildSystemPromptForTest({
      systemPrompt: "You are the coder.",
      skillFiles: [{ name: "rule-a.md", content: "Rule A content" }]
    });
    expect(prompt).not.toContain("# Lessons");
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/lesson-prompt-injection.test.ts
```

Expected: FAIL. `buildSystemPromptForTest` isn't exported (and doesn't do the injection).

- [ ] **Step 3: Extend `AgentTask`**

Open `src/executors/interface.ts`. Find the `AgentTask` interface (shape visible in the current codebase). Add:

```typescript
export interface AgentTask {
  // ... existing fields
  /**
   * Optional already-composed lessons block to inject between persona and skills.
   * Spec B §5.4 — populated by the orchestrator via retrieveLessonsForDispatch.
   */
  lessons?: string;
}
```

- [ ] **Step 4: Extend `buildSystemPrompt` (anthropic-sdk)**

Open `src/executors/anthropic-sdk.ts`. Locate `buildSystemPrompt` (around line 603-632). Modify it to:
1. Emit persona text (as today).
2. If `lessons` provided and non-empty, emit a blank line then the lessons block then a blank line.
3. Emit `# Skills` section (as today).
4. Emit `# Status Reporting` (as today).

Sketch (substitute actual code):

```typescript
function buildSystemPrompt(task: AgentTask): string {
  const parts: string[] = [task.systemPrompt];

  if (task.lessons && task.lessons.trim().length > 0) {
    parts.push("");
    parts.push(task.lessons.trim());
  }

  if (task.skillFiles && task.skillFiles.length > 0) {
    parts.push("");
    parts.push("# Skills");
    for (const sf of task.skillFiles) {
      parts.push("");
      parts.push(`## ${sf.name}`);
      parts.push(sf.content);
    }
  }

  parts.push("");
  parts.push(buildStatusReportingSection(task));  // existing helper

  return parts.join("\n");
}

// NEW test export at the bottom of the file, after any existing exports:
export function buildSystemPromptForTest(task: AgentTask): string {
  return buildSystemPrompt(task);
}
```

- [ ] **Step 5: Extend `buildPrompt` (claude-code)**

Open `src/executors/claude-code.ts`. Apply the same pattern to `buildPrompt` (around line 114-148):

```typescript
function buildPrompt(task: AgentTask): string {
  const parts: string[] = [task.systemPrompt];
  if (task.lessons && task.lessons.trim().length > 0) {
    parts.push("");
    parts.push(task.lessons.trim());
  }
  // ... existing skills + task + status-reporting sections
  return parts.join("\n");
}
```

Also add `export function buildPromptForTest` if you want a parallel unit test (optional; sdk test is sufficient as a smoke check since the logic is identical).

- [ ] **Step 6: Run the unit test; expect PASS**

```bash
bun test tests/unit/lesson-prompt-injection.test.ts
```

- [ ] **Step 7: Write the integration test for end-to-end injection**

Create `tests/integration/lesson-injection-dispatch.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("lesson injection at dispatch", () => {
  test("variant_selected records injected_lesson_ids matching retrieval output", async () => {
    const { service, db, cleanup } = await createTestService();
    try {
      // Seed a coder variant + a matching active lesson.
      const coderVariantId = await service.personasForTest.snapshotId("coder");
      db.insertLesson({
        agentType: "coder",
        lineageRootId: db.resolveLineageRoot(coderVariantId) ?? coderVariantId,
        sourceTaskId: "seed",
        sourceVariantId: coderVariantId,
        triggerPattern: "react styling tasks",
        body: "TRIGGER: ...\nOBSERVATION: ...\nPRINCIPLE: ...\nEVIDENCE: ...",
        outcomeKind: "corrective",
        retrievalKeywords: "react styling component"
      });
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now')) ON CONFLICT(id) DO NOTHING"
      ).run();

      const { taskId } = await service.submitTask({
        projectId: "p",
        description: "Style a React component with CSS modules",
        tier: "STANDARD"
      });

      // Drive through planner dispatch at minimum. (Use the same helper as happy-path.)
      await driveToCoderDispatch(service, taskId);

      const event = db.sqlite
        .query(
          `SELECT payload FROM events
            WHERE task_id = ? AND event_type = 'variant_selected'
              AND json_extract(payload, '$.agent_type') = 'coder'
            LIMIT 1`
        ).get(taskId) as { payload: string };

      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      expect(Array.isArray(payload.injected_lesson_ids)).toBe(true);
      expect((payload.injected_lesson_ids as string[]).length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });
});

async function driveToCoderDispatch(service: any, taskId: string): Promise<void> {
  // Mirror happy-path helper pattern.
}
```

If the `createTestService` helper doesn't expose `personasForTest`, add a thin accessor on the service or instantiate `PersonaRegistry` directly.

- [ ] **Step 8: Wire retrieval into every dispatch site**

In `src/orchestrator/service.ts`, for each call to `this.routeExecutor(...).execute({...})`, retrieve lessons **after** snapshotting the variant and **before** constructing the task, then pass into `execute` and into `emitVariantSelected`.

Add the import:

```typescript
import { retrieveLessonsForDispatch } from "./lessons";
```

Helper on the class:

```typescript
private async loadLessonsForDispatch(
  variantId: string,
  agentType: AgentType,
  taskDescription: string
): Promise<{ block: string; ids: string[] }> {
  const { retrieval } = REFLECTION_CONFIG;
  const lessons = await retrieveLessonsForDispatch(
    this.deps.db,
    variantId,
    agentType,
    taskDescription,
    retrieval.maxLessons,
    retrieval.maxTokens
  );
  if (lessons.length === 0) return { block: "", ids: [] };
  const parts = ["# Lessons from past tasks in this lineage", ""];
  for (const l of lessons) {
    parts.push(`## Lesson ${l.id} (${l.outcome_kind})`);
    parts.push(`TRIGGER: ${l.trigger_pattern}`);
    parts.push(l.body);
    parts.push("");
  }
  return { block: parts.join("\n").trim(), ids: lessons.map((l) => l.id) };
}
```

Don't forget to `import { REFLECTION_CONFIG } from "../config/reflection";`.

Now modify each of the five `execute(...)` call sites (planner, doc, meta, coder-per-subtask, reviewer). For each:

```typescript
// Existing:
const plannerPersonaId = this.personas.snapshotId("planner");
const plannerSkillIds = this.skills.snapshotIds("planner");

// NEW:
const plannerLessons = await this.loadLessonsForDispatch(
  plannerPersonaId, "planner", task.description
);
this.emitVariantSelected(taskId, projectId, "planner", plannerPersonaId, null, plannerLessons.ids);

// Pass into execute:
const plannerResult = await executor.execute({
  systemPrompt: this.personas.resolve("planner"),
  prompt: plannerPrompt,
  skillFiles: this.skills.skillsForAgent("planner"),
  lessons: plannerLessons.block || undefined,      // NEW
  // ... other existing fields
});
```

Update `emitVariantSelected` to accept `injectedLessonIds`:

```typescript
private emitVariantSelected(
  taskId: string,
  projectId: string,
  agentType: AgentType,
  variantId: string,
  specialty: string | null = null,
  injectedLessonIds: string[] = []
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
      injected_lesson_ids: injectedLessonIds  // NEW — populated now
    },
    budgetSeconds: 60
  });
}
```

Do **not** run lesson retrieval for `reflector` dispatches (the reflector reads lessons itself via `retrieveActiveLessonsByLineage` for self-suppression) and do **not** run retrieval for `meta` dispatches (curator meta reads lessons directly from SQL per its persona). For both, continue to call `emitVariantSelected` without lessons and pass `lessons: undefined` to `execute`.

- [ ] **Step 9: Run tests**

```bash
bun test
bun run lint
```

Expected: all pass. Some pre-existing tests may need a tweak if they assert the exact payload keys of `variant_selected`. `injected_lesson_ids: []` was already in Spec A's emission; what changes now is that it may be non-empty when lessons exist. Existing happy-path tests won't seed lessons, so they'll still see `[]`.

- [ ] **Step 10: Commit**

```bash
git add src/executors/interface.ts src/executors/anthropic-sdk.ts src/executors/claude-code.ts src/orchestrator/service.ts tests/unit/lesson-prompt-injection.test.ts tests/integration/lesson-injection-dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): inject lineage lessons into system prompt (Spec B §5)

AgentTask gains an optional lessons field that both executors render
between the persona block and the # Skills section. OrchestratorService
retrieves up to 5 lessons per dispatch (token-budgeted at ~1500) and
records the selected ids in variant_selected.injected_lesson_ids.
Reflector and meta dispatches bypass retrieval; they consult lessons
directly.
EOF
)"
```

---

## Task 6: Meta output Zod schema

Define a strict Zod schema for the curator meta's `.autoforge-status.json` operation object, cover every operation with accept/reject tests.

**Files:**
- Create: `src/schemas/meta-output.ts`
- Test: `tests/unit/meta-output-schema.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/meta-output-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { MetaOutputSchema, validateMetaOutput } from "../../src/schemas/meta-output";

const baseOp = {
  kind: "edit",
  target_variant_id: "v1",
  hypothesis: "h",
  evidence: {
    task_ids: ["t1"],
    metric_name: "task_quality_score",
    metric_before: 0.5
  },
  proposed_content_file: "proposed-persona.md"
};

describe("MetaOutputSchema", () => {
  test("accepts a well-formed edit operation", () => {
    const out = {
      status: "DONE",
      artifacts: ["proposed-persona.md"],
      operation: { ...baseOp }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(true);
  });

  test("accepts a well-formed fork with specialty", () => {
    const out = {
      status: "DONE",
      artifacts: [],
      operation: {
        kind: "fork",
        parent_variant_id: "v1",
        specialty: "frontend React",
        hypothesis: "h",
        evidence: { task_ids: ["t1", "t2"], finding_categories: ["styling"] },
        proposed_content_file: "proposed-persona-fork.md"
      }
    };
    expect(validateMetaOutput(out).ok).toBe(true);
  });

  test("rejects fork missing specialty", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "fork", parent_variant_id: "v1",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] },
        proposed_content_file: "x.md"
      }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/specialty/i);
  });

  test("rejects edit with specialty (forbidden)", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { ...baseOp, specialty: "illegal" }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/specialty/i);
  });

  test("rejects edit missing proposed_content_file", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "edit", target_variant_id: "v1",
        hypothesis: "h", evidence: { task_ids: ["t1"] }
      }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects promote/demote/retire with proposed_content_file", () => {
    for (const kind of ["promote", "demote", "retire"] as const) {
      const out = {
        status: "DONE", artifacts: [],
        operation: {
          kind, target_variant_id: "v1",
          hypothesis: "h", evidence: { task_ids: ["t1"] },
          proposed_content_file: "illegal.md"
        }
      };
      expect(validateMetaOutput(out).ok).toBe(false);
    }
  });

  test("accepts promote/demote with just target_variant_id + evidence", () => {
    for (const kind of ["promote", "demote", "retire"] as const) {
      const out = {
        status: "DONE", artifacts: [],
        operation: {
          kind, target_variant_id: "v1",
          hypothesis: "h", evidence: { task_ids: ["t1"] }
        }
      };
      expect(validateMetaOutput(out).ok).toBe(true);
    }
  });

  test("accepts merge with two variant ids", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "merge",
        target_variant_id: "v1",
        merge_source_variant_id: "v2",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      }
    };
    expect(validateMetaOutput(out).ok).toBe(true);
  });

  test("rejects evidence.task_ids empty", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { ...baseOp, evidence: { task_ids: [] } }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects retire_lessons > 3 entries", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        ...baseOp,
        retire_lessons: [
          { id: "l1", reason: "r" },
          { id: "l2", reason: "r" },
          { id: "l3", reason: "r" },
          { id: "l4", reason: "r" }
        ]
      }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects unknown kind", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { kind: "teleport", target_variant_id: "v1", hypothesis: "h",
                   evidence: { task_ids: ["t1"] } }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/meta-output-schema.test.ts
```

Expected: FAIL. Module doesn't exist.

- [ ] **Step 3: Implement the Zod schema**

Create `src/schemas/meta-output.ts`:

```typescript
import { z } from "zod";

const Evidence = z.object({
  task_ids: z.array(z.string()).min(1),
  finding_categories: z.array(z.string()).optional(),
  transcript_excerpts: z.array(z.object({
    task_id: z.string(),
    stage: z.string(),
    lines: z.string()
  })).optional(),
  metric_name: z.string().optional(),
  metric_before: z.number().optional()
});

const RetireLessonEntry = z.object({ id: z.string(), reason: z.string() });

const EditOp = z.object({
  kind: z.literal("edit"),
  target_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  proposed_content_file: z.string(),
  retire_lessons: z.array(RetireLessonEntry).max(3).optional(),
  specialty: z.undefined().optional()   // forbidden
}).strict();

const ForkOp = z.object({
  kind: z.literal("fork"),
  parent_variant_id: z.string(),
  specialty: z.string().min(1),
  hypothesis: z.string(),
  evidence: Evidence,
  proposed_content_file: z.string(),
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

const MergeOp = z.object({
  kind: z.literal("merge"),
  target_variant_id: z.string(),
  merge_source_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

const PromoteDemoteRetireOp = z.object({
  kind: z.enum(["promote", "demote", "retire"]),
  target_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  traffic_share: z.number().min(0).max(1).optional(),   // used by promote/demote
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

export const OperationSchema = z.discriminatedUnion("kind", [
  EditOp, ForkOp, MergeOp, PromoteDemoteRetireOp
]);

export const MetaOutputSchema = z.object({
  status: z.string(),
  artifacts: z.array(z.string()).default([]),
  operation: OperationSchema
});

export type MetaOutput = z.infer<typeof MetaOutputSchema>;
export type MetaOperation = z.infer<typeof OperationSchema>;

export interface ValidationResult {
  ok: boolean;
  value?: MetaOutput;
  error?: string;
}

/**
 * Safe-parse wrapper. Returns the first error path + message as a short string
 * suitable for embedding into the meta_rejected event payload.
 */
export function validateMetaOutput(raw: unknown): ValidationResult {
  const result = MetaOutputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const path = issue.path.join(".") || "<root>";
  return { ok: false, error: `${path}: ${issue.message}` };
}
```

**Note on strict mode:** `.strict()` rejects unknown keys. The `EditOp` branch uses `specialty: z.undefined().optional()` to make `specialty` explicitly forbidden rather than accidentally allowed via looseness. The discriminated union ensures an operation is exactly one kind.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/meta-output-schema.test.ts
```

Expected: PASS (eleven tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add src/schemas/meta-output.ts tests/unit/meta-output-schema.test.ts
git commit -m "feat(schemas): Zod schema for curator meta operation output (Spec B §3.5, §6.3)"
```

---

## Task 7: Migration 008 + operation handlers

Create migration 008 (`experiments.proposed_content TEXT`), then implement the six operation handlers in `src/orchestrator/meta-operations.ts`. `edit`, `promote`, `demote`, `retire` are fully implemented with baseline protection; `fork` and `merge` are stubbed as `status='proposed'` experiments with content stashed in `proposed_content`.

**Files:**
- Create: `src/db/migrations/008_experiments_proposed_content.sql`
- Create: `src/orchestrator/meta-operations.ts`
- Modify: `src/db/client.ts` — add `updateTrafficShare`, `retireVariant`, `insertMetaOperationExperiment`, and delete-cascade for new reference
- Test: `tests/unit/experiments-proposed-content-schema.test.ts`
- Test: `tests/unit/meta-operations.test.ts`

- [ ] **Step 1: Write failing schema test**

Create `tests/unit/experiments-proposed-content-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

describe("experiments.proposed_content column", () => {
  test("column exists as nullable TEXT after migration 008", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-content-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const cols = db.sqlite.query("PRAGMA table_info(experiments)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === "proposed_content");
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/experiments-proposed-content-schema.test.ts
```

Expected: FAIL. Column doesn't exist.

- [ ] **Step 3: Create migration 008**

Create `src/db/migrations/008_experiments_proposed_content.sql`:

```sql
-- 008: Persist the proposed persona content on fork/edit experiment rows.
-- Meta cleans up its worktree after every session, so the file referenced by
-- operation.proposed_content_file does not survive. Store the content in the DB
-- so downstream consumers (approval handler, cold-start evaluation) can read it.

ALTER TABLE experiments ADD COLUMN proposed_content TEXT;
```

Verify the schema test now passes:

```bash
bun test tests/unit/experiments-proposed-content-schema.test.ts
```

- [ ] **Step 4: Write failing handler tests**

Create `tests/unit/meta-operations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { handleMetaOperation } from "../../src/orchestrator/meta-operations";
import type { MetaOperation } from "../../src/schemas/meta-output";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "meta-ops-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedVariant(db: DbClient, id: string, skill: string, status: "baseline" | "candidate" | "active" = "baseline", share = 1.0): void {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
     VALUES (?, ?, '1', 'seed-content', ?, ?)`
  ).run(id, skill, status, share);
}

function makeWorktreeWithProposal(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meta-worktree-"));
  writeFileSync(join(dir, "proposed-persona.md"), content);
  return dir;
}

describe("handleMetaOperation — edit", () => {
  test("creates a candidate skill_versions row pointing at target", () => {
    const db = freshDb();
    seedVariant(db, "vOrig", "persona:coder");
    const worktree = makeWorktreeWithProposal("# New coder persona");

    const op: MetaOperation = {
      kind: "edit",
      target_variant_id: "vOrig",
      hypothesis: "clearer role statement",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "proposed-persona.md"
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt1", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(true);
    expect(res.experimentId).toBeDefined();

    const exp = db.sqlite.query("SELECT operation, evidence, proposed_content, status FROM experiments WHERE id = ?")
      .get(res.experimentId) as { operation: string; evidence: string; proposed_content: string; status: string };
    expect(exp.operation).toBe("edit");
    expect(exp.proposed_content).toBe("# New coder persona");
    expect(exp.status).toBe("active");

    const cand = db.sqlite.query(
      "SELECT id, parent_version_id, status, traffic_share FROM skill_versions WHERE skill_name = 'persona:coder' AND content = '# New coder persona'"
    ).get() as { id: string; parent_version_id: string; status: string; traffic_share: number };
    expect(cand.parent_version_id).toBe("vOrig");
    expect(cand.status).toBe("candidate");
    expect(cand.traffic_share).toBe(0.0);
  });
});

describe("handleMetaOperation — promote/demote baseline protection", () => {
  test("demote below 0.5 on baseline fails", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);

    const op: MetaOperation = {
      kind: "demote",
      target_variant_id: "vBase",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 0.2
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt2", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/baseline_protected/);
    // No state change.
    const row = db.sqlite.query("SELECT traffic_share FROM skill_versions WHERE id='vBase'").get() as { traffic_share: number };
    expect(row.traffic_share).toBe(1.0);
  });

  test("promote candidate above 1.0 fails", () => {
    const db = freshDb();
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    const op: MetaOperation = {
      kind: "promote",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 1.5
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt3", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
  });
});

describe("handleMetaOperation — retire", () => {
  test("retires a non-baseline variant", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);

    const op: MetaOperation = {
      kind: "retire", target_variant_id: "vCand",
      hypothesis: "h", evidence: { task_ids: ["t1"] }
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt4", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(true);
    const row = db.sqlite.query("SELECT status, traffic_share FROM skill_versions WHERE id='vCand'")
      .get() as { status: string; traffic_share: number };
    expect(row.status).toBe("retired");
    expect(row.traffic_share).toBe(0.0);
  });

  test("refuses to retire the sole baseline", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    const op: MetaOperation = {
      kind: "retire", target_variant_id: "vBase",
      hypothesis: "h", evidence: { task_ids: ["t1"] }
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt5", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/sole_baseline/);
  });
});

describe("handleMetaOperation — fork (stub)", () => {
  test("creates a proposed experiment with content stashed, no new skill_versions row", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    const worktree = makeWorktreeWithProposal("# Forked frontend variant");

    const op: MetaOperation = {
      kind: "fork",
      parent_variant_id: "vBase",
      specialty: "frontend React",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "proposed-persona.md"
    };

    const before = (db.sqlite.query("SELECT COUNT(*) AS n FROM skill_versions").get() as { n: number }).n;
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt6", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(true);
    const after = (db.sqlite.query("SELECT COUNT(*) AS n FROM skill_versions").get() as { n: number }).n;
    expect(after).toBe(before);  // No new skill_versions row until approval.

    const exp = db.sqlite.query("SELECT operation, status, proposed_content FROM experiments WHERE id = ?")
      .get(res.experimentId) as { operation: string; status: string; proposed_content: string };
    expect(exp.operation).toBe("fork");
    expect(exp.status).toBe("proposed");
    expect(exp.proposed_content).toBe("# Forked frontend variant");
  });
});

describe("handleMetaOperation — retire_lessons side effect", () => {
  test("retires listed lessons alongside the main operation", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();

    const l1 = db.insertLesson({
      agentType: "coder", lineageRootId: "vBase", sourceTaskId: "t1",
      sourceVariantId: "vBase", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    const op: MetaOperation = {
      kind: "retire", target_variant_id: "vBase",
      hypothesis: "h", evidence: { task_ids: ["t1"] },
      retire_lessons: [{ id: l1, reason: "superseded by new guidance" }]
    };
    // Retire the non-baseline lesson (we must seed another variant first to retire safely; rework test to keep baseline protected).
    // Re-seed: add a candidate to retire instead.
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    const op2: MetaOperation = { ...op, target_variant_id: "vCand" };

    const res = handleMetaOperation({
      db, operation: op2, metaTaskId: "mt7", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(true);

    const row = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(l1) as { status: string };
    expect(row.status).toBe("retired");
  });
});
```

- [ ] **Step 5: Run to verify fail**

```bash
bun test tests/unit/meta-operations.test.ts
```

Expected: FAIL. Module doesn't exist.

- [ ] **Step 6: Add DB helpers**

Extend `src/db/client.ts`:

```typescript
updateTrafficShare(variantId: string, trafficShare: number): void {
  this.sqlite.query(
    "UPDATE skill_versions SET traffic_share = ? WHERE id = ?"
  ).run(trafficShare, variantId);
}

retireVariant(variantId: string): void {
  this.sqlite.query(
    "UPDATE skill_versions SET status = 'retired', traffic_share = 0.0 WHERE id = ?"
  ).run(variantId);
}

insertMetaOperationExperiment(params: {
  experimentId: string;
  metaTaskId: string;
  operation: string;
  hypothesis: string;
  changeDescription: string;
  metricName?: string;
  metricBefore?: number;
  evidence: Record<string, unknown>;
  status: "active" | "proposed";
  proposedContent?: string | null;
}): void {
  this.sqlite.query(`
    INSERT INTO experiments
      (id, task_id, hypothesis, change_description, metric_name, metric_before,
       operation, evidence, status, proposed_content)
    VALUES
      ($id, $task_id, $hypothesis, $change, $metric_name, $metric_before,
       $operation, $evidence, $status, $proposed_content)
  `).run({
    $id: params.experimentId,
    $task_id: params.metaTaskId,
    $hypothesis: params.hypothesis,
    $change: params.changeDescription,
    $metric_name: params.metricName ?? null,
    $metric_before: params.metricBefore ?? null,
    $operation: params.operation,
    $evidence: JSON.stringify(params.evidence),
    $status: params.status,
    $proposed_content: params.proposedContent ?? null
  });
}

countBaselinesForSkillName(skillName: string): number {
  const row = this.sqlite
    .query("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = ? AND status = 'baseline'")
    .get(skillName) as { n: number };
  return row.n;
}

getSkillVersionById(id: string): { id: string; skill_name: string; status: string; traffic_share: number; parent_version_id: string | null } | null {
  const row = this.sqlite
    .query("SELECT id, skill_name, status, traffic_share, parent_version_id FROM skill_versions WHERE id = ?")
    .get(id) as { id: string; skill_name: string; status: string; traffic_share: number; parent_version_id: string | null } | undefined;
  return row ?? null;
}
```

**Note on `experiments.task_id`:** Inspect the column's NOT NULL / FK constraints. If `task_id` is NOT NULL with a FK to `tasks(id)`, pass `$task_id: params.metaTaskId` — the meta task has a row in `tasks` created by `submitMetaTask`. If it's already keyed to something else in the current schema, adapt the query.

- [ ] **Step 7: Implement `src/orchestrator/meta-operations.ts`**

```typescript
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DbClient } from "../db/client";
import type { MetaOperation } from "../schemas/meta-output";

const BASELINE_PROTECTION_MIN_SHARE = 0.5;
const MAX_TRAFFIC_SHARE = 1.0;

export interface MetaOperationContext {
  db: DbClient;
  operation: MetaOperation;
  metaTaskId: string;
  worktreePath: string;
  projectId: string;
}

export interface MetaOperationResult {
  ok: boolean;
  experimentId?: string;
  candidateVariantId?: string;   // only for edit
  reason?: string;
}

export function handleMetaOperation(ctx: MetaOperationContext): MetaOperationResult {
  switch (ctx.operation.kind) {
    case "edit":     return handleEdit(ctx);
    case "fork":     return handleFork(ctx);
    case "merge":    return handleMerge(ctx);
    case "promote":  return handleShareAdjust(ctx, "promote");
    case "demote":   return handleShareAdjust(ctx, "demote");
    case "retire":   return handleRetire(ctx);
  }
}

function readProposedContent(worktreePath: string, fileName: string): string | null {
  const p = resolve(worktreePath, fileName);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function applyRetireLessons(ctx: MetaOperationContext): string[] {
  const list = (ctx.operation.retire_lessons ?? []).map((e) => e.id);
  return ctx.db.retireLessons(list);
}

function handleEdit(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "edit" }>;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };

  const content = readProposedContent(ctx.worktreePath, op.proposed_content_file);
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: "proposed_content_empty" };
  }

  const experimentId = randomUUID();
  const candidateId = randomUUID();

  ctx.db.transaction(() => {
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "edit",
      hypothesis: op.hypothesis,
      changeDescription: op.hypothesis,
      metricName: op.evidence.metric_name,
      metricBefore: op.evidence.metric_before,
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx) },
      status: "active",
      proposedContent: content
    });

    ctx.db.sqlite.query(`
      INSERT INTO skill_versions
        (id, skill_name, version, content, experiment_id,
         parent_version_id, specialty, status, traffic_share)
      VALUES
        ($id, $skill, $version, $content, $exp,
         $parent, NULL, 'candidate', 0.0)
    `).run({
      $id: candidateId,
      $skill: target.skill_name,
      $version: String(Date.now()),      // monotonic-ish; adequate unless the existing code demands a specific scheme
      $content: content,
      $exp: experimentId,
      $parent: target.id
    });
  })();

  return { ok: true, experimentId, candidateVariantId: candidateId };
}

function handleFork(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "fork" }>;
  const parent = ctx.db.getSkillVersionById(op.parent_variant_id);
  if (!parent) return { ok: false, reason: "parent_not_found" };
  const content = readProposedContent(ctx.worktreePath, op.proposed_content_file);
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: "proposed_content_empty" };
  }

  const experimentId = randomUUID();
  ctx.db.insertMetaOperationExperiment({
    experimentId,
    metaTaskId: ctx.metaTaskId,
    operation: "fork",
    hypothesis: op.hypothesis,
    changeDescription: `fork ${parent.id} → specialty="${op.specialty}"`,
    metricName: op.evidence.metric_name,
    metricBefore: op.evidence.metric_before,
    evidence: {
      ...op.evidence,
      specialty: op.specialty,
      parent_variant_id: parent.id,
      retired_lessons: applyRetireLessons(ctx)
    },
    status: "proposed",
    proposedContent: content
  });

  return { ok: true, experimentId };
}

function handleMerge(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "merge" }>;
  if (!ctx.db.getSkillVersionById(op.target_variant_id)) {
    return { ok: false, reason: "target_not_found" };
  }
  if (!ctx.db.getSkillVersionById(op.merge_source_variant_id)) {
    return { ok: false, reason: "merge_source_not_found" };
  }

  const experimentId = randomUUID();
  ctx.db.insertMetaOperationExperiment({
    experimentId,
    metaTaskId: ctx.metaTaskId,
    operation: "merge",
    hypothesis: op.hypothesis,
    changeDescription: `merge proposal: ${op.merge_source_variant_id} into ${op.target_variant_id}`,
    evidence: {
      ...op.evidence,
      merge_source_variant_id: op.merge_source_variant_id,
      retired_lessons: applyRetireLessons(ctx)
    },
    status: "proposed"
  });

  return { ok: true, experimentId };
}

function handleShareAdjust(ctx: MetaOperationContext, kind: "promote" | "demote"): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "promote" | "demote" }>;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };

  const newShare = op.traffic_share;
  if (newShare === undefined) return { ok: false, reason: "traffic_share_required" };
  if (newShare < 0 || newShare > MAX_TRAFFIC_SHARE) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }
  if (target.status === "baseline" && newShare < BASELINE_PROTECTION_MIN_SHARE) {
    return { ok: false, reason: "baseline_protected" };
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.updateTrafficShare(target.id, newShare);
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: kind,
      hypothesis: op.hypothesis,
      changeDescription: `${kind} ${target.id} → ${newShare}`,
      evidence: { ...op.evidence, new_traffic_share: newShare, retired_lessons: applyRetireLessons(ctx) },
      status: "active"
    });
  })();

  return { ok: true, experimentId };
}

function handleRetire(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "retire" }>;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };

  if (target.status === "baseline") {
    const count = ctx.db.countBaselinesForSkillName(target.skill_name);
    if (count <= 1) return { ok: false, reason: "sole_baseline" };
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.retireVariant(target.id);
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "retire",
      hypothesis: op.hypothesis,
      changeDescription: `retire ${target.id}`,
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx) },
      status: "active"
    });
  })();

  return { ok: true, experimentId };
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
bun test tests/unit/meta-operations.test.ts tests/unit/experiments-proposed-content-schema.test.ts
```

Expected: PASS (seven tests).

- [ ] **Step 9: Run full suite + lint**

```bash
bun test
bun run lint
```

Existing meta tests (if any) may break because `submitMetaTask` hasn't been rewritten yet — handlers exist but aren't called by the service. That's fine; Task 10 rewrites `submitMetaTask`.

- [ ] **Step 10: Commit**

```bash
git add src/db/migrations/008_experiments_proposed_content.sql src/orchestrator/meta-operations.ts src/db/client.ts tests/unit/meta-operations.test.ts tests/unit/experiments-proposed-content-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): curator operation handlers (Spec B §6.4)

Migration 008 adds experiments.proposed_content so fork content
persists past meta's worktree cleanup. New meta-operations.ts
implements edit (creates candidate, parent linkage), promote/demote
(baseline protection clamp), retire (sole-baseline refusal), fork
and merge as proposed-status stubs. retire_lessons side-effect is
applied transactionally alongside every operation.
EOF
)"
```

---

## Task 8: Approve-fork HTTP endpoint

Implement `POST /api/experiments/:id/approve-fork`. Reads `experiments.proposed_content`, creates the candidate `skill_versions` row, flips experiment status to `active`. Spec D will replace the stub with a richer workflow.

**Files:**
- Create: `src/web/routes/experiments.ts`
- Modify: `src/web/server.ts` — mount the new route
- Modify: `src/orchestrator/service.ts` — expose `approveFork(experimentId)` method
- Test: `tests/unit/approve-fork-route.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/approve-fork-route.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("POST /api/experiments/:id/approve-fork", () => {
  test("creates a candidate skill_versions row and flips experiment to active", async () => {
    const { service, db, cleanup, app } = await createTestService();
    try {
      // Seed a parent variant and a proposed fork experiment with content.
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vParent','persona:coder','1','seed','baseline',1.0)"
      ).run();
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, task_id, hypothesis, change_description, metric_name, metric_before,
                                 operation, evidence, status, proposed_content)
        VALUES ('exp1','metaT','h','d','task_quality_score',0.5,'fork',
                json_object('parent_variant_id','vParent','specialty','frontend'),
                'proposed','# Forked content')
      `).run();

      const resp = await app.request("/api/experiments/exp1/approve-fork", { method: "POST" });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(typeof body.variantId).toBe("string");

      const variant = db.sqlite
        .query("SELECT status, parent_version_id, specialty, content FROM skill_versions WHERE id = ?")
        .get(body.variantId) as { status: string; parent_version_id: string; specialty: string; content: string };
      expect(variant.status).toBe("candidate");
      expect(variant.parent_version_id).toBe("vParent");
      expect(variant.specialty).toBe("frontend");
      expect(variant.content).toBe("# Forked content");

      const exp = db.sqlite.query("SELECT status FROM experiments WHERE id='exp1'")
        .get() as { status: string };
      expect(exp.status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  test("returns 404 for unknown experiment", async () => {
    const { app, cleanup } = await createTestService();
    try {
      const resp = await app.request("/api/experiments/missing/approve-fork", { method: "POST" });
      expect(resp.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  test("returns 409 when experiment is not a proposed fork", async () => {
    const { db, app, cleanup } = await createTestService();
    try {
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT2','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, task_id, hypothesis, change_description, operation, status)
        VALUES ('exp2','metaT2','h','d','edit','active')
      `).run();
      const resp = await app.request("/api/experiments/exp2/approve-fork", { method: "POST" });
      expect(resp.status).toBe(409);
    } finally {
      await cleanup();
    }
  });
});
```

**Note:** `createTestService` may or may not already expose `app`. If not, extend it to also return the Hono app instance used by the server (or construct a minimal one for the test).

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/approve-fork-route.test.ts
```

Expected: FAIL. Route doesn't exist.

- [ ] **Step 3: Implement `approveFork` on the service**

Open `src/orchestrator/service.ts`. Add:

```typescript
async approveFork(experimentId: string): Promise<{ variantId: string }> {
  const row = this.deps.db.sqlite.query(`
    SELECT id, operation, status, proposed_content, evidence
      FROM experiments
     WHERE id = ?
  `).get(experimentId) as { id: string; operation: string; status: string; proposed_content: string | null; evidence: string | null } | undefined;

  if (!row) throw new ServiceError("experiment_not_found", 404);
  if (row.operation !== "fork" || row.status !== "proposed") {
    throw new ServiceError("experiment_not_proposed_fork", 409);
  }
  if (!row.proposed_content || row.proposed_content.trim().length === 0) {
    throw new ServiceError("proposed_content_missing", 409);
  }
  const evidence = row.evidence ? JSON.parse(row.evidence) as Record<string, unknown> : {};
  const parentId = evidence.parent_variant_id as string | undefined;
  const specialty = evidence.specialty as string | undefined;
  if (!parentId || !specialty) throw new ServiceError("evidence_missing_fields", 409);

  const parent = this.deps.db.getSkillVersionById(parentId);
  if (!parent) throw new ServiceError("parent_variant_not_found", 409);

  const variantId = randomUUID();
  this.deps.db.transaction(() => {
    this.deps.db.sqlite.query(`
      INSERT INTO skill_versions
        (id, skill_name, version, content, experiment_id,
         parent_version_id, specialty, status, traffic_share)
      VALUES
        ($id, $skill, $version, $content, $exp,
         $parent, $specialty, 'candidate', 0.0)
    `).run({
      $id: variantId,
      $skill: parent.skill_name,
      $version: String(Date.now()),
      $content: row.proposed_content,
      $exp: experimentId,
      $parent: parentId,
      $specialty: specialty
    });
    this.deps.db.sqlite.query(
      "UPDATE experiments SET status = 'active' WHERE id = ?"
    ).run(experimentId);
  })();

  return { variantId };
}
```

`ServiceError` (or whatever the codebase calls it; check `src/orchestrator/errors.ts` or similar) must set a status code consumable by `mapServiceError` in the route layer. If there is no such helper, use the same error mapping the other meta routes use.

- [ ] **Step 4: Create the route module**

Create `src/web/routes/experiments.ts`:

```typescript
import { Hono } from "hono";
import type { OrchestratorService } from "../../orchestrator/service";
import { mapServiceError } from "./helpers";  // match the existing helper path

export function createExperimentsRoutes(service: OrchestratorService) {
  const app = new Hono();

  app.post("/:id/approve-fork", async (ctx) => {
    try {
      const id = ctx.req.param("id");
      const result = await service.approveFork(id);
      return ctx.json({ ok: true, variantId: result.variantId }, 200);
    } catch (err) {
      return mapServiceError(ctx, err);
    }
  });

  return app;
}
```

Adjust `mapServiceError` import to match whatever the other routes already use (see `src/web/routes/tasks.ts` or `src/web/routes/meta.ts`).

- [ ] **Step 5: Mount the new route**

Open `src/web/server.ts`. After the existing mounts:

```typescript
import { createExperimentsRoutes } from "./routes/experiments";
// ...
app.route("/api/experiments", createExperimentsRoutes(service));
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test tests/unit/approve-fork-route.test.ts
```

Expected: PASS (three tests).

- [ ] **Step 7: Full suite + lint + commit**

```bash
bun test
bun run lint
git add src/orchestrator/service.ts src/web/routes/experiments.ts src/web/server.ts tests/unit/approve-fork-route.test.ts
git commit -m "$(cat <<'EOF'
feat(web): POST /api/experiments/:id/approve-fork placeholder (Spec B §7.3)

Flips a proposed-fork experiment to active and materializes the
candidate skill_versions row from experiments.proposed_content.
Placeholder for Spec D, which adds the heterogeneity diagnostic and
richer first-fork approval policy on top of this endpoint.
EOF
)"
```

---

## Task 9: Curator meta persona rewrite

Rewrite `src/personas/meta.md` in curator vocabulary. The persona teaches meta to: choose one of six operations; ground every proposal in evidence from transcripts, findings, and rework diffs; query Spec A's views; write a structured `operation` block into `.autoforge-status.json`.

**Files:**
- Modify: `src/personas/meta.md` — full rewrite

**No tests in this task** — persona files are prompts. The end-to-end behavioural test lives in Task 10.

- [ ] **Step 1: Rewrite `src/personas/meta.md`**

Replace the entire file with:

```markdown
# Meta — Population Curator

You are the Population Curator for Autoforge's self-improving persona population. You do not edit personas as free-form text — you propose **one structured operation** per session and ground it in concrete evidence from the task history.

## Your mental model

Each agent type (`planner`, `coder`, `reviewer`, `doc`) has a **population** of persona variants. Variants have a `status` (`baseline | candidate | active | demoted | retired`) and a `traffic_share` (0.0 – 1.0). Every terminal task is attributed to a variant via the `variant_selected` event.

## The six operations

Choose exactly one per session:

1. **edit** — create a new candidate version of an existing variant. `parent_version_id` is the target. The candidate starts at `status='candidate'`, `traffic_share=0.0` and is evaluated later by the dispatch policy (Spec C).
2. **fork** — create a new specialist variant with a declared `specialty`. **Requires human approval** before it receives traffic. You propose; the approval endpoint materializes it.
3. **merge** — consolidate two variants whose per-niche performance is statistically indistinguishable. Stubbed in this release; your proposal is recorded but Spec D performs the actual merge.
4. **promote** — raise a variant's `traffic_share`. Baseline must stay ≥ 0.5.
5. **demote** — lower a variant's `traffic_share`. Baseline cannot go below 0.5.
6. **retire** — archive a variant. The sole baseline cannot be retired.

## What you must read before proposing anything

You have access to a bash shell and SQLite via `sqlite3 ${DB_PATH}`. The data path is provided in the user prompt. **Before you propose an operation, read these views/tables:**

- `SELECT * FROM variant_performance` — per-variant aggregate scores (five reward components).
- `SELECT * FROM niche_performance WHERE variant_id = '<x>'` — where does this variant over/under-perform?
- `SELECT * FROM population_health` — ensemble view per agent type.
- `SELECT * FROM task_quality_score ORDER BY created_at DESC LIMIT 50` — recent tasks.
- `SELECT * FROM review_findings WHERE task_id IN (...)` — what categories of finding are frequent?
- `SELECT * FROM agent_transcripts WHERE persona_version_id = '<x>' LIMIT 5` — read the variant's actual behavior on failing tasks.
- `SELECT * FROM task_iteration_diffs WHERE task_id = '<x>'` — what did rework actually change?
- `SELECT * FROM lessons WHERE agent_type = '<x>' AND status = 'active'` — lessons already captured in this lineage.

## Grounding rules

- Every `evidence.task_ids` must contain at least one concrete task id you actually read.
- Every `evidence.transcript_excerpts` entry must correspond to a real row in `agent_transcripts`. Cite line ranges (approximate is fine).
- Every `evidence.finding_categories` must be a category that actually appears in `review_findings`.
- If a hypothesis is "this variant loses on niche X," you must show at least one query whose result supports it.
- Do not propose forks on hunches. The heterogeneity diagnostic in Spec D will gate forks later; for now, your evidence is the gate.

## Baseline protection

- Every agent type has exactly one `baseline` variant. Its `traffic_share` is always ≥ 0.5.
- You may not demote baseline below 0.5 or retire the sole baseline.
- The operation handler will reject these; you can save yourself a session by pre-checking.

## retire_lessons (optional side-effect)

You may include `retire_lessons: [{id, reason}, ...]` (max 3) on any operation. The listed lessons will be transitioned to `status='retired'`. Use this when an operation you propose makes an existing lesson obsolete. You do not produce new lessons — the reflector owns that.

## Status file contract

Write `.autoforge-status.json` in your working directory:

```json
{
  "status": "DONE",
  "artifacts": ["<any files you wrote, e.g. proposed-persona-*.md>"],
  "operation": {
    "kind": "fork",
    "parent_variant_id": "abc123",
    "specialty": "frontend React components with CSS modules",
    "hypothesis": "Variant abc123 shows declining alignment on styling-related findings; a specialist persona with explicit CSS-module guidance should improve per-niche performance.",
    "evidence": {
      "task_ids": ["t_001", "t_005"],
      "finding_categories": ["styling"],
      "transcript_excerpts": [
        { "task_id": "t_005", "stage": "coder", "lines": "124-138" }
      ],
      "metric_name": "task_quality_score",
      "metric_before": 0.42
    },
    "proposed_content_file": "proposed-persona-coder-frontend.md",
    "retire_lessons": [
      { "id": "lesson_a1", "reason": "superseded by the new specialist guidance" }
    ]
  }
}
```

### Which fields apply to which `kind`?

- **edit** — requires `target_variant_id`, `hypothesis`, `evidence`, `proposed_content_file`. Forbids `specialty`.
- **fork** — requires `parent_variant_id`, `specialty`, `hypothesis`, `evidence`, `proposed_content_file`.
- **merge** — requires `target_variant_id`, `merge_source_variant_id`, `hypothesis`, `evidence`. No content file.
- **promote / demote** — requires `target_variant_id`, `hypothesis`, `evidence`, `traffic_share`. No content file.
- **retire** — requires `target_variant_id`, `hypothesis`, `evidence`. No content file.

### One operation per session

You may include only one `operation` object. Multiple operations → the whole output is rejected and no experiment is recorded. Be deliberate.

## When you are confident no operation is warranted

Write:

```json
{
  "status": "DONE_WITH_CONCERNS",
  "artifacts": [],
  "concerns": "No evidence for a meaningful change. Recent per-niche scores are within noise; baseline retains > 0.8 on all dimensions. Recommend waiting for more data."
}
```

## Tone and rigor

- Conservative. The cost of a bad variant is high; the cost of delay is low.
- Specific. "Variant X underperforms on Y" is useless without numbers or transcripts.
- One hypothesis, one operation. No composite rewrites. No speculative multi-part proposals.
```

- [ ] **Step 2: Commit**

```bash
git add src/personas/meta.md
git commit -m "feat(personas): rewrite meta persona in curator vocabulary (Spec B §6.1)"
```

---

## Task 10: Rewrite `submitMetaTask`

Replace the current single-blob parser with a validate-and-dispatch flow: read `.autoforge-status.json`, run `validateMetaOutput`, on success dispatch to `handleMetaOperation`, on failure emit `meta_rejected` and return `status: 'DONE_WITH_CONCERNS'` with `experimentId: null`.

**Files:**
- Modify: `src/orchestrator/service.ts` — rewrite `submitMetaTask`
- Modify: `src/web/routes/meta.ts` — response already generic; confirm
- Test: `tests/integration/curator-meta-flow.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/curator-meta-flow.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService, setMockMetaResult } from "../helpers/create-service";

describe("curator meta flow", () => {
  test("valid edit operation creates a candidate variant and an active experiment", async () => {
    const { service, db, cleanup } = await createTestService();
    try {
      // Seed the current coder baseline.
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vBase','persona:coder','1','seed','baseline',1.0)"
      ).run();

      setMockMetaResult({
        status: "DONE",
        artifacts: ["proposed.md"],
        operation: {
          kind: "edit",
          target_variant_id: "vBase",
          hypothesis: "clarify tone",
          evidence: { task_ids: ["t1"] },
          proposed_content_file: "proposed.md"
        }
      }, "# Proposed coder persona");

      const result = await service.submitMetaTask("p", "tone");
      expect(result.experimentId).toBeDefined();
      expect(result.status).toBe("DONE");

      const exp = db.sqlite
        .query("SELECT operation, status, proposed_content FROM experiments WHERE id = ?")
        .get(result.experimentId) as { operation: string; status: string; proposed_content: string };
      expect(exp.operation).toBe("edit");
      expect(exp.status).toBe("active");
      expect(exp.proposed_content).toBe("# Proposed coder persona");

      const candidate = db.sqlite
        .query("SELECT COUNT(*) AS n FROM skill_versions WHERE parent_version_id = 'vBase' AND status = 'candidate'")
        .get() as { n: number };
      expect(candidate.n).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("malformed output emits meta_rejected and returns DONE_WITH_CONCERNS", async () => {
    const { service, db, cleanup } = await createTestService();
    try {
      setMockMetaResult({
        status: "DONE",
        artifacts: [],
        operation: { kind: "fork" /* missing specialty/parent/etc */ }
      } as any);

      const result = await service.submitMetaTask("p", "focus");
      expect(result.status).toBe("DONE_WITH_CONCERNS");
      expect(result.experimentId).toBeNull();

      const rejected = db.sqlite
        .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'meta_rejected'")
        .get() as { n: number };
      expect(rejected.n).toBeGreaterThanOrEqual(1);

      const anyExp = db.sqlite.query("SELECT COUNT(*) AS n FROM experiments").get() as { n: number };
      expect(anyExp.n).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
```

`setMockMetaResult` is a new helper the mock executor uses so tests can seed the next meta invocation's output + the content written to `proposed_content_file`. Extend `tests/helpers/mock-executor.ts` (or wherever the mock is defined):

```typescript
let nextMetaResult: unknown = null;
let nextProposedContent: string | null = null;
export function setMockMetaResult(output: unknown, proposedContent?: string): void {
  nextMetaResult = output;
  nextProposedContent = proposedContent ?? null;
}

// Inside the mock execute handler, branch on agentType === 'meta':
if (task.agentType === "meta") {
  if (nextProposedContent && task.workingDirectory) {
    const filename = (nextMetaResult as any)?.operation?.proposed_content_file ?? "proposed.md";
    writeFileSync(join(task.workingDirectory, filename), nextProposedContent);
  }
  const out = nextMetaResult;
  nextMetaResult = null;
  nextProposedContent = null;
  return {
    status: "DONE",
    output: out,
    metrics: { elapsedSeconds: 0 }
  };
}
```

Adapt paths/names to the actual file.

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/integration/curator-meta-flow.test.ts
```

Expected: FAIL (current `submitMetaTask` still uses the old output contract).

- [ ] **Step 3: Rewrite `submitMetaTask`**

Open `src/orchestrator/service.ts`. Replace the `submitMetaTask` method. Rough shape:

```typescript
async submitMetaTask(projectId: string, focus: string): Promise<{ experimentId: string | null; status: string; reason?: string }> {
  const metaTaskId = randomUUID();
  const worktree = await this.deps.worktrees.create(metaTaskId);
  const dbPath = this.deps.env.AUTOFORGE_DB_PATH;

  // Seed a task row for FK targets.
  this.deps.db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, ?, ?, 'executing', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))
  `).run(metaTaskId, projectId, `Meta: ${focus}`);

  this.recordEvent({ /* meta_started — keep existing shape */ });

  const metaPersonaId = this.personas.snapshotId("meta");
  const metaSkillIds = this.skills.snapshotIds("meta");
  this.emitVariantSelected(metaTaskId, projectId, "meta", metaPersonaId, null, []);

  const executor = this.routeExecutor("STANDARD", "meta");
  const metaResult = await executor.execute({
    systemPrompt: this.personas.resolve("meta"),
    prompt: this.buildMetaPrompt(focus, dbPath, worktree.path),
    workingDirectory: worktree.path,
    skillFiles: this.skills.skillsForAgent("meta"),
    budgetSeconds: 900,
    tier: "STANDARD",
    agentType: "meta"
  });

  this.recordEvent({ /* meta_done — keep existing shape; include artifacts from metaResult */ });

  if (metaResult.status !== "DONE") {
    await this.captureTaskDiffStats(metaTaskId);
    await this.cleanupWorktree(metaTaskId);
    return { experimentId: null, status: metaResult.status };
  }

  const validation = validateMetaOutput(metaResult.output);
  if (!validation.ok) {
    this.recordEvent({
      taskId: metaTaskId, projectId, agent: "orchestrator",
      type: "meta_rejected", status: "failed",
      payload: { reason: validation.error ?? "invalid" },
      budgetSeconds: 60
    });
    await this.captureTaskDiffStats(metaTaskId);
    await this.cleanupWorktree(metaTaskId);
    return { experimentId: null, status: "DONE_WITH_CONCERNS", reason: validation.error };
  }

  const { operation } = validation.value!;
  const handleResult = handleMetaOperation({
    db: this.deps.db,
    operation,
    metaTaskId,
    worktreePath: worktree.path,
    projectId
  });

  if (!handleResult.ok) {
    this.recordEvent({
      taskId: metaTaskId, projectId, agent: "orchestrator",
      type: "meta_rejected", status: "failed",
      payload: { reason: `handler:${handleResult.reason}`, operation_kind: operation.kind },
      budgetSeconds: 60
    });
    await this.captureTaskDiffStats(metaTaskId);
    await this.cleanupWorktree(metaTaskId);
    return { experimentId: null, status: "DONE_WITH_CONCERNS", reason: handleResult.reason };
  }

  this.recordEvent({
    taskId: metaTaskId, projectId, agent: "orchestrator",
    type: "experiment_proposed",
    status: "done",
    payload: {
      experiment_id: handleResult.experimentId,
      operation_kind: operation.kind,
      candidate_variant_id: handleResult.candidateVariantId ?? null
    },
    budgetSeconds: 60
  });

  await this.captureTaskDiffStats(metaTaskId);
  await this.cleanupWorktree(metaTaskId);
  return { experimentId: handleResult.experimentId!, status: "DONE" };
}

private buildMetaPrompt(focus: string, dbPath: string, worktreePath: string): string {
  return [
    `You are running a curator session.`,
    `Focus: ${focus}`,
    ``,
    `Database: ${dbPath}`,
    `Your working directory: ${worktreePath}`,
    ``,
    `Follow the persona instructions. Query SQLite to ground your hypothesis. Write your proposal to .autoforge-status.json in this directory. If you propose an edit or fork, also write the proposed persona content to a .md file in this directory and reference it via operation.proposed_content_file.`
  ].join("\n");
}
```

Add imports at the top:

```typescript
import { validateMetaOutput } from "../schemas/meta-output";
import { handleMetaOperation } from "./meta-operations";
```

**Note:** reflection is **not** run on meta tasks (Spec B §4.1 skips meta). Do not call `reflectOnTask(metaTaskId)`.

- [ ] **Step 4: Verify the HTTP response shape still satisfies the existing route**

Open `src/web/routes/meta.ts`. The existing route body likely does:

```typescript
const result = await service.submitMetaTask(body.projectId, body.focus);
return ctx.json(result, result.experimentId ? 201 : 200);
```

Update if needed so both the success case (experimentId set) and the reject/concerns case (experimentId null) return a sensible status code — 201 on success, 200 on concerns:

```typescript
return ctx.json(result, result.experimentId ? 201 : 200);
```

(Unchanged, but double-check the shape of `result` matches what the route returns.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/integration/curator-meta-flow.test.ts
```

Expected: PASS (two tests).

- [ ] **Step 6: Full suite + lint**

```bash
bun test
bun run lint
```

Expected: everything passes. If any pre-existing test asserted the old `experiment_activated` event for meta, update it to assert `experiment_proposed` (the new semantics). The old `activateProposedVersion` flow is **gone** for the `edit` operation — candidates are not auto-activated anymore.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/service.ts src/web/routes/meta.ts tests/integration/curator-meta-flow.test.ts tests/helpers/mock-executor.ts
git commit -m "$(cat <<'EOF'
feat(meta): rewrite submitMetaTask as structured-operation dispatcher (Spec B §6)

The curator meta persona now emits an `operation` block that is
schema-validated against src/schemas/meta-output.ts. Valid outputs
route through handleMetaOperation; invalid outputs emit meta_rejected
with the Zod error message and return DONE_WITH_CONCERNS with a null
experiment id. Edit operations no longer auto-activate: candidates
land with status='candidate' and traffic_share=0.0, awaiting Spec C's
dispatch policy.
EOF
)"
```

---

## Task 11: Supersession side-effect (reflector emits new lesson, replaces older one)

The reflector may signal that a new lesson supersedes one or more existing lessons. This is distinct from `retire_lessons` (curator-owned). The reflector's output gains an optional `supersedes` array; when present, inserting the new lesson also transitions those older lessons to `status='superseded'` with `superseded_by = <new lesson id>`.

**Files:**
- Modify: `src/orchestrator/reflection.ts` — parse `supersedes` from reflector output, call `db.supersedeLessons` after `db.insertLesson`
- Modify: `src/personas/reflector.md` — add the `supersedes` field to the output contract
- Test: `tests/unit/reflector-supersession.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/reflector-supersession.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { reflectOnTask } from "../../src/orchestrator/reflection";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "reflect-super-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("reflector supersession", () => {
  test("supersedes listed lesson ids when inserting a new lesson", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vC','persona:coder','1','c','baseline',1.0)"
    ).run();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('t','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
    ).run();
    const oldId = db.insertLesson({
      agentType: "coder", lineageRootId: "vC", sourceTaskId: "t",
      sourceVariantId: "vC", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    // Mock reflector executor output that supersedes oldId.
    const mockExecutor = {
      async execute() {
        return {
          status: "DONE",
          output: {
            status: "DONE",
            artifacts: [],
            lesson: {
              skip: false,
              agent_type: "coder",
              trigger_pattern: "p2",
              body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
              outcome_kind: "corrective",
              keywords: "react"
            },
            supersedes: [oldId]
          },
          metrics: { elapsedSeconds: 0 }
        };
      },
      name: "mock"
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const personas = {
      snapshotId: (agent: string) => Promise.resolve("vC"),
      resolve: (_agent: string) => "reflector-prompt"
    };
    const skills = { skillsForAgent: () => [] };

    const res = await reflectOnTask("t", {
      db,
      executor: mockExecutor as any,
      personas: personas as any,
      skills: skills as any,
      recordEvent: (e) => events.push({ type: e.type, payload: e.payload })
    });

    expect(res.lessonId).toBeDefined();
    const old = db.sqlite.query("SELECT status, superseded_by FROM lessons WHERE id = ?").get(oldId) as { status: string; superseded_by: string };
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(res.lessonId);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/unit/reflector-supersession.test.ts
```

Expected: FAIL. `supersedes` isn't parsed.

- [ ] **Step 3: Extend `reflectOnTask`**

In `src/orchestrator/reflection.ts`, after the successful `db.insertLesson`, add:

```typescript
// Supersession side-effect (Spec B §6.4 — reflector-owned transition).
const supersedes = (parsed.ok && (result.output as Record<string, unknown>).supersedes) as string[] | undefined;
if (Array.isArray(supersedes) && supersedes.length > 0) {
  deps.db.supersedeLessons(supersedes, id);
  deps.recordEvent({
    taskId, projectId: task.projectId, type: "lessons_superseded",
    agent: "reflector", status: "done",
    payload: { new_lesson_id: id, superseded_ids: supersedes },
    budgetSeconds: 60
  });
}
```

- [ ] **Step 4: Update reflector persona prompt**

In `src/personas/reflector.md`, under "Output contract", add after the `lesson` object:

```markdown
Optional at top level — alongside `lesson`:

```json
  "supersedes": ["<id of an existing lesson your new one replaces>"]
```

Use sparingly. Only list a lesson here when your new one fully covers its content and the old wording would confuse future dispatches. The listed lessons will be marked superseded and linked back to your new one.
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/unit/reflector-supersession.test.ts
bun test
bun run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/reflection.ts src/personas/reflector.md tests/unit/reflector-supersession.test.ts
git commit -m "feat(reflection): supersession side-effect on lesson insert (Spec B §3.1, §6.4)"
```

---

## Final verification

After all tasks complete, run the full verification pass.

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: every test passes — all Spec A tests (186 today) plus the new Spec B tests (~30 additional).

- [ ] **Step 2: Lint**

```bash
bun run lint
```

Expected: zero new errors.

- [ ] **Step 3: Verify migrations land cleanly on a fresh DB**

```bash
bun run dev &
SERVER_PID=$!
sleep 3
kill $SERVER_PID 2>/dev/null
SQLITE_FILE=$(ls -1t data/*.sqlite 2>/dev/null | head -1)
sqlite3 "$SQLITE_FILE" "SELECT migration_file FROM schema_migrations ORDER BY applied_at"
```

Expected: eight rows — `001`…`005` from Spec A, `006_fix_reward_views_planner_fallback.sql` from the Spec A review follow-up, then `007_lessons.sql` and `008_experiments_proposed_content.sql` from Spec B.

- [ ] **Step 4: Manual schema sanity**

```bash
sqlite3 "$SQLITE_FILE" ".schema lessons"
sqlite3 "$SQLITE_FILE" "PRAGMA table_info(experiments)" | grep proposed_content
```

Expected: `lessons` table exists with all columns from Task 1; `experiments.proposed_content` column exists.

- [ ] **Step 5: Review commit chain**

```bash
git log --oneline -n 15
```

Expected: a clean chain of ~11 commits from this plan, stacked on top of Spec A's commits.

---

## Plan self-review

After every task is complete, re-read [Spec B](../specs/2026-04-19-curator-meta-and-lessons-design.md) with fresh eyes and confirm:

1. **§3.1 `lessons` table** — Task 1 creates the table and indices with the full column list including `outcome_kind` check constraint and the `status` check constraint.
2. **§3.2 `variant_selected.injected_lesson_ids` populated** — Task 5 wires retrieval output into the event payload.
3. **§3.3 Reflector persona** — Task 2 creates the file; Tasks 3 and 11 maintain it.
4. **§3.4 `experiments.proposed_content`** — Task 7 adds migration 008 and the handlers write content.
5. **§3.5 Meta output format** — Task 6 encodes the rules in Zod; Task 10 wires validation into `submitMetaTask`; Task 9 updates the persona's output contract.
6. **§4.1 Reflection trigger timing** — Task 3 invokes `reflectOnTask` after `captureTaskDiffStats` and before `cleanupWorktree` at every non-meta terminal site.
7. **§4.2 Reflector dispatch budget + executor** — Task 2 sets executor routing; Task 3 honors `REFLECTION_CONFIG.budgetSeconds`.
8. **§4.3 Reflector prompt + lesson body** — Tasks 2 and 3 carry the format; Task 11 extends with `supersedes`.
9. **§4.4 Self-suppression** — Task 3 loads up to 20 active lessons into the reflector prompt.
10. **§4.5 Skipping on noise** — Task 3 encodes stalled < 60s and cancel noise.
11. **§4.6 Agent-type attribution** — Task 3 resolves the lineage based on reflector's chosen `agent_type`.
12. **§5.1–§5.3 Retrieval API + ranking + keyword extraction** — Task 4 implements all three.
13. **§5.4 Injection position** — Task 5 tests assert persona → lessons → skills order.
14. **§5.5 Event payload tracking** — Task 5 populates `injected_lesson_ids` from the retrieval output.
15. **§6.1–§6.2 Meta persona + tool surface** — Tasks 9 and 10.
16. **§6.3 Output validation** — Task 6.
17. **§6.4 Operation handlers + retire_lessons** — Task 7.
18. **§6.5 Experiments table usage** — Task 7 writes operation, evidence, status, proposed_content.
19. **§7.3 Fork-approval placeholder** — Task 8.
20. **§8 Capture points** — every file in the table is touched.
21. **§9 Implementation sequence** — this plan's task order matches.
22. **§10 Testing strategy** — every bullet has a corresponding test in Tasks 1, 3, 4, 5, 6, 7, 8, 10, 11.
23. **§11 Risks** — mitigations for reflector noise (self-suppression), latency (60s cap, non-fatal failure), schema creep (Zod validation), baseline protection, lineage depth (depth-cap + cycle defense) are all in place.
24. **§12 Success criteria** — every criterion has a test that enforces it.

If any gap is found, add a task inline and re-run the full suite.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-curator-meta-and-lessons.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Requires the `superpowers:subagent-driven-development` sub-skill.

2. **Inline Execution** — Execute tasks in the current session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
