# Spec B — Curator Meta and Lessons

**Status:** Proposed
**Date:** 2026-04-19
**Parent:** [`2026-04-19-self-improving-persona-population-design.md`](./2026-04-19-self-improving-persona-population-design.md)
**Depends on:** [`2026-04-19-observability-and-reward-foundation-design.md`](./2026-04-19-observability-and-reward-foundation-design.md) (Spec A)
**Scope:** Layers 3 (curation) and 5 (memory & lineage) of the umbrella. Delivers the auto-reflection sub-agent, the `lessons` table, dispatch-time lesson retrieval, and the rewritten curator meta persona with structured operation vocabulary.

---

## 1. Purpose and success

Spec B makes the system learn from its own trajectories. Concretely, after Spec B ships:

- Every terminal task produces at most one lesson row capturing what generalizes from it.
- Lessons accrue per-lineage, so all descendants of a variant inherit its memory.
- At dispatch, relevant lessons are retrieved and injected into the system prompt as context.
- The meta agent reads transcripts, findings, and rework signals — not just aggregates — and emits structured operations (`edit | fork | merge | promote | demote | retire`) with evidence.
- Malformed meta proposals are rejected with a logged reason; no half-formed operations pollute the experiments table.

What Spec B does **not** deliver (owned elsewhere):
- Traffic allocation across variants (Spec C).
- Heterogeneity diagnostic / forking criteria enforcement (Spec D).
- Routing classifier for population size > 1 (Spec D).
- Dashboard surface for lessons or operations (follow-on).

---

## 2. Scope

**In scope**
- New table `lessons` and associated indices
- New sub-agent persona `reflector` at `src/personas/reflector.md`
- `autoforge/reflection` orchestration path: dispatched automatically after every `state.completed` and `state.failed` transition
- New module `src/orchestrator/reflection.ts` wrapping the reflector dispatch and lesson write
- New module `src/orchestrator/lessons.ts` implementing `retrieveLessonsForDispatch()` + keyword extraction from task descriptions
- Injection of lessons into system prompts at dispatch time (modifies `AgentExecutor` prompt composition)
- Extension of `variant_selected` event payload with `injected_lesson_ids`
- Rewrite of `src/personas/meta.md` in curator vocabulary, with structured output format
- New JSON schema for meta output validation at `src/schemas/meta-output.schema.json`
- Orchestrator path `submitMetaTask` rewritten to validate and dispatch structured operations
- New event type `meta_rejected` emitted when meta output fails validation
- Tests covering reflection end-to-end, retrieval ranking, prompt injection, malformed-output rejection, lesson retirement by meta, reflector-driven supersession

**Out of scope (owned by later specs or deferred)**
- Dispatch policy choosing between variants (Spec C) — Spec B assumes `select_variant()` exists and returns one variant per agent type
- Forking enforcement (heterogeneity diagnostic, human-approval gate) — Spec D; Spec B implements the curator's *output* contract but not the approval workflow
- Merging similarity-test implementation — Spec D; Spec B accepts merge proposals but the actual consolidation logic is Spec D
- Embedding-based lesson retrieval — explicitly deferred; keyword retrieval for MVP
- Automatic lesson expiry by age — explicitly rejected; supersession is the only retirement path
- Lesson clustering / deduplication beyond self-suppression and supersession — follow-on
- Dashboard visualization of lessons and lineage — follow-on

---

## 3. Data model

### 3.1 `lessons` table

```sql
CREATE TABLE IF NOT EXISTS lessons (
  id                 TEXT PRIMARY KEY,
  agent_type         TEXT NOT NULL,            -- planner | coder | reviewer | doc
  lineage_root_id    TEXT NOT NULL REFERENCES skill_versions(id),  -- seed id of the lineage
  source_task_id     TEXT NOT NULL REFERENCES tasks(id),
  source_variant_id  TEXT NOT NULL REFERENCES skill_versions(id),
  trigger_pattern    TEXT NOT NULL,            -- one-sentence description of applicable tasks
  failure_category   TEXT,                     -- nullable; matches failure_analysis vocabulary
  finding_categories TEXT,                     -- JSON array; nullable
  body               TEXT NOT NULL,            -- ≤ 200 words, structured format (§4.3)
  outcome_kind       TEXT NOT NULL,            -- 'corrective' | 'reinforcing'
  retrieval_keywords TEXT,                     -- space-separated keywords for keyword retrieval
  status             TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded' | 'retired'
  superseded_by      TEXT REFERENCES lessons(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_lessons_lineage_active
  ON lessons(lineage_root_id, agent_type, status);

CREATE INDEX IF NOT EXISTS idx_lessons_keywords
  ON lessons(retrieval_keywords);
```

**Design notes**
- **Per-lineage, not per-variant.** A lesson learned by any variant in a lineage is available to all its descendants. `lineage_root_id` is the seed id (the top of the fork tree). For a seed variant with no parent, `lineage_root_id = id`.
- **`outcome_kind`** distinguishes corrective lessons (from rework or failure) from reinforcing lessons (from clean success). Both are useful; the reflector decides which (often neither if the task was too narrow to generalize).
- **`retrieval_keywords`** is a lowercase, tokenized bag of terms the reflector extracts from the task description, findings, and trigger pattern. Retrieval matches against the task-in-progress's keywords.
- **Supersession and retirement are separate lifecycles.**
  - `superseded` — set automatically when a newer lesson (typically from the reflector) points back at this one via `superseded_by`. Requires the existence of a replacement. Owner: the reflector.
  - `retired` — set when the lesson is judged obsolete but no direct replacement exists. `superseded_by` is NULL. Owner: the curator meta (via `retire_lessons` in its output).
  - No automatic deletion ever. `retired_at` is set when either transition happens.
- **No embeddings in MVP.** Schema leaves room for a future `embedding BLOB` column; retrieval is keyword-based until proven insufficient.
- **Lineage root lookup.** Computing `lineage_root_id` from a `skill_versions.id` walks `parent_version_id` pointers until NULL. This is cheap (expected depth < 5) and can be cached per variant.

### 3.2 `variant_selected` event payload extension

Spec A defined the event shape. Spec B adds one field:

```json
{
  "agent_type": "coder",
  "selected_variant_id": "abc123",
  "selected_variant_specialty": null,
  "eligible_variant_ids": ["abc123"],
  "selection_rationale": "only_eligible",
  "shadow_variant_ids": [],
  "injected_lesson_ids": ["lesson_a1", "lesson_b2"]
}
```

`injected_lesson_ids` is always an array (possibly empty) of lesson ids injected into the system prompt for this dispatch. Enables later analysis of "did this lesson help?"

### 3.3 Reflector persona

A new persona file `src/personas/reflector.md` (also seeded into `skill_versions` as `persona:reflector` on first run, per existing seed semantics). This persona is **not** a population member that gets forked/edited by the curator meta — it is a system-utility persona. Out of scope for curation in Spec B. A later spec may open it up.

### 3.4 `experiments` extension — `proposed_content` column

One column added to `experiments` to persist the proposed persona content across the gap between meta proposal and later approval:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `proposed_content` | TEXT | NULL | Full text of the proposed persona content when `operation IN ('edit', 'fork')`. Populated by the handlers at proposal time, read by the approval handler (Spec B placeholder, Spec D real) and the `edit` cold-start handler. NULL for operations that don't produce new content |

**Why this lives here, not in Spec D.** Meta cleans up its worktree after its session terminates, so the file `operation.proposed_content_file` written by meta does not persist. Without a database column, no downstream consumer can read the proposed content. Spec B is where the gap first appears (its placeholder approval endpoint needs content), so the column is introduced here. Spec D's real approval handler reads from the same column.

**Migration.** A new migration `007_experiments_proposed_content.sql` adds the column. Existing `experiments` rows backfill to NULL.

**Handler behavior.**
- `edit` handler: reads `operation.proposed_content_file` from meta's worktree, writes contents to `experiments.proposed_content`, creates the candidate `skill_versions` row using the same content, cleans up the worktree.
- `fork` handler (placeholder): reads `operation.proposed_content_file` from meta's worktree, writes contents to `experiments.proposed_content`, creates the `experiments` row with `status = 'proposed'`, does not create a `skill_versions` row until approval. Then cleans up the worktree.
- `merge` / `promote` / `demote` / `retire` handlers: `proposed_content` remains NULL; these operations don't produce new persona content.

### 3.5 Meta persona output format (the rewrite)

The existing `src/personas/meta.md` is rewritten. The `.autoforge-status.json` output contract becomes:

```json
{
  "status": "DONE",
  "artifacts": ["proposed-persona-coder-frontend.md"],
  "operation": {
    "kind": "fork",
    "target_variant_id": null,
    "parent_variant_id": "abc123",
    "specialty": "frontend React components and CSS-adjacent code",
    "hypothesis": "The generalist coder persona underperforms on tasks with CSS/styling scope due to missing guidance on component-scoped styling conventions.",
    "evidence": {
      "task_ids": ["t_001", "t_005", "t_011"],
      "finding_categories": ["styling", "convention"],
      "transcript_excerpts": [
        { "task_id": "t_005", "stage": "coder", "lines": "124-138" }
      ],
      "metric_name": "task_quality_score",
      "metric_before": 0.42
    },
    "proposed_content_file": "proposed-persona-coder-frontend.md",
    "retire_lessons": [
      { "id": "lesson_a1", "reason": "superseded by new styling guidance in the forked persona" }
    ]
  }
}
```

**Schema rules (enforced by validator):**
- Exactly one `operation.kind` value from `edit | fork | merge | promote | demote | retire`.
- `target_variant_id` is required for `edit | merge | promote | demote | retire`.
- `parent_variant_id` is required for `fork`.
- `specialty` is required for `fork` and forbidden for `edit`.
- `proposed_content_file` is required for `edit` and `fork`, forbidden for others.
- `evidence.task_ids` must be a non-empty array for every operation kind.
- `retire_lessons` is an optional array of `{id, reason}` objects; ≤ 3 entries; each `id` must reference a lesson currently in `status = 'active'`. This retires those lessons (not supersedes — supersession is only produced by the reflector).
- Only one operation per meta session. Multiple `operation` objects → reject.

Malformed outputs are rejected (logged, no experiment created, `submitMetaTask` returns `status: "DONE_WITH_CONCERNS"`).

---

## 4. Auto-reflection

### 4.1 Trigger

The orchestrator invokes `reflectOnTask(taskId)` synchronously after:
- `state.completed` transition
- `state.failed` transition
- `cancelTask` (unless the cancel reason indicates noise; see §4.5)

`reflectOnTask` is called **after** `computeDiffStats` and **before** `cleanupWorktree`. Inter-iteration diff rows have already been captured by Spec A's `computeIterationDiff` calls during the task's rework loop, so the reflector queries `task_iteration_diffs` from the database directly rather than the worktree.

### 4.2 Reflector dispatch

`src/orchestrator/reflection.ts` exports:

```typescript
async function reflectOnTask(taskId: string, dbPath: string): Promise<string | null>
```

Behavior:
1. Load the task, its final state, all events, the planner and coder transcripts, all review findings, the task's iterations, the diff stats, and any `failure_analysis` event payload.
2. Load the active lessons in the lineage of the coder variant (usually the relevant agent — see §4.6 for the agent-type policy).
3. Construct the reflector prompt (§4.3) and dispatch a single `executor.execute()` call through the existing executor routing, using `persona:reflector`.
4. Parse the reflector's output. If `{ "skip": true }`, return null.
5. Otherwise, extract keywords, compute `lineage_root_id`, insert a row into `lessons`.
6. Return the new lesson id (or null).

**Budget:** 60 seconds, ~2000 input tokens. Small dedicated budget; failures are non-fatal.

**Executor routing:** reflector is an SDK-executor job (same as meta) because it benefits from structured output and tool use (reading files in the worktree). Claude Code is allowed as a fallback.

### 4.3 Reflector prompt and lesson body format

The reflector's system prompt is `src/personas/reflector.md`. The per-task user prompt includes:

- Task description, tier, state, iteration count
- Truncated transcripts for planner and coder (top-N tokens each; the prompt template decides the limit)
- All review findings (severity + category + description)
- `failure_analysis` payload if present
- Whole-task diff stats (`task_diff_stats`) AND per-rework inter-iteration deltas (`task_iteration_diffs`), both provided by Spec A §4.4
- The active lessons in this lineage (so the reflector can self-suppress redundant ones)

**Expected output format:**

```json
{
  "skip": false,
  "trigger_pattern": "Tasks that add or modify React component styling where the existing codebase uses CSS modules.",
  "body": "TRIGGER: <restatement>\nOBSERVATION: <what happened>\nPRINCIPLE: <one-sentence rule>\nEVIDENCE: task t_005; findings in category 'styling'; coder transcript lines 124-138",
  "outcome_kind": "corrective",
  "failure_category": "rework_limit",
  "finding_categories": ["styling", "convention"],
  "keywords": "react component css-modules styling rework"
}
```

Or, to decline:

```json
{ "skip": true, "reason": "Task too narrow; no generalizable pattern." }
```

**Body length constraint:** ≤ 200 words. Enforced by the validator (truncation is rejected, not silently applied — the reflector should be taught to respect the limit).

### 4.4 Self-suppression

The reflector receives up to **20 active lessons** from the same `lineage_root_id` as context. It is instructed to emit `{ "skip": true, "reason": "..." }` when a new lesson would duplicate or near-duplicate an existing one. This is cheap filtering; statistical deduplication is out of scope.

### 4.5 Skipping reflection on noise

Three cases skip reflection entirely (no reflector dispatch):
- `cancelTask` with `reason = "noise"` (e.g., manual operator cleanup)
- Task state `failed` with `failure_category = "stalled"` AND `elapsed_seconds < 60` (almost certainly an infrastructure glitch, not a learning signal)
- Task in a project marked `reflection_disabled` in project settings (flag reserved for future; default false)

### 4.6 Which agent's lineage gets the lesson?

A task involves multiple agents (planner, coder, reviewer, optionally doc). The reflector's output is stored against **one** lineage. Policy:

- If the task failed due to a planner-attributable cause (`planner_fallback`, planner-stage critical findings), store against **planner**.
- If the task failed due to coder-attributable causes (rework loop, PR gate, blocking findings), store against **coder**.
- If the task succeeded cleanly or the cause is ambiguous, store against **coder** (the most common beneficiary).
- The reflector outputs `agent_type` explicitly; the orchestrator stores accordingly.

Multi-agent lessons (where the same lesson applies to both planner and coder) are out of scope for MVP. The reflector picks one.

---

## 5. Retrieval at dispatch

### 5.1 API

`src/orchestrator/lessons.ts` exports:

```typescript
interface RetrievedLesson {
  id: string;
  body: string;
  trigger_pattern: string;
  outcome_kind: 'corrective' | 'reinforcing';
}

async function retrieveLessonsForDispatch(
  variantId: string,
  agentType: AgentType,
  taskDescription: string,
  maxLessons?: number,
  maxTokens?: number
): Promise<RetrievedLesson[]>;
```

Defaults: `maxLessons = 5`, `maxTokens = 1500`. Both configurable.

### 5.2 Ranking

1. Filter to `status = 'active'` AND `lineage_root_id` matches the variant's lineage AND `agent_type` matches.
2. Compute keyword overlap: count of `retrieval_keywords` tokens present in the task description's extracted keywords.
3. Require at least 1 keyword overlap to be considered relevant.
4. Order: keyword overlap count DESC, `created_at` DESC.
5. Truncate to `maxLessons`, then check cumulative token budget; drop tail lessons until `maxTokens` is respected.

**If no lessons match,** return `[]`. Empty injection is normal.

### 5.3 Keyword extraction from task description

Lowercase, strip punctuation, split on whitespace, remove English stop words (hardcoded small list: the, a, an, to, of, for, and, or, in, on, with, is, are, be). Take the top 20 terms by frequency. Same tokenization as `retrieval_keywords`. No stemming in MVP.

### 5.4 Injection into system prompt

Modifies `AgentExecutor` prompt composition. A new section is inserted **after** the persona and **before** the skill files:

```
# Lessons from past tasks in this lineage

## Lesson <id> (corrective)
TRIGGER: ...
OBSERVATION: ...
PRINCIPLE: ...
EVIDENCE: ...

## Lesson <id> (reinforcing)
...
```

If zero lessons retrieved, the entire section is omitted.

### 5.5 Event payload tracking

The injected lesson ids are recorded in the `variant_selected` event's `injected_lesson_ids` field (§3.2). This enables later analysis: "of the tasks that included lesson X, did their `task_quality_score` differ from those that did not?"

### 5.6 Concurrency and caching

Lesson retrieval reads only the DB and is cheap. A simple per-process LRU cache keyed by `(variantId, taskDescription_hash)` with TTL 60 seconds is optional; not required for MVP.

---

## 6. Curator meta persona rewrite

### 6.1 Persona content shift

The new `src/personas/meta.md` teaches meta to:
- Think of itself as a population curator, not a single-text editor.
- Choose from the six operations (`edit | fork | merge | promote | demote | retire`).
- Ground every proposal in evidence pulled from specific tasks, findings, transcripts, and rework signals — not from aggregates alone.
- Query Spec A's views (`task_quality_score`, `variant_performance`, `niche_performance`, `population_health`) and cite specific rows.
- Read `agent_transcripts` directly when hypothesizing about a persona's failure mode.
- Respect the constraints: one operation per session; fork requires specialty and evidence; merge requires two variants with a structural similarity argument; promote/demote adjust traffic share within bounds.

The full rewritten persona text is an artifact of this spec's implementation plan, not of this document.

### 6.2 Tool surface needed

The meta executor invocation must include the following skills / tool access:
- Existing: bash (for sqlite3), read/write files in worktree
- New: a curated set of read-only helper prompts embedded in the persona instructing it to run specific SQL queries (no new tools introduced — the bash + sqlite3 combo is sufficient)

No new executor capabilities are required for Spec B. The persona itself directs the bash/sqlite3 usage.

### 6.3 Output validation

`src/schemas/meta-output.schema.json` is a JSON Schema describing the `operation` object per §3.5. On `submitMetaTask` completion:
- Parse `.autoforge-status.json`.
- If it contains `operation`, validate against the schema.
- If invalid: log the failure with details, emit `meta_rejected` event, return `status: "DONE_WITH_CONCERNS"` with `experimentId: null`.
- If valid: dispatch to the operation handler (§6.4).

### 6.4 Operation handlers

`src/orchestrator/meta-operations.ts` handles each operation kind:

- **`edit`** — today's behavior, preserved: create a new `skill_versions` row with `parent_version_id = target_variant_id`, `status = 'candidate'`, `traffic_share = 0.0`. The new row goes through cold-start evaluation (Spec C). Not activated live.
- **`fork`** — gated by first-fork approval (Spec D). For MVP in Spec B, `fork` operations are recorded as `experiments` rows with `status = 'proposed'` and do not create a `skill_versions` row until a human approves via a new endpoint `POST /api/experiments/:id/approve-fork`. Spec D formalizes the approval workflow; Spec B stubs the endpoint as "approve only, no automation."
- **`merge`** — stub in Spec B: recorded as `experiments` row with `operation = 'merge'` and `status = 'proposed'`; full merge logic is Spec D.
- **`promote` / `demote`** — adjust `skill_versions.traffic_share` within limits (baseline protection clamped: baseline cannot go below 0.5 traffic share; no variant can exceed 1.0). Spec C's dispatch policy reads these values; Spec B writes them. Baseline protection is enforced in the handler.
- **`retire`** — set `status = 'retired'`, `traffic_share = 0.0`, `retired_at = now()`. Forbidden if the variant is the only `baseline` for its agent type (must promote another first).

Per-session limit: one operation. **Additionally,** the meta output may include `retire_lessons: [{id, reason}, ...]` (≤ 3 entries) which the handler applies alongside the main operation — each listed lesson is transitioned to `status = 'retired'` with `retired_at = now()`, and the reason is recorded on the `experiment.evidence` JSON blob for auditability. No lesson row is rewritten destructively; retirement is a status change.

Note the asymmetry: the reflector produces new lessons and may supersede an existing one (setting `superseded_by = <new_lesson_id>`); the curator meta does not produce lessons and may only retire them. Both transitions are immutable record changes, never deletions.

### 6.5 Experiments table usage

Every operation creates one `experiments` row:
- `operation` = the operation kind (Spec A already added this column)
- `evidence` = JSON-serialized evidence from the meta output
- `status` = `'proposed'` for fork/merge (pending approval); `'active'` for edit/promote/demote/retire
- `hypothesis`, `metric_name`, `metric_before` from the meta output
- For retire: `metric_before` may be the variant's most recent aggregate score

Spec C handles the transition to `keep` / `discard` based on sequential testing results.

---

## 7. Cross-spec dependencies

### 7.1 Inter-iteration diffs (resolved via Spec A cross-check)

The reflector needs the **inter-iteration diff** for rework tasks (iter N → iter N+1) to produce precise corrective lessons. This was originally an open ask of Spec A; the cross-check pass folded `task_iteration_diffs` into Spec A §4.4.2. The reflector's prompt (§4.3) reads both `task_diff_stats` (whole-task cumulative) and `task_iteration_diffs` (per-rework delta). No runtime change in Spec B is required beyond having the reflector query both tables.

### 7.2 Relationship to Spec C's `select_variant()`

Spec B does **not** depend on Spec C being merged first. Spec A's §5.2 defines a stubbed `select_variant()` that returns the single active variant (baseline) for each agent type and emits a `variant_selected` event. Spec B's lesson retrieval reads that event's `selected_variant_id` and operates on whichever variant was chosen — by Spec A's stub today or by Spec C's real policy later. The contract Spec B needs is already provided by Spec A.

When Spec C later introduces richer rationale values (`exploration`, `shadow_parallel`, etc.), Spec B's retrieval is unaffected — it consumes `selected_variant_id` regardless of how it was selected. No changes to Spec B are required when Spec C ships.

### 7.3 Ask of Spec D: fork approval

Spec D owns the approval workflow for first-fork operations. Spec B's fork handler stubs this by creating a `proposed`-state experiment and exposing `POST /api/experiments/:id/approve-fork` as a placeholder. Spec D will:
- Replace the placeholder endpoint with a richer one
- Add the heterogeneity diagnostic that gates autonomous forks within approved lineages
- Formalize the first-fork-per-lineage approval rule

---

## 8. Capture points (where the code changes)

| File | Change |
|---|---|
| `src/db/migrations/006_lessons.sql` (new) | `CREATE TABLE lessons` + indices |
| `src/db/migrations/007_experiments_proposed_content.sql` (new) | `ALTER TABLE experiments ADD COLUMN proposed_content TEXT` |
| `src/personas/reflector.md` (new) | Reflector persona prompt |
| `src/personas/meta.md` (rewrite) | Curator vocabulary; new operation output format; evidence-required rules |
| `src/orchestrator/reflection.ts` (new) | `reflectOnTask(taskId)`; invokes executor with `persona:reflector`; inserts lesson row |
| `src/orchestrator/lessons.ts` (new) | `retrieveLessonsForDispatch()`; keyword extraction; lineage root resolution |
| `src/orchestrator/meta-operations.ts` (new) | Handlers for `edit | fork | merge | promote | demote | retire`; supersession side-effect |
| `src/orchestrator/service.ts` | Calls `reflectOnTask` after `state.completed` / `state.failed` / `cancelTask`; rewrites `submitMetaTask` to validate output against schema and dispatch to operation handlers; adds `injected_lesson_ids` to `variant_selected` event emission |
| `src/executors/agent-executor.ts` (or equivalent prompt composer) | Inserts `# Lessons from past tasks` section between persona and skill files when `injectedLessons.length > 0` |
| `src/schemas/meta-output.schema.json` (new) | JSON Schema for meta operation output |
| `src/web/routes/meta.ts` | Existing `POST /` unchanged interface but returns `meta_rejected` status when output is malformed; new `POST /experiments/:id/approve-fork` placeholder |
| `src/config/reflection.ts` (new) | Budget, max-lessons-in-context, skip policy flags |
| `src/db/client.ts` | `insertLesson`, `retrieveActiveLessonsByLineage`, `supersedeLessons`, `resolveLineageRoot` helpers |

---

## 9. Implementation sequence

1. **`lessons` table and helpers.** Migration 006; DB helpers; `resolveLineageRoot` with unit test.
2. **Reflector persona + reflection module.** `reflector.md`; `reflectOnTask`; wired to orchestrator terminal-state transitions; budget + skip policy enforced.
3. **Lesson retrieval module.** `retrieveLessonsForDispatch`; keyword extraction; ranking; tests with fixture lessons.
4. **Prompt injection.** AgentExecutor composer inserts `# Lessons` section; `injected_lesson_ids` added to `variant_selected` payload.
5. **Meta output schema + validator.** JSON Schema; validator wired into `submitMetaTask`; `meta_rejected` event emitted on invalid.
6. **Operation handlers.** `meta-operations.ts` with `edit` fully implemented (replaces today's behavior), `promote/demote/retire` implemented with baseline protection, `fork/merge` stubbed as proposed-status experiments.
7. **Fork-approval placeholder endpoint.** `POST /experiments/:id/approve-fork` that only transitions status and creates the `skill_versions` row. Hardened in Spec D.
8. **Curator meta persona rewrite.** New `src/personas/meta.md`; version-bumped seed; end-to-end test submitting a meta task and observing a well-formed proposal → operation → experiment row.
9. **Supersession side-effect.** `supersede_lessons` in meta output applies supersession in the same transaction as the experiment insert.

Steps 1-2 are sequential. Step 3 depends on 1. Steps 4 and 5-6 can be developed in parallel after 3. Step 7 depends on 6. Step 8 depends on 5 and 6. Step 9 depends on 8.

---

## 10. Testing strategy

- **Reflection end-to-end.** Run a fixture task through completion; assert a lesson is inserted or `skip` is logged.
- **Lesson skip policies.** Short stalled task → no reflector dispatch. `cancelTask` with noise reason → skip. Redundant-to-existing lesson → reflector returns `skip: true`.
- **Retrieval ranking.** Seed 10 lessons with known keywords; dispatch a task with specific description; assert the top-K returned matches expected order.
- **Token budget.** Seed lessons whose total exceeds `maxTokens`; assert truncation drops tail entries.
- **Prompt injection.** When `injectedLessons.length > 0`, the `# Lessons` section appears at the correct position; when empty, absent.
- **Meta output schema.** Valid outputs for each of the six operations pass; outputs missing required fields fail; outputs with two operations fail.
- **Malformed meta rejection.** `meta_rejected` event emitted with reason; no experiment row created; no skill_versions row created.
- **`edit` operation.** Creates a candidate variant with `status = 'candidate'`, `traffic_share = 0.0`, `parent_version_id = target`.
- **`fork` operation.** Creates a proposed experiment; no skill_versions row until approval endpoint hit.
- **`promote`/`demote` baseline protection.** Attempting to demote baseline below 0.5 fails with an error and no state change.
- **`retire` guard.** Attempting to retire the sole baseline fails.
- **Supersession.** Meta output with `supersede_lessons` marks listed lessons `superseded_by` the implied new record; if the operation is not lesson-producing, `superseded_by = NULL` but `status = 'superseded'`.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reflector produces noisy or hallucinated lessons | Self-suppression via existing-lesson context; explicit "be conservative" instruction; supersession removes bad lessons when detected |
| Per-task sync reflection adds latency to every task | Budget capped at 60s; SDK executor; in practice ~10-20s; acceptable overhead for the signal gained |
| Lesson body length creeps beyond 200 words | Validator rejects oversize outputs; the lesson is skipped (no insert). The reflector persona prompt instructs "≤ 200 words" explicitly; repeated violations surface as a `meta_persona_degraded` warning once a rate threshold is crossed |
| Keyword retrieval misses semantically-similar tasks | Accepted limitation for MVP; embedding-based retrieval additive follow-on |
| Lineage root resolution is slow if chains grow long | Expected chain depth < 5; cache per variant; rebuild cache on fork/merge |
| Malformed meta outputs fill events table with rejections | Rate-limit: if three consecutive meta sessions are rejected, escalate with a `meta_persona_degraded` warning event |
| `fork` and `merge` stubs are limiting | Acknowledged — Spec D completes them; Spec B's experiment-row contract is forward-compatible |
| Baseline protection clamp fails silently on concurrent writes | All traffic-share changes go through a single transactional handler; direct SQL writes forbidden |
| Reflection runs before `cleanupWorktree` — reflector could delay cleanup | Budget cap (60s) + error handling; cleanup runs regardless in a `finally` block |

---

## 12. Success criteria

Spec B is complete when:

1. Every terminal task either produces a lesson row or logs a documented skip reason.
2. At dispatch, relevant active lessons for the selected variant's lineage are retrieved and injected into the system prompt; `injected_lesson_ids` is populated in the `variant_selected` event.
3. The curator meta persona produces structured `operation` outputs validated against the JSON schema; malformed outputs are rejected with a logged reason and no side effects.
4. `edit`, `promote`, `demote`, `retire` operations are fully implemented with baseline protection.
5. `fork` and `merge` operations are recorded as `proposed`-state experiments; the approval endpoint creates the skill_versions row for fork.
6. Supersession of lessons works: listed ids are marked `superseded_by` and `status = 'superseded'`.
7. Existing tests pass; the existing `POST /api/meta/` endpoint returns the new structured response for both success and rejection cases.

When these hold, Spec C (dispatch policy) has everything it needs to consume.
