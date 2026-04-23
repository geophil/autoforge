# Spec D — Population Operations

**Status:** Proposed
**Date:** 2026-04-19
**Parent:** [`2026-04-19-self-improving-persona-population-design.md`](./2026-04-19-self-improving-persona-population-design.md)
**Depends on:** [`2026-04-19-observability-and-reward-foundation-design.md`](./2026-04-19-observability-and-reward-foundation-design.md) (Spec A), [`2026-04-19-curator-meta-and-lessons-design.md`](./2026-04-19-curator-meta-and-lessons-design.md) (Spec B), [`2026-04-19-dispatch-policy-and-safe-experimentation-design.md`](./2026-04-19-dispatch-policy-and-safe-experimentation-design.md) (Spec C)
**Scope:** Completes population curation. Adds the heterogeneity diagnostic (detecting clusters that justify specialization), the routing classifier (replacing Spec C's naive keyword match), the real first-fork approval workflow (replacing Spec B's placeholder), and the merge operation (consolidating statistically indistinguishable variants).

---

## 1. Purpose and success

Spec D closes the autonomous loop. After Spec D ships:

- A background diagnostic surfaces clusters of failing tasks as candidate forking opportunities; operators see *why* a fork is proposed, not just *that* one is.
- Dispatch picks the right specialist for a task via embedding-based similarity, not brittle keyword overlap.
- First-fork approvals go through a proper API/CLI path with rich context (evidence, proposed persona content, cluster data).
- Two variants whose behavior has converged can be merged automatically via meta's `merge` operation — no fragmentation.
- The end-to-end lifecycle runs without human intervention after a first-fork approval: diagnostic detects cluster → meta proposes fork → human approves → candidate shadows → graduates → accumulates traffic → eventually merges or retires.

What Spec D explicitly does **not** deliver:
- Full population-health dashboard UI (follow-on — see §13)
- Cross-project specialization (umbrella non-goal)
- Skill-attachment learning (umbrella non-goal flagged for possible future revisit — see §13)
- Resurrection of retired variants (YAGNI)
- Bandit upgrades beyond ε-greedy (follow-on)
- Replay-based shadow evaluation as a replacement for parallel shadow (follow-on)

---

## 2. Scope

**In scope**
- New table `fork_proposals` capturing heterogeneity-diagnostic output
- New column `skill_versions.specialty_embedding BLOB`
- New persona file `src/personas/diagnostician.md`
- New module `src/orchestrator/diagnostic.ts` — triggers the diagnostician, stores proposals, marks stale
- New module `src/orchestrator/classifier.ts` — embedding-based specialty matching; replaces Spec C's keyword match as primary, keyword retained as fallback
- Fork-approval API endpoints: `GET /api/experiments?status=proposed&operation=fork`, `POST /api/experiments/:id/approve-fork`, `POST /api/experiments/:id/reject-fork`
- CLI subcommands: `autoforge experiments list-pending`, `autoforge experiments approve-fork <id>`, `autoforge experiments reject-fork <id>`
- Merge operation handler completing Spec B's `merge` stub
- Validator additions: meta's `fork` outputs must cite an open `fork_proposal` (unless fork is within already-approved lineage); meta's `merge` outputs must satisfy sample-size and same-lineage rules
- New events: `fork_approved`, `fork_rejected`, `variants_merged`, `diagnostic_run_completed`, `diagnostic_cluster_detected`
- Embedding-backfill migration (compute `specialty_embedding` for existing non-NULL specialties)
- Auto-timeout for proposed-status forks older than 30 days
- Tests covering diagnostic output, classifier accuracy, approval and rejection flows, merge behavior, validator enforcement

**Out of scope (owned elsewhere or deferred)**
- Web dashboard UI (§13 follow-on)
- Cross-lineage merging (§13 follow-on)
- Routing classifier via full LLM call at dispatch (§13 follow-on; embedding suffices for MVP)
- Skill-attachment learning (§13 future candidate)
- Per-project populations (umbrella non-goal)
- Multi-agent lesson attribution (§13 follow-on)
- Reflexion-style trajectory-level credit assignment for multi-stage failures (§13 follow-on)

---

## 3. Data model

### 3.1 `fork_proposals` table

```sql
CREATE TABLE IF NOT EXISTS fork_proposals (
  id                      TEXT PRIMARY KEY,
  agent_type              TEXT NOT NULL,
  generated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  generator               TEXT NOT NULL DEFAULT 'diagnostician',  -- reserved for future generators
  label                   TEXT NOT NULL,           -- short human-readable cluster name
  keywords                TEXT NOT NULL,           -- space-separated keywords defining the cluster
  suggested_specialty     TEXT NOT NULL,           -- one-sentence specialty description for the proposed variant
  representative_task_ids TEXT NOT NULL,           -- JSON array of 3-10 task ids illustrating the cluster
  baseline_score_mean     REAL NOT NULL,           -- composite score the baseline is currently achieving on this cluster
  population_score_mean   REAL NOT NULL,           -- composite score the rest of the traffic achieves (broader average)
  score_gap               REAL NOT NULL,           -- population_score_mean - baseline_score_mean; positive ⇒ cluster is a weak spot
  recommendation_strength TEXT NOT NULL,           -- 'weak' | 'moderate' | 'strong'
  status                  TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acted_on' | 'stale' | 'dismissed'
  acted_on_experiment_id  TEXT REFERENCES experiments(id),
  closed_at               TEXT
);

CREATE INDEX IF NOT EXISTS idx_fork_proposals_open
  ON fork_proposals(agent_type, status, generated_at);
```

### 3.2 `skill_versions` extension

One column added via a new migration:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `specialty_embedding` | BLOB | NULL | Vector embedding of the `specialty` text; NULL for generalists, for variants created before Spec D, and when the embedding call has not yet succeeded. Treated as opaque bytes by SQL; deserialized only in application code |

Backfill **does not run during the migration** (migrations should be pure local SQL). Instead, a deferred backfill runs at first daemon startup after migration: for every row with non-NULL `specialty` AND NULL `specialty_embedding`, compute and store the embedding. This is the first point in the Spec D flow where a network dependency exists; failures are logged and the variant falls back to keyword matching via §5.2 until a later retry succeeds.

### 3.3 `experiments.proposed_content` dependency

Spec D's approval handler (§6.2) reads the proposed persona content from `experiments.proposed_content`. This column is introduced in Spec B §3.4 (the column was originally drafted here but moved to Spec B during the cross-check pass, because Spec B's own placeholder approval endpoint is the first consumer and the column's lifecycle is owned by Spec B's operation handlers). Spec D depends on that column existing but does not introduce it.

### 3.4 New events

**`diagnostic_run_completed`** — one per diagnostic invocation, success or failure.

```json
{
  "trigger": "task_count_50 | nightly_cron | manual",
  "tasks_analyzed": 100,
  "clusters_proposed": 2,
  "elapsed_seconds": 14.3,
  "diagnostician_variant_id": "...",
  "error": null
}
```

**`diagnostic_cluster_detected`** — one per cluster proposed by a run.

```json
{
  "fork_proposal_id": "fp_abc123",
  "agent_type": "coder",
  "label": "CSS/styling-heavy frontend changes",
  "score_gap": 0.23,
  "recommendation_strength": "strong"
}
```

**`fork_approved`** — on successful approval.

```json
{
  "experiment_id": "e_xyz",
  "new_variant_id": "v_new",
  "parent_variant_id": "v_parent",
  "lineage_root_id": "v_root",
  "specialty": "...",
  "approver": "alice",
  "notes": "OK, approved"
}
```

**`fork_rejected`** — on rejection or timeout.

```json
{
  "experiment_id": "e_xyz",
  "reviewer": "alice | system",
  "reason": "evidence_too_weak | approval_timeout | other"
}
```

**`variants_merged`** — on completion of a merge operation.

```json
{
  "experiment_id": "e_merge",
  "kept_variant_id": "v_a",
  "retired_variant_id": "v_b",
  "merged_specialty": "...",
  "tie_breaker_used": "composite_score | text_size | created_at | none"
}
```

---

## 4. Heterogeneity diagnostic

### 4.1 Trigger

`src/orchestrator/diagnostic.ts :: runDiagnostic()` is called:

- After every 50 terminal task transitions (counted from orchestrator startup).
- At 02:00 local time via a small internal scheduler.
- Manually via `POST /api/diagnostic/run` for operator-triggered analysis.

Only one diagnostic may run at a time per agent type; concurrent triggers are coalesced (skip and log).

### 4.2 Input assembly

For each agent type with population size ≥ 1:

- Load the last 100 terminal tasks that used that agent type (from `variant_selected` events joined to `tasks`).
- For each task: description, tier, project_id, `task_quality_score` components, `task_diff_stats`, review findings (category + severity only, not descriptions, to control prompt size), and any `failure_analysis` payload.
- The generalist baseline's mean composite on these 100 tasks is pre-computed.

If fewer than 30 tasks are available for an agent type, skip — not enough data for clustering.

### 4.3 Diagnostician dispatch

Dispatched through the standard executor with persona `diagnostician` (new file `src/personas/diagnostician.md`). Same pattern as the reflector (Spec B) — it is a utility persona, not a population member subject to curation.

**Budget:** 90 seconds, ~4000 input tokens, ~1500 output tokens.

**Expected output format:**

```json
{
  "clusters": [
    {
      "label": "CSS/styling-heavy frontend changes",
      "keywords": "react css-modules styling component tailwind",
      "representative_task_ids": ["t_012", "t_019", "t_027"],
      "baseline_score_mean": 0.48,
      "population_score_mean": 0.71,
      "score_gap": 0.23,
      "recommendation_strength": "strong",
      "suggested_specialty": "Frontend React component styling and CSS-adjacent work in codebases that use CSS modules or utility frameworks."
    }
  ]
}
```

Zero clusters is a valid output (homogeneous task distribution). Up to three clusters per run per agent type.

**Strength calibration** (written into the persona prompt):
- `strong`: `score_gap ≥ 0.20` AND at least 5 representative tasks AND consistent failure pattern
- `moderate`: `score_gap ≥ 0.10` OR at least 3 representative tasks
- `weak`: surfaced but flagged; meta should ignore unless trend strengthens on next run

### 4.4 Persistence and staleness

For each cluster in the output:
1. Compute `fork_proposal_id = hash(agent_type + keywords + generated_at-date)`. If a proposal with the same hash already exists in `status = 'open'`, skip insert (duplicate from a recent run).
2. Otherwise insert a `fork_proposals` row with `status = 'open'`.
3. Emit `diagnostic_cluster_detected`.

After the insertion pass: mark any `fork_proposals` row with `generated_at < now - 14 days` AND `status = 'open'` as `status = 'stale'`.

### 4.5 Consumption by meta

Spec B's curator persona file (`src/personas/meta.md`) is updated by Spec D to include instructions for querying `fork_proposals WHERE status = 'open' AND agent_type = ?` at the start of its session. This is a persona-text update (not a schema change to Spec B's output contract), captured in Spec D's capture points (§9) as a modification to `src/personas/meta.md`. Meta may choose to act on any open proposal (via a `fork` operation citing the proposal in evidence), propose its own fork based on independent reasoning, or not fork at all. The diagnostic is *advisory*.

When meta's `fork` operation references a `fork_proposal_id` and is approved by the operator (§6), the proposal transitions to `status = 'acted_on'` with `acted_on_experiment_id` set. A rejected fork leaves the proposal `open` (may still be acted on by a later, better proposal).

---

## 5. Routing classifier

### 5.1 Replacing Spec C's naive keyword match

`src/orchestrator/classifier.ts` exports:

```typescript
async function selectSpecialtyEligible(
  agentType: AgentType,
  taskDescription: string,
  activeVariants: Variant[]
): Promise<Variant[]>;
```

This is called by `src/orchestrator/dispatch.ts :: selectVariant()` where Spec C previously invoked `specialtyMatch()` (keyword). The contract is identical.

### 5.2 Algorithm

Fallback chain:

1. **Embedding lookup** (primary) — for variants with non-NULL `specialty_embedding`:
   - Compute `taskEmbedding = embed(taskDescription)` using the small embedding model (cached per-task at dispatch).
   - For each variant: `sim = cosine(variant.specialty_embedding, taskEmbedding)`.
   - Variant is specialty-eligible if `sim ≥ 0.55` (configurable).
2. **Keyword match** (fallback) — for variants with non-NULL `specialty` but NULL `specialty_embedding` (e.g., embedding computation failed, or pre-backfill rows): apply Spec C's keyword overlap rule.
3. **Baseline** — always specialty-eligible regardless of specialty, as in Spec C.

If no non-baseline variant is specialty-eligible, the baseline alone is eligible (dispatch is deterministic to the baseline per Spec C §4.3).

### 5.3 Embedding model

- **Model:** `text-embedding-3-small` (or equivalent small, fast model). Configurable.
- **Latency:** typically 50-100ms per call; cached per dispatch call so a task that uses planner + coder + reviewer embeds the description once.
- **Cost:** fractional cents per task; negligible relative to executor cost.
- **Failure handling:** if the embedding call fails (timeout, API error), fall through to keyword match for that dispatch. Emit a `classifier_fallback` event; after N consecutive failures, alert via log.

### 5.4 Threshold tuning

The 0.55 cosine threshold is a starting point, not a calibrated value. Configurable in `src/config/dispatch.json` alongside ε and other dispatch knobs. A follow-on calibration task (using the score gap between routed-to-specialist vs routed-to-baseline on labeled tasks) is noted in §13.

### 5.5 Embedding maintenance

- Computed at variant creation time (during fork approval handler; see §6.2).
- Recomputed when the specialty is changed (only possible via `merge`, which writes a combined specialty; see §7).
- Stored as raw bytes in the BLOB; deserialized in memory at dispatch.
- Never stale in a problematic way because specialty is effectively immutable between merge events.

---

## 6. First-fork approval workflow

### 6.1 "First fork" definition

A fork is the **first fork of a lineage** for an agent type when its parent variant is either the seed variant (`parent_version_id IS NULL`) OR no descendant of the parent currently has `status IN ('active', 'baseline')`.

This definition captures the real governance requirement: **unexplored territory**. Once a lineage has at least one approved descendant in active rotation, additional forks within that lineage branch proceed autonomously via Spec C's candidate evaluation.

### 6.2 API

**`GET /api/experiments?status=proposed&operation=fork`**

Returns a JSON list of pending first-fork proposals:

```json
[
  {
    "experiment_id": "e_xyz",
    "agent_type": "coder",
    "parent_variant_id": "v_parent",
    "lineage_root_id": "v_root",
    "proposed_specialty": "...",
    "hypothesis": "...",
    "evidence": {
      "fork_proposal_id": "fp_abc",
      "task_ids": ["t_001", "t_005"],
      "finding_categories": ["styling"]
    },
    "proposed_content_preview": "<first 500 chars of proposed persona file>",
    "proposed_content_path": "/path/to/worktree/proposed-persona-coder-frontend.md",
    "created_at": "2026-04-19T10:23:00Z"
  }
]
```

Auto-timeout cleanup (§6.5) runs before this endpoint responds, so stale proposals never appear.

**`POST /api/experiments/:id/approve-fork`** with body:

```json
{
  "approver": "alice@example.com",
  "notes": "Matches the frontend cluster I've been seeing."
}
```

On approval (single transaction):
1. Load `experiments.proposed_content` (populated by Spec B's fork handler per Spec B §3.4). Reject with `proposed_content_missing` if NULL — the meta session never completed cleanly.
2. Validate population cap (Spec C invariant): the agent type must have fewer than 5 active variants; otherwise reject with `population_cap_exceeded`. (Candidates don't count toward the cap at approval time; the cap is re-checked at graduation time.)
3. INSERT a new `skill_versions` row directly: `content = <experiments.proposed_content>`, `parent_version_id = <operation.parent_variant_id>`, `specialty = <operation.specialty>`, `status = 'candidate'`, `traffic_share = 0.0`, `lineage_root_id = <resolveLineageRoot(parent_variant_id)>`. Allocation layer is not used for the initial insert — it updates existing rows.
4. Compute and store `specialty_embedding` on the new row.
5. Emit a `traffic_allocated` event with `old_status = NULL`, `new_status = 'candidate'`, `old_traffic_share = NULL`, `new_traffic_share = 0.0`, `reason = 'meta_fork_approved'`. This keeps the allocation event log complete (every variant's state history is reconstructable from events alone), even though the initial insert bypasses the allocation layer.
6. Transition the `experiments` row to `status = 'active'`.
7. If evidence cited a `fork_proposal_id`, mark that proposal `status = 'acted_on'` with `acted_on_experiment_id` set.
8. Emit `fork_approved` event.

Operation fields referenced above (`parent_variant_id`, `specialty`) are top-level fields on the operation object per Spec B §3.5, not nested under `evidence`.

Response: `{"variant_id": "v_new", "status": "candidate"}`.

**`POST /api/experiments/:id/reject-fork`** with body `{reviewer, reason}`. Transitions experiment to `status = 'discard'`; no skill_versions row created; emits `fork_rejected`. If evidence cited a `fork_proposal_id`, that proposal stays `open` (may be addressed by a future, better proposal).

### 6.3 CLI

Three subcommands wrapping the API:

- `autoforge experiments list-pending` — renders the table of pending forks in a terminal-friendly format, with a short evidence summary per row.
- `autoforge experiments approve-fork <experiment_id> --approver <name> [--notes "..."]`
- `autoforge experiments reject-fork <experiment_id> --reviewer <name> --reason "..."`

These read the same endpoints; provided for operators who don't want to use curl.

### 6.4 Approver identity

MVP uses a free-form `approver` / `reviewer` string (trusted field, for audit purposes only). Real authentication is a follow-on when the dashboard UI ships (§13). Server logs the source IP alongside the approver string for basic accountability.

### 6.5 Auto-timeout

A daily check transitions any `experiments` row with `operation = 'fork'` AND `status = 'proposed'` AND `created_at < now - 30 days` to `status = 'discard'`. Emits `fork_rejected` with `reviewer: 'system'`, `reason: 'approval_timeout'`. Prevents indefinite pending state.

---

## 7. Merge operation

### 7.1 Eligibility

Meta's `merge` output must pass these preflight checks (enforced by Spec B's validator, extended by Spec D):

- Both `target_variant_ids` resolve to existing `skill_versions` rows.
- Both have the same `agent_type`.
- Both have the same `lineage_root_id`.
- Both have `status = 'active'` (cannot merge a baseline into something else — baseline role must be moved by swap first; cannot merge a retired or demoted variant).
- Each has ≥ 30 live task observations (from the `variant_selected` events stratified by the 60-day recency window).

If any check fails: reject the meta output with `meta_rejected`, reason identifies the violated rule.

### 7.2 Statistical test

Before execution, the handler runs:
- Kolmogorov-Smirnov two-sample test on the composite scores of the two variants (last 30 observations each).
- Absolute mean-composite difference.

If `ks_p_value < 0.30` OR `abs(mean_diff) ≥ 0.03`: reject with `merge_not_indistinguishable`. The statistical precondition is stricter than meta's own reasoning; meta's "these look similar" must be backed by the test.

### 7.3 Execution

If the test passes:

1. **Select the survivor:**
   - Higher mean composite wins. If within 0.005, use persona text length (shorter wins). If both within 5 chars, use older `created_at` (the more proven one).
   - Emit tie-breaker used in `variants_merged` event.
2. **Compose merged specialty:** The handler invokes a small LLM call (configured same model as embeddings / diagnostician) with a prompt: "Given specialty A '<...>' and specialty B '<...>', write a single unified specialty description ≤ 150 characters." Store the output as the survivor's new `specialty`. Recompute `specialty_embedding`.
3. **Retire the loser:** `adjustVariantAllocation(loserId, {kind: 'set_status', newStatus: 'retired', newTrafficShare: 0.0}, 'meta_merge')` — goes through Spec C's allocation, which emits `traffic_allocated`.
4. **Lessons:** no movement needed — both variants share `lineage_root_id`, so lessons already apply to the survivor via Spec B's lineage-based retrieval.
5. **Transition the meta experiment** to `status = 'active'` (not `keep` — merge doesn't produce something to test further; it concludes an experiment immediately).
6. Emit `variants_merged` event.

### 7.4 Cross-lineage merges

Explicitly rejected. If two variants in different lineages behave similarly, that's noted in logs but not acted on. A future follow-on may add cross-lineage merging (§13).

---

## 8. Validator additions

Spec B's meta output validator is extended:

1. **`fork` operation:**
   - If the parent lineage has zero active descendants (i.e., this is a first fork), `evidence.fork_proposal_id` **must** be present AND point to an `open`-status `fork_proposals` row whose `agent_type` matches.
   - If the parent lineage has at least one active descendant, `evidence.fork_proposal_id` is optional (but recommended).
2. **`merge` operation:**
   - Preflight per §7.1; failures produce `meta_rejected` with reason naming the violated rule.
3. **`retire_lessons` semantic check** (from Spec B):
   - Unchanged, but now additionally validates that the cited lesson ids exist and are `status = 'active'`.

These additions live in `src/orchestrator/meta-operations.ts` (the validator called by `submitMetaTask`). The JSON schema file (Spec B's `src/schemas/meta-output.schema.json`) doesn't need new fields — the added rules are semantic and checked after schema validation.

---

## 9. Capture points (where the code changes)

| File | Change |
|---|---|
| `src/db/migrations/008_fork_proposals.sql` (new) | `CREATE TABLE fork_proposals` |
| `src/db/migrations/009_specialty_embedding.sql` (new) | `ALTER TABLE skill_versions ADD COLUMN specialty_embedding BLOB` (backfill runs at first daemon startup, not inside the migration, because the call is network-dependent) |
| `src/personas/meta.md` (from Spec B, extended) | Prompt additions directing meta to query `fork_proposals` at session start |
| `src/personas/diagnostician.md` (new) | Diagnostician persona with strength-calibration rules |
| `src/orchestrator/diagnostic.ts` (new) | `runDiagnostic()`, scheduling (50-task counter + nightly cron), staleness sweep |
| `src/orchestrator/classifier.ts` (new) | Embedding-based specialty matching with fallback chain |
| `src/orchestrator/embedding.ts` (new) | Embedding model invocation with per-dispatch caching |
| `src/orchestrator/meta-operations.ts` | Adds `merge` handler per §7; extends `fork` handler per §6.2; validator additions per §8 |
| `src/orchestrator/service.ts` | Wires `runDiagnostic` into the 50-task counter + nightly scheduler; the classifier replaces Spec C's keyword matcher as primary |
| `src/web/routes/experiments.ts` (new) | `GET /experiments?status=proposed&operation=fork`, `POST /:id/approve-fork`, `POST /:id/reject-fork` |
| `src/web/routes/diagnostic.ts` (new) | `POST /diagnostic/run` — operator-triggered diagnostic |
| `src/cli/experiments.ts` (new) | CLI subcommands wrapping the API |
| `src/config/dispatch.json` | Adds `embedding_model`, `similarity_threshold`, `diagnostic_trigger_task_count`, `fork_approval_timeout_days` keys |
| `src/orchestrator/specialty-match.ts` | Retained as fallback in the classifier chain; no changes |

---

## 10. Implementation sequence

1. **Schema additions.** Migrations 008 (fork_proposals) and 009 (specialty_embedding column). Spec B's migration 007 (`experiments.proposed_content`) is a prerequisite and must have shipped before Spec D.
2. **Embedding module.** `embedding.ts` with a pluggable provider interface, tested with a mock provider, then wired to the configured small embedding model.
3. **Classifier module.** `classifier.ts` with fallback chain. Unit tests covering embedding hit, keyword fallback, baseline fallback, embedding-call failure.
4. **Spec D replaces Spec C's specialty matcher as primary.** Dispatch continues to work without any population > 1 (classifier returns baseline-only). Tested end-to-end with a synthetic multi-variant population.
5. **Diagnostician persona + `runDiagnostic()`.** Persona file, input assembly, dispatch, output parsing, `fork_proposals` insert, staleness sweep. Tested with fixture task histories.
6. **Diagnostic scheduling.** 50-task counter in orchestrator; nightly cron via small internal scheduler; manual `POST /diagnostic/run` endpoint.
7. **Approval API + CLI.** Endpoints in `experiments.ts`; CLI subcommands; auto-timeout daily check.
8. **Approval handler replaces Spec B's placeholder.** Creates the `skill_versions` row, computes embedding, transitions experiment, emits events. Tested end-to-end against Spec C's candidate lifecycle (approved candidate enters shadow).
9. **Merge handler and validator extensions.** §7 behavior; §8 validator rules. Tested with synthetic variants passing and failing the indistinguishability test.
10. **Specialty-embedding backfill on first startup.** For rows with non-NULL specialty and NULL specialty_embedding, compute embeddings; log failures.

Steps 1-3 are prerequisites. Step 4 requires 2-3. Steps 5-6 require 1. Steps 7-8 require 6. Step 9 requires 8. Step 10 runs operationally post-deploy.

---

## 11. Testing strategy

- **Diagnostician output validation.** Fixture 100-task datasets: homogeneous (expect 0 clusters), bimodal (expect 1-2 clusters), noisy (expect 0 clusters with acceptable signal). Assert structured output conformance.
- **Staleness sweep.** Seed old `fork_proposals` rows; assert they transition to `stale` on next run.
- **Classifier fallback chain.** Embedding returns a hit → use it; embedding returns below threshold → use keyword fallback; embedding call fails → use keyword fallback; no matches anywhere → return baseline only.
- **Classifier similarity threshold.** A task described as "add CSS module to button" with one variant `specialty = "React component styling"` and another `specialty = "database migrations"`: first eligible, second not.
- **Cache correctness.** Same task description within one dispatch computes embedding once.
- **Fork approval happy path.** Meta submits a fork-operation proposal; `GET /experiments?status=proposed&operation=fork` returns it; approval creates the candidate via `adjustVariantAllocation`; Spec C's shadow auto-picks it up on the next task.
- **Fork approval rejects when at population cap.** Approval with 5 existing active variants → `population_cap_exceeded`; no skill_versions row created.
- **Fork auto-timeout.** A 31-day-old proposed fork transitions to discard with reason `approval_timeout`.
- **Fork evidence requirement.** A fork proposing to a new lineage without a `fork_proposal_id` in evidence → `meta_rejected`. A fork within an already-approved lineage without a proposal id → accepted.
- **Merge happy path.** Two variants with sufficient history and similar score distributions → merge executes; survivor gets unified specialty + new embedding; loser transitions to retired; `variants_merged` emitted.
- **Merge rejected on dissimilarity.** Two variants with different score distributions → `merge_not_indistinguishable` rejection; no state changes.
- **Merge rejected on insufficient data.** Variant with 25 observations → rejected.
- **Merge rejected on cross-lineage.** Two variants with different `lineage_root_id` → rejected at validator.
- **CLI parity.** Each CLI subcommand produces the same effect as its API counterpart.
- **End-to-end autonomous loop.** Fixture timeline: empty system → 50 tasks run (diagnostic fires, clusters detected) → meta proposes fork citing a proposal → operator approves → shadow runs (Spec C) → candidate graduates → accumulates traffic → two specialists converge → meta proposes merge → merge executes. All steps scripted; human action only at approval.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Diagnostician hallucinates clusters that aren't real | Strength-calibration rules; meta treats weak proposals as advisory only; proposals expire after 14 days if unacted |
| Embedding model cost scales linearly with task volume | Per-dispatch caching (one embedding per task, shared across agent types); cost is fractional cents per task |
| Embedding similarity threshold (0.55) is arbitrary | Configurable; follow-on calibration task noted in §13; baseline is always eligible as safety net |
| Approval workflow is API/CLI only — easy to miss a pending proposal | Auto-timeout prevents indefinite pending; `list-pending` is easy to run; dashboard UI is a known follow-on (§13) |
| Free-form approver string is trivially spoofable | MVP trust model; real auth arrives with dashboard UI (§13) |
| Merge LLM-composed specialty text may be low-quality | Length capped at 150 chars; operator can manually re-specify via a subsequent `edit` operation on the merged variant |
| Embedding backfill on startup fails for some rows | Fallback chain ensures dispatch still works via keyword match; failed rows can be retried via manual `POST /variants/:id/recompute-embedding` (added if the need arises — not in MVP) |
| Heterogeneity diagnostic runs in parallel with other work and creates latency spikes | Budget capped at 90s; scheduled during low-traffic windows by default (nightly) |
| Meta proposes a merge that's technically valid but loses useful diversity | Statistical test is the authority; if the two variants really do overlap statistically, merging is correct |
| Classifier embedding provider unavailable for extended period | Fallback chain (keyword match → baseline only) keeps dispatch working; alert raised after N consecutive failures |

---

## 13. Follow-on UI and future candidates

This section explicitly enumerates known future work. The umbrella's corresponding section is updated in parallel with these entries.

### 13.1 Dashboard UI (priority: high)

A web dashboard is outside the scope of every spec in this arc. It should be its own follow-on spec. Requirements it needs to meet:

- **Population view** — per agent type, list of variants with status, traffic_share, specialty, recent score; view a variant's score history over time.
- **Lineage view** — tree of variants per agent type; retired variants shown greyed-out; click-through to see each variant's genealogy.
- **Approval queue** — pending forks with evidence, proposed content preview, approve/reject buttons. Replaces CLI as primary operator interface.
- **Lessons browser** — view active lessons per agent type / lineage / failure category; search by keyword.
- **Diagnostic output** — see current `fork_proposals` with cluster labels, representative tasks, score gaps.
- **Allocation timeline** — visualize `traffic_allocated` events over time per variant.
- **Real auth** — replaces free-form approver strings; integrates with the operator's identity system.

### 13.2 Future candidates (not yet scoped)

Each of these was explicitly raised during the design arc and intentionally deferred. Listed here so they don't fall out of memory.

| Candidate | Origin | Notes |
|---|---|---|
| Replay-based shadow evaluation | Spec C §5.2 | Alternative to parallel shadow if cost becomes prohibitive; uses historical completed tasks as an eval set |
| Bandit upgrade (Thompson / UCB) beyond ε-greedy | Spec C §2 | More statistically efficient traffic allocation; `select_variant()` interface is stable |
| Embedding-based lesson retrieval | Spec B §2 | Replaces keyword-based retrieval; noted as additive follow-on if keyword matching proves too noisy |
| Lesson clustering / deduplication beyond supersession | Spec B §2 | If the lessons corpus grows unwieldy |
| Multi-candidate optimizer (DSPy / TextGrad / OPRO style) | Umbrella §12 | Meta proposes K candidates, scorer picks best. Different experimentation model from P |
| Skill-attachment learning | Umbrella §12 | Which skills are attached to which agent type becomes a learnable decision |
| Cross-project specialization | Umbrella §12 | Per-project populations, per-project weights |
| Cross-lineage merging | Spec D §7.4 | Two variants from different lineages that have converged |
| Multi-agent lesson attribution | Spec B §4.6 | A lesson that genuinely applies to both planner and coder is currently assigned to one |
| Per-project allocation / weight overrides | Spec A §6.2, Spec C §2 | Reward weights and traffic share currently global |
| Resurrection of retired variants | Spec C §5 | If a retired variant becomes relevant again |
| LLM-based routing classifier at dispatch | Spec D §5 | If embedding-based similarity proves insufficient for ambiguous cases |
| Joint optimization across agent types | Spec C §4.4 | Today each agent type's population evolves independently |
| DB-backed reward weights with history | Spec A §6.2 | Current weights are a config file requiring restart |
| `failure_category` normalization in `review_findings` | Spec A §5.3 | Partially handled in Spec B's reflector output; full normalization is a cleanup |
| Trajectory-level credit assignment (Reflexion-style) | Spec B background | When a multi-stage failure is correctly attributable across planner → coder → reviewer |
| Calibration of the 0.55 similarity threshold | Spec D §5.4 | Tune against ground-truth labeled tasks |
| Removal of the ad-hoc `archived_at` ALTER | Spec A §3 | Delete the ad-hoc ALTER statement from `initSchema()` once it can be folded into schema.sql as a first-class definition |
| Move `is_active` off the schema entirely | Spec A §4.6 | Compatibility shim retained; cleanup is follow-on once all consumers read `status` |

---

## 14. Success criteria

Spec D is complete when:

1. The heterogeneity diagnostic runs on its schedules, produces `fork_proposals` rows with strength calibration, and marks stale proposals correctly.
2. Meta can reference an `open` `fork_proposal` as evidence; the validator enforces the citation rule for first forks.
3. `GET /api/experiments?status=proposed&operation=fork` returns pending first-forks with evidence and content preview; `POST .../approve-fork` and `POST .../reject-fork` transition state correctly.
4. CLI subcommands parity: `autoforge experiments list-pending`, `approve-fork`, `reject-fork`.
5. Auto-timeout discards proposed forks older than 30 days.
6. The approval handler creates the `skill_versions` row via `adjustVariantAllocation`, computes the embedding, and Spec C's dispatcher routes tasks to it via the embedding-based classifier.
7. The classifier routes a task to a specialty-matched variant when the cosine similarity exceeds 0.55; falls back to keyword match when embedding is NULL; falls back to baseline when no match.
8. `merge` operations validate preflight and execute correctly: survivor retains / merged specialty / new embedding; loser retired; `variants_merged` emitted.
9. End-to-end autonomous scenario: synthetic task stream produces a diagnostic cluster → meta proposes fork → approval creates candidate → Spec C shadow → graduation → eventually a second specialist appears and the merge flow retires the weaker one. Runs without human intervention after the one approval.
10. All specs A, B, C, D combined pass a full regression test suite; the umbrella's success criteria (§14 of the umbrella) are all satisfied.

When these hold, the autonomous curation loop is complete. Future improvements (§13 of this spec) are optional refinements, not missing essentials.
