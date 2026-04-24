# Spec A — Observability and Reward Foundation

**Status:** Proposed
**Date:** 2026-04-19
**Parent:** [`2026-04-19-self-improving-persona-population-design.md`](./2026-04-19-self-improving-persona-population-design.md)
**Scope:** Layers 1 and 2 of the umbrella. Completes failure-analysis observability, introduces the population-shaped schema, captures diff stats, makes transcripts joinable to variants, and implements the composite reward function as SQL views plus a weight configuration surface.

---

## 1. Purpose and success

Spec A delivers the data foundation that every later spec depends on. Concretely, after Spec A ships:

- Every terminal task has a computed `task_quality_score` row available in SQL.
- Per-variant and per-niche aggregates are queryable without manual joins.
- Failure events carry a structured `failure_category` and variant provenance.
- `skill_versions` has the columns needed for Spec C to allocate traffic and Spec D to reason about lineage.
- `agent_transcripts` rows are joinable to a specific variant, so Spec B's meta persona can read failed traces by variant.

Nothing in this spec is user-facing beyond new SQL surfaces and one configuration file. The dashboard is untouched (follow-on).

---

## 2. Scope

**In scope**
- `failure_analysis` event emission and payload contract
- Tool-use stats (read/write/bash counts) captured by the SDK executor and passed through to events
- New `task_diff_stats` table, populated at task completion
- New columns on `skill_versions` for population semantics
- New columns on `agent_transcripts` for variant joinability
- New columns on `experiments` for operation type and evidence
- A numbered SQL migrations mechanism (does not exist today)
- New event type `variant_selected` emitted per task at dispatch
- Reward weight configuration file and loader
- Four new SQL views: `task_quality_score`, `variant_performance`, `niche_performance`, `population_health`
- Tests covering schema migration, reward computation on fixture tasks, and event emission

**Out of scope (owned by later specs or deferred)**
- Variant selection / dispatch policy (Spec C)
- Lessons table, auto-reflection, retrieval at dispatch (Spec B)
- Heterogeneity diagnostic, merging, routing classifier (Spec D)
- Dashboard surface for population health, lineage, or approvals (follow-on)
- Normalization of `review_findings.category` into a canonical enum (explicitly deferred — see §5.3)
- Backfilling historical rows with synthetic reward scores (can be computed lazily by the view)

---

## 3. Migrations mechanism

Autoforge currently has no formal migrations story — `DbClient.initSchema()` runs `schema.sql` idempotently (relying on `CREATE ... IF NOT EXISTS`) plus a single ad-hoc `ALTER TABLE` for `archived_at`. That pattern does not scale to column additions across multiple tables.

**Design.**
- New directory `src/db/migrations/` holds numbered SQL files: `001_population_schema.sql`, `002_task_diff_stats.sql`, `003_transcripts_variant.sql`, `004_experiments_evidence.sql`, `005_reward_views.sql`.
- Each file contains forward-only statements (CREATE, ALTER, DROP VIEW / CREATE VIEW for view replacements). View files always `DROP VIEW IF EXISTS` then `CREATE VIEW` so edits to existing views are applied on re-run.
- A new `schema_migrations` table records which files have run, keyed by filename. Same WAL database.
- `initSchema()` is extended to: (a) run the base `schema.sql` (unchanged contract), (b) then run any migration file not yet in `schema_migrations`, in filename order, each in its own transaction, (c) record success.
- Base `schema.sql` stays the authoritative "what the schema should look like today" reference — after a migration lands, its effect is folded into `schema.sql` on a subsequent cleanup PR so fresh databases skip the migration chain. The `schema_migrations` table records the migration as already applied for fresh installs (via an idempotent INSERT against `migration_file`).
- The existing one-off `archived_at` ALTER stays in `initSchema()` for now; it is removed in a housekeeping PR after Spec A lands.

**Why forward-only.** Rollback migrations are disproportionate complexity for a single-node SQLite application. If a migration is wrong, the fix is the next migration.

**Failure mode.** A migration that fails mid-file leaves `schema_migrations` without the entry. Next startup retries. Because each migration runs in a transaction, partial application is not possible.

---

## 4. Schema changes

### 4.1 `skill_versions`

Adds four columns:

| Column | Type | Default (for new inserts) | Purpose |
|---|---|---|---|
| `parent_version_id` | TEXT | NULL | Lineage pointer to parent `skill_versions.id`; NULL for seed rows (file-on-disk originals) |
| `specialty` | TEXT | NULL | Free-text description of the variant's intended niche; NULL for generalists |
| `status` | TEXT | `'candidate'` | Traffic-allocation role: `baseline \| candidate \| active \| demoted \| retired`. Chose `candidate` as the safe default so code that inserts a row without specifying `status` never accidentally promotes it to production traffic |
| `traffic_share` | REAL | `0.0` | Allocation hint consumed by Spec C's dispatch policy; 0.0 – 1.0. Safe default of `0.0` for the same reason |

**Backfill on migration (one-time UPDATE, separate from column DEFAULTs).**
- For each distinct `skill_name`, pick the row with `is_active = 1` (if several exist, pick the one with the most recent `created_at` — defensive; shouldn't happen but a previous registry bug could have produced it, and the migration logs a warning for each `skill_name` where it occurs). Set `status = 'baseline'`, `traffic_share = 1.0` on that row.
- All other rows: `status = 'demoted'`, `traffic_share = 0.0`.
- `parent_version_id` and `specialty` remain NULL on all backfilled rows.
- `is_active` is retained as a regular column and kept in sync with `status` by triggers — see §4.6.

### 4.2 `experiments`

Adds two columns:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `operation` | TEXT | `'edit'` | One of `edit \| fork \| merge \| promote \| demote \| retire` |
| `evidence` | TEXT | NULL | JSON citation of artifacts justifying the operation (failing task ids, finding categories, transcript excerpts) |

Existing experiment rows are backfilled with `operation = 'edit'`, `evidence = NULL`.

### 4.3 `agent_transcripts`

Adds one column:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `persona_version_id` | TEXT | NULL | Variant id, captured at insert time from the same source events use |

**Backfill.** For each existing transcript row, look up the event with matching `task_id + stage + attempt`, extract `persona_version_id` from its payload. If no matching event exists (old rows, incomplete data), leave NULL and log a count at migration end.

### 4.4 `task_diff_stats` and `task_iteration_diffs` (new tables)

Two related tables, both populated from git operations against the task's worktree. Captured in the same migration (`002_task_diff_stats.sql`).

#### 4.4.1 `task_diff_stats` — whole-task cumulative diff

Populated once per task when the task transitions to a terminal state and a worktree still exists. One row per task. Answers "how big is the final solution."

```sql
CREATE TABLE IF NOT EXISTS task_diff_stats (
  task_id        TEXT PRIMARY KEY REFERENCES tasks(id),
  files_changed  INTEGER NOT NULL,
  files_added    INTEGER NOT NULL,
  files_modified INTEGER NOT NULL,
  files_deleted  INTEGER NOT NULL,
  lines_added    INTEGER NOT NULL,
  lines_deleted  INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  captured_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Capture mechanism.** A new helper `computeDiffStats(worktreePath, baseRef)` in `src/orchestrator/diff-stats.ts` runs `git diff --numstat <baseRef>...HEAD` inside the worktree and parses its output. Called from `OrchestratorService` immediately before `cleanupWorktree(taskId)` on both success and failure paths. `test_files_changed` is derived by path match against `**/*.test.*` and `**/tests/**`.

**Failure mode.** If git fails (not a git worktree, diff fails, worktree already cleaned), log a warning and skip the insert. The `task_quality_score` view treats a missing `task_diff_stats` row as `simplicity = 0.5` (neutral) — not zero — so absence doesn't punish a task that merely had no repo access.

#### 4.4.2 `task_iteration_diffs` — between-iteration delta

Populated once per rework transition. One row per `(task_id, from_iteration → to_iteration)` pair. Answers "what did the rework change" — exactly the signal Spec B's reflector needs to extract corrective lessons from reworks.

```sql
CREATE TABLE IF NOT EXISTS task_iteration_diffs (
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  from_iteration  INTEGER NOT NULL,
  to_iteration    INTEGER NOT NULL,
  files_changed   INTEGER NOT NULL,
  lines_added     INTEGER NOT NULL,
  lines_deleted   INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  diff_summary    TEXT,               -- optional short text snippet (≤ 500 chars) of the diff itself for reflector context
  captured_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, from_iteration, to_iteration)
);

CREATE INDEX IF NOT EXISTS idx_task_iteration_diffs_task
  ON task_iteration_diffs(task_id);
```

**Capture mechanism.** The orchestrator's rework loop already commits the coder's changes per iteration (today's behavior). Each commit becomes a natural checkpoint. At the start of each new iteration `N+1`, a helper `computeIterationDiff(worktreePath, fromIter, toIter)` runs `git diff --numstat <iter-N-commit>..<iter-N+1-starting-commit>` and inserts one row. If iteration N+1 starts at the same commit as iteration N (no coder commit happened), skip the insert (no delta to record).

**Rationale for both tables.** `task_diff_stats` answers the simplicity reward term (how big is the final solution); `task_iteration_diffs` is the reflector's primary supervision signal for rework lessons. Keeping them separate avoids conflating "final cumulative" with "per-iteration delta" in downstream queries.

**Failure mode.** If git fails for a specific iteration transition (e.g., the coder never committed), skip that row; subsequent transitions still get captured. The reflector handles NULL / missing rows gracefully (it simply gets less precise inter-iteration context).

### 4.5 `schema_migrations` (new table, added to base `schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_file TEXT PRIMARY KEY,
  applied_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.6 `is_active` compatibility

`is_active` remains a real column. A trigger keeps it in sync with `status` so callers that still read `is_active` do not break:

```sql
CREATE TRIGGER IF NOT EXISTS skill_versions_is_active_sync
AFTER UPDATE OF status ON skill_versions
BEGIN
  UPDATE skill_versions
  SET is_active = CASE WHEN NEW.status IN ('baseline','active') THEN 1 ELSE 0 END
  WHERE id = NEW.id;
END;
```

A parallel trigger runs on INSERT. In a follow-on cleanup after Spec C lands, `is_active` references in code are replaced with `status` reads and the column is dropped.

---

## 5. Events

### 5.1 `failure_analysis`

Absorbs the design already written in [`docs/design/observability-and-recovery.md`](../../design/observability-and-recovery.md) §"What we need: failure_analysis events". Summary of the payload contract:

```json
{
  "stage_failed": "executing",
  "failure_reason": "stall",
  "failure_category": "executor_timeout | coder_failed | rework_limit | pr_gate | cancelled | planner_fallback | stalled",
  "executor_used": "anthropic-sdk | claude-code | mock",
  "persona_version_id": "b5b6074...",
  "skill_version_ids": ["c4d2e1..."],
  "tool_stats": { "read_count": 12, "write_count": 0, "bash_count": 3, "iterations": 23 },
  "planner_fallback": true,
  "budget_seconds": 720,
  "elapsed_seconds": 960,
  "iteration": 0
}
```

Emission points: (a) alongside `state.failed` transitions, (b) from the staleness sweeper, (c) from `cancelTask`. `tool_stats` is populated by the SDK executor (extends `AgentResult.metrics`) and is NULL for Claude Code.

### 5.2 `variant_selected` (new event)

Emitted at every agent dispatch. Spec A defines the payload; Spec C produces the routing decisions that populate it. In Spec A, this event is emitted by a trivial stub that records the single active variant for each agent type needed by the task — sufficient for downstream views to join cleanly once Spec C lights up real allocation.

**Emission cardinality.** One event per dispatch means one per `(task, agent_type, iteration)` tuple — the planner fires once per planner run, the coder fires once per subtask per iteration, the reviewer once per review, and so on. A multi-subtask rework task therefore emits many `variant_selected` events for the coder agent type. This is deliberate: emission is the atomic unit of "a variant was asked to do work." Consumers that need per-task aggregates must deduplicate — `variant_performance` does so with `SELECT DISTINCT task_id, variant_id, agent_type` (see §6.3), and any future Spec C allocation-telemetry query should follow the same pattern. Do not count rows in `events WHERE event_type = 'variant_selected'` as a proxy for task count.

```json
{
  "agent_type": "coder",
  "selected_variant_id": "abc123",
  "selected_variant_specialty": null,
  "eligible_variant_ids": ["abc123"],
  "selection_rationale": "only_eligible",
  "shadow_variant_ids": []
}
```

`selection_rationale` values (reserved for Spec C): `only_eligible | baseline | exploitation | exploration | shadow_parallel`. Spec A always emits `only_eligible` and always emits `shadow_variant_ids: []` — the fields are defined now so Spec C does not have to migrate payload consumers when it lights up real allocation.

### 5.3 Finding categories

Current `review_findings.category` is free text. Normalizing to an enum is **deferred** — it needs a migration pass over historical data and a source-of-truth list, which is better owned by Spec B where the categories actually drive hypothesis generation.

Spec A works around this by computing `alignment` (§6) from the finding *severity* only (`CRITICAL` / `MAJOR` count) rather than category, exactly as the Q1 strawman noted. `niche_performance` groups by category as-is (free text); users who want cleaner groupings query the view with their own CASE expressions until Spec B normalizes.

---

## 6. Reward function

### 6.1 Per-task score

Implemented as a view joining `task_outcomes` (existing), `task_diff_stats`, and a subquery over `events` for planner and fidelity signals.

```sql
CREATE VIEW IF NOT EXISTS task_quality_score AS
SELECT
  t.id AS task_id,
  t.project_id,
  t.tier,

  -- correctness: 1 if completed with no blocking findings, else 0
  CASE WHEN t.state = 'completed' AND COALESCE(o.blocking_finding_count, 0) = 0
       THEN 1.0 ELSE 0.0 END                                   AS r_correctness,

  -- simplicity: 1 / (1 + lines_changed / tier_baseline)
  -- baseline from a CTE constant table; 0.5 if stats missing
  CASE
    WHEN d.task_id IS NULL THEN 0.5
    ELSE 1.0 / (1.0 + (CAST(d.lines_added + d.lines_deleted AS REAL)
                       / CASE t.tier WHEN 'EXPRESS' THEN 50.0
                                     WHEN 'STANDARD' THEN 200.0
                                     WHEN 'THOROUGH' THEN 800.0
                                     ELSE 200.0 END))
  END                                                          AS r_simplicity,

  -- alignment (Spec A MVP): 1 − (critical_findings / max(total_findings, 1))
  CASE WHEN COALESCE(o.finding_count, 0) = 0 THEN 1.0
       ELSE 1.0 - (CAST(o.blocking_finding_count AS REAL)
                   / CAST(o.finding_count AS REAL))
  END                                                          AS r_alignment,

  -- fidelity: 0.5 * (1 − planner_fallback) + 0.5 * (1 − scope_drift)
  -- planner_fallback from failure_analysis events; scope_drift from subtask counts
  0.5 * (1.0 - COALESCE(fa.planner_fallback, 0))
    + 0.5 * (1.0 - sd.scope_drift)                             AS r_fidelity,

  -- efficiency: 0.5 * cost term + 0.5 * iteration term
  0.5 * (1.0 / (1.0 + COALESCE(o.total_cost, 0.0)
                      / CASE t.tier WHEN 'EXPRESS' THEN 0.50
                                    WHEN 'STANDARD' THEN 2.00
                                    WHEN 'THOROUGH' THEN 8.00
                                    ELSE 2.00 END))
    + 0.5 * (1.0 / (1.0 + t.iteration))                        AS r_efficiency,

  -- composite applied at query time using weights from config
  -- (weights are not in the view; the view emits the five components)
  t.created_at
FROM tasks t
LEFT JOIN task_outcomes o ON o.task_id = t.id
LEFT JOIN task_diff_stats d ON d.task_id = t.id
LEFT JOIN (
  SELECT task_id,
         MAX(json_extract(payload, '$.planner_fallback')) AS planner_fallback
  FROM events
  WHERE event_type = 'failure_analysis'
  GROUP BY task_id
) fa ON fa.task_id = t.id
LEFT JOIN (
  SELECT t2.id AS task_id,
         CASE WHEN (SELECT COUNT(*) FROM subtasks WHERE task_id = t2.id) >
                   1.3 * COALESCE(NULLIF(json_extract(t2.plan, '$.subtask_count'), ''), 0)
              THEN 1.0 ELSE 0.0 END AS scope_drift
  FROM tasks t2
) sd ON sd.task_id = t.id
WHERE t.state IN ('completed', 'failed');
```

**Why the view emits the five components, not the composite.** Weights are tunable configuration. Hard-coding them into the view means every weight change requires a schema change. The composite is computed by callers using the current weight set (§6.2).

### 6.2 Weight configuration

A single JSON file at `src/config/reward-weights.json`:

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

Loaded at orchestrator startup via a new `src/config/reward.ts` module exposing `getRewardWeights(): Record<string, number>` and `computeComposite(components): number`. Weights must sum to 1.0 (validator throws at startup if not).

Overrides at runtime (for MVP): none. Weight changes require a code change + restart. A DB-backed weights table with history is a follow-on; Spec D will revisit if it becomes needed.

### 6.3 Aggregate views

```sql
CREATE VIEW IF NOT EXISTS variant_performance AS
SELECT
  e.variant_id,
  sv.skill_name AS variant_name,
  sv.specialty,
  sv.status,
  e.agent_type,
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
) e
JOIN task_quality_score tqs ON tqs.task_id = e.task_id
JOIN skill_versions sv ON sv.id = e.variant_id
GROUP BY e.variant_id, e.agent_type;
```

`niche_performance` is the same shape with extra `GROUP BY` dimensions (tier, project_id, and a joined review-finding category), implemented as a view with `GROUPING SETS`-style unions (SQLite lacks GROUPING SETS, so it is expressed as UNION ALL of three sub-views; full DDL in the implementation plan).

`population_health` rolls up across variants per agent type: active variant count, traffic share distribution, coverage (what fraction of recent tasks were served by variants whose per-niche score exceeded a threshold), and ensemble gain (composite score of the ensemble vs the baseline alone). The concrete SQL lands in the implementation plan; the contract is that this view returns one row per agent type.

### 6.4 Relationship to existing `agent_performance`

The existing view is **retained unchanged** to avoid breaking any downstream consumers (dashboard, current meta persona). `variant_performance` is an additive superset and will eventually replace `agent_performance` in a Spec D cleanup. No code is moved off `agent_performance` in Spec A.

---

## 7. Capture points (where the code changes)

Summary of the files that change. Full diffs belong to the implementation plan.

| File | Change |
|---|---|
| `src/db/schema.sql` | Adds base-schema `schema_migrations` table; no other changes (column additions are via migrations) |
| `src/db/migrations/001_population_schema.sql` | `ALTER TABLE skill_versions` × 4 columns + backfill UPDATE statements + triggers |
| `src/db/migrations/002_task_diff_stats.sql` | `CREATE TABLE task_diff_stats` + `CREATE TABLE task_iteration_diffs` + indices |
| `src/db/migrations/003_transcripts_variant.sql` | `ALTER TABLE agent_transcripts ADD COLUMN persona_version_id` + backfill |
| `src/db/migrations/004_experiments_evidence.sql` | `ALTER TABLE experiments ADD COLUMN operation` + `evidence` + backfill |
| `src/db/migrations/005_reward_views.sql` | `DROP VIEW IF EXISTS` + `CREATE VIEW` for the four views |
| `src/db/client.ts` | `initSchema` extended to run migrations; new methods `insertTaskDiffStats`, `writeVariantSelectedEvent` helpers |
| `src/orchestrator/diff-stats.ts` (new) | `computeDiffStats(worktreePath, baseRef)` and `computeIterationDiff(worktreePath, fromIter, toIter)` — both run `git diff --numstat` and parse |
| `src/orchestrator/service.ts` | Calls `computeDiffStats` before `cleanupWorktree`; calls `computeIterationDiff` at the start of each rework iteration (before the next coder dispatch); emits `variant_selected` event at dispatch; emits `failure_analysis` at `state.failed`, from sweeper, and from `cancelTask` |
| `src/executors/anthropic-sdk.ts` | Extends `AgentResult.metrics` with `toolStats: { readCount, writeCount, bashCount, iterations }` |
| `src/executors/claude-code.ts` | `toolStats` remains `null` (noted explicitly) |
| `src/config/reward.ts` (new) | `getRewardWeights()` + `computeComposite()` + startup validator |
| `src/config/reward-weights.json` (new) | Default equal weights |
| `src/orchestrator/staleness.ts` | Emits `failure_analysis` with `failure_category = 'stalled'` (tightens the existing sweeper) |
| `src/personas/meta.md` | Not touched in Spec A — the meta persona rewrite belongs to Spec B |

---

## 8. Implementation sequence

Spec A's implementation plan (produced by `writing-plans`) should follow this order; each numbered step is independently mergeable:

1. **Migrations infrastructure.** `schema_migrations` table in base schema, `initSchema` runner, `src/db/migrations/` directory convention. Test: a no-op migration runs exactly once.
2. **Population-shaped `skill_versions` + triggers.** Migration 001. Backfill. Verify existing code still reads `is_active` correctly.
3. **`experiments` operation + evidence.** Migration 004. Backfill.
4. **`agent_transcripts` variant id.** Migration 003. Backfill from events; log unmapped count.
5. **`failure_analysis` event.** Event type emission at `state.failed`, in staleness sweeper, in `cancelTask`. Payload contract per §5.1.
6. **Tool stats in SDK executor.** Extend `AgentResult.metrics`; wire into the `failure_analysis` payload and normal completion events.
7. **`task_diff_stats` + `task_iteration_diffs` tables + capture.** Migration 002 creates both. `computeDiffStats` and `computeIterationDiff` helpers. `computeDiffStats` called before cleanup. `computeIterationDiff` called at the start of each rework iteration (new invocation in the rework loop). Unit tests with fixture worktrees covering single-iteration and multi-iteration tasks.
8. **`variant_selected` event.** Emitted at dispatch from `OrchestratorService`. Stub rationale `only_eligible`.
9. **Reward config + loader.** `reward-weights.json`, `reward.ts` module, startup validator.
10. **Reward views.** Migration 005. Unit test with fixture tasks covering every term's edge cases.

Step 1 is a strict prerequisite for all subsequent migration-owning steps (2, 3, 4, 7, 10). Once step 1 has landed, steps 2-4 can be authored in parallel and merged independently. Steps 5 and 6 are event-emission changes that do not depend on migrations and can proceed in parallel with 1-4. Steps 7 and 8 are independent of each other and of 2-6, but both require step 1. Step 9 is independent of all migration work. Step 10 (views) requires 1-9 to be in place so the views have something to join against.

---

## 9. Testing strategy

- **Unit tests per reward term.** Fixtures construct tasks with known state, findings, diffs, costs, iterations; the view must emit the expected component values for each term. Edge cases: no findings, no diff stats, planner fallback, scope drift boundary (1.3×), zero-iteration, high-cost.
- **Migration idempotency tests.** Run migrations twice; second run is a no-op. Run against an empty DB and against a seeded DB; both yield an identical final schema.
- **Backfill correctness tests.** Seed `skill_versions` with mixed `is_active` rows; run migration 001; assert `status` and `traffic_share` are populated correctly.
- **Trigger test.** Updating `status` to `baseline` or `active` flips `is_active = 1`; any other value flips `is_active = 0`.
- **End-to-end capture test (single-iteration).** Run a small orchestrator flow (mock executor, fixture task); after completion, assert `task_diff_stats` row exists, zero rows in `task_iteration_diffs`, `variant_selected` event exists, `task_quality_score` row returns a non-null composite when weights are applied.
- **Rework capture test (multi-iteration).** Drive a fixture task through two rework iterations; assert one row in `task_iteration_diffs` per transition (iter 0 → 1, iter 1 → 2); final `task_diff_stats` row matches cumulative diff.
- **Startup validator test.** Malformed weights (sum ≠ 1.0, negative, missing key) throw at startup.
- **Compatibility test.** `agent_performance` view still returns identical rows after migrations on a fixture dataset.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration fails mid-run in production | Per-migration transactions; `schema_migrations` only records on success; retry on next startup |
| `computeDiffStats` crashes on missing worktree | Try/catch + warning log + skip insert; view treats missing row as neutral simplicity |
| Scope-drift computation depends on `plan` JSON shape which varies | Use `COALESCE(NULLIF(..., ''), 0)` so missing/malformed plan yields `scope_drift = 0` (no penalty) |
| Weight change requires restart | Acceptable for MVP; revisit in Spec D if tuning becomes frequent |
| `agent_transcripts` backfill misses rows with no matching event | Logged count, NULL persona_version_id; downstream queries filter NULLs |
| Large `review_findings.category` cardinality pollutes `niche_performance` | Acceptable for MVP; Spec B normalizes |

---

## 11. Success criteria

Spec A is complete when:

1. All migrations run cleanly on a fresh DB and on a DB with the current production schema.
2. A newly-submitted task produces rows in `task_diff_stats`, an event of type `variant_selected`, and (on failure) an event of type `failure_analysis` with the full §5.1 payload.
3. `SELECT * FROM task_quality_score WHERE task_id = <id>` returns the five reward components for any terminal task, with NULL-safe behaviour when any upstream signal is missing.
4. `SELECT * FROM variant_performance` returns one row per (variant_id, agent_type) with aggregated components.
5. The composite score can be computed in application code from any `task_quality_score` row using `computeComposite()` and the current weights.
6. Existing tests pass; `agent_performance` view returns identical rows to pre-migration.
7. Startup fails loudly if `reward-weights.json` is malformed.

When these hold, Spec A is ready to be merged and the implementation plans for Specs B and C can proceed in parallel.
