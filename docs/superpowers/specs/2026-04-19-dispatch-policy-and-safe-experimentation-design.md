# Spec C — Dispatch Policy and Safe Experimentation

**Status:** Proposed
**Date:** 2026-04-19
**Parent:** [`2026-04-19-self-improving-persona-population-design.md`](./2026-04-19-self-improving-persona-population-design.md)
**Depends on:** [`2026-04-19-observability-and-reward-foundation-design.md`](./2026-04-19-observability-and-reward-foundation-design.md) (Spec A)
**Coordinates with:** [`2026-04-19-curator-meta-and-lessons-design.md`](./2026-04-19-curator-meta-and-lessons-design.md) (Spec B)
**Scope:** Layer 4 of the umbrella. Replaces Spec A's stub `select_variant()` with the real dispatch policy. Implements parallel shadow evaluation for new candidates, sequential statistical testing for promotion / demotion, automatic rollback on regression, and the single allocation write path that meta operations and auto-decisions both go through.

---

## 1. Purpose and success

Spec C makes the population work **dynamically and safely**. After Spec C ships:

- Tasks are routed across the live population by ε-greedy dispatch with a hard baseline-traffic floor.
- New candidates earn real traffic only after passing a paired shadow evaluation against the baseline — never silently deployed.
- Active variants are promoted, demoted, and eventually retired automatically based on rolling-window statistical evidence; no human `/conclude` calls.
- Meta's manual `promote` / `demote` / `retire` operations and the system's automatic adjustments share a single transactional write path, so the two never race or conflict.
- The baseline-floor invariant (≥ 50% of dispatched traffic) is enforced at allocation time and is never violated, even during a regression event.

What Spec C does **not** deliver (owned elsewhere):
- The routing classifier for population > 1 (Spec D — Spec C uses naive keyword match as a placeholder)
- Heterogeneity diagnostic / forking criteria enforcement (Spec D)
- Merging logic (Spec D)
- Dashboard surface (follow-on)

---

## 2. Scope

**In scope**
- New module `src/orchestrator/dispatch.ts` exporting `select_variant(agent_type, task_context)` — replaces Spec A's stub
- New module `src/orchestrator/allocation.ts` exporting `adjustVariantAllocation(variantId, op, reason)` — the single transactional write path for `traffic_share` and `status`
- New module `src/orchestrator/shadow.ts` orchestrating the parallel shadow execution for candidates
- New module `src/orchestrator/sequential-test.ts` implementing the rolling-window Wilcoxon comparison
- New module `src/orchestrator/auto-tuner.ts` (cron / on-task-completion hook) that runs the sequential test and triggers promotion / demotion / retirement
- Naive specialty matcher `src/orchestrator/specialty-match.ts` (placeholder until Spec D's classifier)
- New event type `traffic_allocated` capturing every traffic-share or status change
- New event type `shadow_run_completed` recording the candidate's parallel execution outcome paired to its baseline counterpart
- Extension of `variant_selected` payload — fills in `selection_rationale` (`baseline | exploitation | exploration | shadow_parallel`) and `shadow_variant_ids` properly
- Spec B's `meta-operations.ts` integration — `promote`, `demote`, `retire` route through `adjustVariantAllocation`
- Tests covering policy mechanics, shadow execution, graduation, promotion / demotion, baseline swap, baseline-floor enforcement, allocation contention

**Out of scope (owned by later specs or deferred)**
- Routing classifier with semantic understanding (Spec D)
- Heterogeneity diagnostic firing forking proposals (Spec D)
- Merging two indistinguishable variants (Spec D)
- Dashboard for traffic-share evolution and shadow run results (follow-on)
- Replay-based shadow evaluation (deferred — keeps cost down at the price of past-only evaluation; revisit if parallel shadow is too expensive in practice)
- Per-project allocation overrides (cross-project scoping is umbrella non-goal)
- Bandit upgrade beyond ε-greedy (Thompson, UCB) — left as future work; the `select_variant()` interface is stable across upgrades

---

## 3. Data model

### 3.1 No schema additions

All required columns (`status`, `traffic_share`, `parent_version_id`, `specialty`) are already in `skill_versions` per Spec A migration 001. The `experiments.operation` and `experiments.evidence` columns from Spec A are also reused.

### 3.2 New events

**`traffic_allocated`** — every change to a variant's `traffic_share` or `status` emits one, regardless of whether the change came from meta, auto-tuner, graduation, or initial creation at fork approval.

```json
{
  "variant_id": "abc123",
  "agent_type": "coder",
  "old_status": "candidate",
  "new_status": "active",
  "old_traffic_share": 0.0,
  "new_traffic_share": 0.1,
  "reason": "auto_graduation | auto_promote | auto_demote | auto_retire | meta_edit | meta_promote | meta_demote | meta_retire | meta_fork_approved | meta_merge | baseline_swap",
  "supporting_metric": {
    "test": "wilcoxon_paired",
    "window_size": 30,
    "p_value": 0.034,
    "candidate_mean": 0.71,
    "baseline_mean": 0.62
  }
}
```

`old_status` and `old_traffic_share` are `null` for the initial insert of a newly-approved candidate (Spec D §6.2), signalling that this is the variant's first row in the allocation history. For all subsequent transitions they reflect the prior state. `supporting_metric` is required when `reason` starts with `auto_`; absent or summary-only when `reason` starts with `meta_`.

**`shadow_run_completed`** — emitted once per shadow execution; pairs the candidate's outcome to the baseline outcome on the same task.

```json
{
  "task_id": "t_007",
  "agent_type": "coder",
  "baseline_variant_id": "abc",
  "candidate_variant_id": "def",
  "baseline_score_components": { "r_correctness": 1.0, "r_simplicity": 0.7, ... },
  "candidate_score_components": { "r_correctness": 1.0, "r_simplicity": 0.6, ... },
  "baseline_composite": 0.74,
  "candidate_composite": 0.69,
  "baseline_lessons_injected": 5,
  "candidate_lessons_injected": 5,
  "baseline_executor_used": "anthropic-sdk",
  "candidate_executor_used": "anthropic-sdk"
}
```

`shadow_run_completed` is what the sequential tester aggregates into a paired sample for graduation.

### 3.3 `variant_selected` payload — Spec C fills in the real fields

Spec A defined the shape; Spec B added `injected_lesson_ids`. Spec C now uses every reserved value:

- `selection_rationale: 'baseline'` — chosen as the baseline floor of the ε-greedy split.
- `selection_rationale: 'exploitation'` — chosen as a non-baseline `active` variant proportional to `traffic_share`.
- `selection_rationale: 'exploration'` — chosen via the ε branch (uniform over non-baseline eligibles).
- `selection_rationale: 'shadow_parallel'` — for the candidate side of a shadow run; never the live answer for the task.
- `selection_rationale: 'only_eligible'` — preserved from Spec A for the population-size-1 case.
- `shadow_variant_ids` — populated when a candidate is in shadow on this dispatch; empty otherwise.

---

## 4. The dispatch policy: `select_variant()`

### 4.1 Function signature

```typescript
interface SelectionResult {
  variantId: string;
  agentType: AgentType;
  rationale: 'only_eligible' | 'baseline' | 'exploitation' | 'exploration' | 'shadow_parallel';
  shadowVariantIds: string[];   // candidate variants to run in shadow alongside this dispatch
}

function selectVariant(
  agentType: AgentType,
  taskContext: { description: string; tier: Tier; projectId: string }
): SelectionResult;
```

Called once per agent type needed by a task. Returns the chosen live variant plus any candidates to shadow alongside it.

### 4.2 Specialty filter

For a population with size > 1:

1. Load all `status IN ('baseline', 'active', 'candidate')` variants for the agent type.
2. Compute task keywords via Spec B's `extractKeywords(description)`.
3. A variant is **specialty-eligible** if any of:
   - `specialty IS NULL` (generalist)
   - `specialty` keywords overlap with task keywords by ≥ 1 token
   - The variant is the baseline (always eligible regardless of specialty)
4. The eligible set is the input to the ε-greedy split.

For population size 1: skip filtering, use the only variant; emit `rationale = 'only_eligible'`.

### 4.3 ε-greedy split with baseline floor

Let `B` = the baseline variant (exactly one per agent type, invariant); let `A` = `active` non-baseline variants in the eligible set; let `C` = `candidate` variants in the eligible set.

Construct three probability buckets (sum to 1.0):

- **Baseline bucket** = `max(0.5, B.traffic_share)`. The baseline floor is the larger of 0.5 and whatever traffic share the baseline currently holds.
- **Exploration bucket** = `ε = 0.1` (configurable). Sourced uniformly at random over `A ∪ C`. (If `A ∪ C` is empty, the exploration bucket folds into the baseline bucket.)
- **Exploitation bucket** = `1 − baseline_bucket − exploration_bucket`. Distributed across `A` proportionally to `traffic_share`. (If `A` is empty, the exploitation bucket also folds into the baseline bucket.)

Roll a uniform random number on `[0, 1)`. Determine the bucket; pick a variant within the bucket. Emit a `variant_selected` event with the chosen variant and the corresponding rationale.

**Note on `traffic_share` semantics.** The field has two meanings depending on whether the variant is the baseline:

- **For the baseline:** `traffic_share` is the actual bucket size if it exceeds 0.5, else the floor 0.5 applies. Meta `promote` / `demote` operations can move it within `[0.5, 1.0 − ε]`.
- **For non-baseline `active` variants:** `traffic_share` is a *relative weight* within the exploitation bucket. The dispatcher normalizes the non-baseline `traffic_share` values so they sum to the exploitation bucket size at runtime. A non-baseline variant therefore *cannot* reach an absolute share ≥ 0.5 without first becoming the baseline (via swap, §7.4).
- **For `candidate` variants:** `traffic_share` is irrelevant for live selection (always 0); they receive only shadow runs and the exploration bucket sample.

**`shadowVariantIds`.** Independently of the live selection, every `candidate` in the eligible set that is still within its shadow window (§5) is included in `shadowVariantIds`. The orchestrator then dispatches those candidates in parallel (see §5).

### 4.4 Per-agent-type independence

A task that requires planner + coder calls `selectVariant('planner', ctx)` and `selectVariant('coder', ctx)` separately. Their results are independent. There is **no joint optimization** across agent types in MVP — each agent type's population evolves on its own.

### 4.5 Determinism for testing

The RNG is injectable via a `Dispatcher` factory; tests pass a seeded RNG. Production uses `crypto.randomBytes`-derived randomness.

---

## 5. Shadow evaluation

### 5.1 Trigger

When `selectVariant()` returns a non-empty `shadowVariantIds`, the orchestrator:

1. Dispatches the live variant; this is the source of truth for the task.
2. **In parallel** with the live dispatch (subject to the upstream-dependency rules in §5.1.1), for each shadow variant:
   - Allocates a separate worktree (clone of the task's working directory at the same base ref).
   - Resolves the same task context, persona (the candidate), skills, and lessons that would be retrieved for the candidate via Spec B's `retrieveLessonsForDispatch`.
   - Calls `executor.execute(...)` for the candidate. Output is written to the shadow worktree but never propagated to the task's main worktree or PR.
3. Waits for the candidate run to terminate (same budget as live).
4. Computes the candidate's `task_quality_score` components from its events + diff stats (using Spec A's view contract; the shadow worktree's artifacts feed into Spec A's `computeDiffStats`, but rows are written to a per-shadow ephemeral table — see §5.1.2 — not into `task_diff_stats`).
5. Emits a `shadow_run_completed` event pairing the live and shadow scores.
6. Cleans up the shadow worktree (regardless of outcome).

#### 5.1.1 Multi-agent shadow timing

A task often involves multiple agents (planner → coder → reviewer). Shadow timing depends on which agent type the candidate belongs to:

- **Shadowing the planner.** The shadow planner runs in parallel with the live planner. Both produce plans; the live plan flows to the live coder. The shadow plan is scored but never executed by a coder — its score is computed against `task_quality_score` components that don't depend on downstream agents (essentially planner-only metrics: planner_fallback, scope-prediction accuracy, plan structure). This is a less complete signal, but appropriate — judging the planner on the coder's eventual outcome would be confounded.
- **Shadowing the coder.** Must wait for the live planner to finish so its output can be reused as the candidate coder's input. Then live coder and shadow coder run in parallel from the same plan.
- **Shadowing the reviewer.** Must wait for the live coder to finish. Live reviewer and shadow reviewer then run in parallel against the same coder output.
- **Shadowing the doc agent.** Same pattern — wait for the upstream live agent, then run live and shadow doc agents in parallel.

In all cases the upstream live output is held constant for the shadow comparison, so the variance attributable to the shadowed variant alone is isolated. Shadowing **two different agent types simultaneously** within one task is forbidden in MVP — too many degrees of freedom to compare cleanly.

#### 5.1.2 Shadow score storage

Shadow scores are not written to `task_diff_stats` or `task_quality_score` (those would conflate live and shadow rows). Instead, shadow components live entirely inside the `shadow_run_completed` event payload and a derived view `shadow_quality_score` that mirrors `task_quality_score`'s shape but reads from those events. Spec A's view layer is unchanged.

### 5.2 Cost note

Shadow runs cost a full extra executor call per shadowed candidate per task. With ε = 0.1 and small candidate populations, this is bounded but real. Documented as a known cost; no MVP optimization. If cost becomes prohibitive, Spec D can introduce replay-based evaluation.

### 5.3 Failure modes

- **Shadow run errors out** (executor failure, worktree cleanup failure): emit `shadow_run_completed` with `candidate_score_components: null` and `error: <reason>`. The pair is not counted toward graduation; if a candidate has 5 consecutive errored shadow runs, it auto-transitions to `demoted` with reason `auto_demote` and supporting_metric `{ "reason": "shadow_repeatedly_failed" }`.
- **Live run errors out:** the candidate run is cancelled (no point comparing against a failed baseline); no shadow event recorded for that task.
- **Worktree race:** shadow worktrees are created from a snapshot of the base ref, never from the live worktree. No file conflicts possible.

### 5.4 Concurrency

Multiple candidates can be in shadow simultaneously, each in its own worktree, all dispatched in parallel after the live run starts. Hard ceiling: at most **3 concurrent shadow runs per agent type per task** (cost protection). If more candidates are eligible, only the 3 most recently created (by `created_at` DESC) are shadowed; the rest wait their turn.

### 5.5 Lessons in shadow

The candidate's shadow run gets its own lesson retrieval (its lineage's lessons, with K=5, just like a live run). This means a candidate may use lessons the baseline did not, and vice versa. The `shadow_run_completed` event records `baseline_lessons_injected` and `candidate_lessons_injected` counts so later analysis can tease apart "did the new persona help" from "did the new lessons help."

---

## 6. Cold-start graduation

### 6.1 Aggregation

`auto-tuner.ts` runs after every `shadow_run_completed` event for the affected agent type. It loads the rolling sample of paired scores for that candidate vs its baseline.

### 6.2 Graduation predicate

A candidate graduates from `candidate` to `active` when **all** of:

- **N ≥ 10**: at least 10 paired observations exist (errored runs do not count).
- **No critical regression**: for every reward term `t` ∈ {correctness, simplicity, alignment, fidelity, efficiency}, `mean(candidate.r_t) − mean(baseline.r_t) ≥ −0.15`. Prevents a variant that's "overall slightly better but catastrophically worse on correctness" from graduating.
- **Composite ≥ baseline**: `mean(candidate.composite) ≥ mean(baseline.composite)` on the same N tasks.
- **Statistically credible**: one-sided Wilcoxon signed-rank test on composite scores has p ≤ **0.10** for "candidate ≥ baseline." (Looser than the promotion threshold of 0.05 below — graduation is a green light to *enter* the rotation, not to win it.)

On graduation: status → `active`; `traffic_share = 0.10` (initial allocation, configurable); the experiment row associated with this candidate transitions `status` → `active`; emit `traffic_allocated` with `reason: 'auto_graduation'`.

### 6.3 Failed graduation (timeout)

If a candidate has accumulated **M ≥ 20 valid paired observations** without satisfying the graduation predicate: status → `demoted`; `traffic_share = 0.0`; the experiment transitions `status` → `discard`; emit `traffic_allocated` with `reason: 'auto_demote'` and supporting_metric explaining the failure (which predicate failed and by how much).

The candidate's `skill_versions` row is **not** retired immediately. It sits in `demoted`, and the auto-retire timer (§7.5) will eventually retire it if no `promote` action revives it.

### 6.4 Configurability

`N`, `M`, the regression-tolerance δ, and the p-value thresholds live in `src/config/dispatch.json`. MVP defaults are the values above. Per-agent-type overrides are not supported in MVP.

---

## 7. Sequential testing for active variants

### 7.1 What's tested

For each `active` non-baseline variant, the auto-tuner maintains a rolling window of the most recent **30** terminal tasks where that variant was *live* (`rationale ∈ {exploitation, exploration}`, not shadow). The same 30 tasks' baseline equivalents — what the baseline scored on tasks of similar tier and project — form the comparison.

**Why this comparison is *not* paired:** an active variant doesn't run alongside the baseline (only candidates in shadow do). So the comparison is between this variant's recent live runs and the baseline's recent live runs in the same tier/project bucket. We use a Mann-Whitney U test (the unpaired analogue of Wilcoxon) and stratify by tier.

### 7.2 Promotion / demotion predicates

For each active variant, evaluate after every task it served:

- **Promotion:** Mann-Whitney U on composite scores (variant vs baseline, stratified by tier) yields p ≤ 0.05 in favor of the variant, AND mean(variant) − mean(baseline) ≥ +0.05. Action: `traffic_share += 0.05`, capped by `1.0 − baseline_traffic_share − ε`. Reason: `auto_promote`.
- **Demotion:** Same test in the *opposite* direction at p ≤ 0.05. Action: `traffic_share -= 0.05`. Reason: `auto_demote`. If `traffic_share` drops to 0.0, status → `demoted`.
- **Continue:** otherwise no change.

Adjustments are bounded — no single test can swing more than ±0.05 on `traffic_share`. Prevents thrashing.

### 7.3 Window stale-data eviction

Observations older than **L = 60 days** are evicted from the rolling window even if there are fewer than 30 newer ones. Better to test on insufficient recent data than on stale data — the codebase changes faster than 60 days.

### 7.4 Baseline swap

A non-baseline `active` variant cannot reach an absolute traffic share ≥ 0.5 by promotion alone (§4.3 — baseline always holds ≥ 0.5). The swap trigger is therefore based on **dominance over the rolling window**, not traffic share.

A non-baseline `active` variant is promoted to `baseline` when **all** of:

- It is the highest-scoring non-baseline `active` variant for its agent type (by composite mean over the rolling window).
- Its mean composite exceeds the current baseline's mean composite by ≥ **0.10** on the same window stratification (tier).
- The dominance has held for at least **20 consecutive evaluations** (auto-tuner runs after each task, so this is roughly 20 tasks where this variant participated live).
- The Mann-Whitney U test from §7.2 has p ≤ 0.01 in favor of the candidate-baseline (tighter than the promotion threshold; swapping a baseline is a more consequential action than nudging traffic share).

When the swap fires: the old baseline transitions to `active` with `traffic_share = 0.4` (the maximum a non-baseline can hold per §4.3 with ε = 0.1). The new baseline takes `status = 'baseline'` with `traffic_share` initially set to its prior value, then dispatch's `max(0.5, traffic_share)` floor takes over. The swap is atomic in `allocation.ts`. Emits two `traffic_allocated` events with reason `baseline_swap`.

The swap is atomic in `allocation.ts`. Emits two `traffic_allocated` events: one demoting the old baseline, one promoting the new. Reason: `baseline_swap`.

### 7.5 Auto-retirement

A variant in `demoted` for **L = 90 days** without any `promote` action is auto-transitioned to `retired`. Its `traffic_share` is already 0; status → `retired`; `retired_at = now`; lessons remain attached to the lineage per Spec B's lineage rules. Reason: `auto_retire`.

`L = 90 days` is configurable; MVP default.

### 7.6 What runs the auto-tuner

After every `task_completed` or `task_failed` event, the orchestrator calls `autoTuner.evaluate(taskId)` synchronously. The auto-tuner:

1. Identifies all variants involved in the task (from `variant_selected` events).
2. For candidates: runs §6.2 graduation predicate.
3. For active non-baseline variants: runs §7.2 promotion/demotion predicates.
4. For all variants involved: emits `traffic_allocated` events as needed.

Cost is small (a few SQL queries per call). No background cron in MVP. The 90-day auto-retire is an exception — it runs once at server startup and once daily.

---

## 8. The single allocation write path

### 8.1 Why single

Both meta and the auto-tuner mutate `traffic_share` and `status`. Without coordination they would race or stomp each other. Spec B's `meta-operations.ts` was specified to "write traffic_share" but Spec C makes the actual writes go through this module.

### 8.2 API

```typescript
type AllocationOp =
  | { kind: 'graduate'; newTrafficShare: number }
  | { kind: 'promote'; delta: number }
  | { kind: 'demote'; delta: number }
  | { kind: 'set_status'; newStatus: VariantStatus; newTrafficShare?: number }
  | { kind: 'baseline_swap'; newBaselineId: string };

function adjustVariantAllocation(
  variantId: string,
  op: AllocationOp,
  reason: AllocationReason,
  supportingMetric?: SupportingMetric
): void;  // synchronous, transactional
```

Implementation:
1. Open a SQLite transaction.
2. Read the current row, the agent type's full population, and the current baseline.
3. Compute the proposed new state.
4. Apply invariants (§8.3); reject if any violates.
5. Update `skill_versions` (one or two rows for swap).
6. Insert a `traffic_allocated` event.
7. Commit.

A failed invariant returns an error to the caller; meta sees this as a rejected operation (`meta_rejected` event); auto-tuner logs and skips the cycle.

### 8.3 Invariants checked at write time

These are enforced inside `allocation.ts` and are non-negotiable:

- **Exactly one baseline per agent type.** A swap is the only way to change the baseline; it atomically moves the role.
- **Baseline `traffic_share` ≥ 0.5.** A demote that would push it below this fails.
- **No variant has `traffic_share` > 1.0** (sanity).
- **Sum of `traffic_share` across `status IN ('baseline', 'active', 'candidate')` for the agent type is irrelevant** — the dispatcher handles normalization. Trying to enforce a sum invariant is a footgun (a single demote shouldn't have to compensate elsewhere). Sums are reported in metrics, not enforced.
- **A retired variant cannot be re-promoted.** Resurrection is YAGNI; meta must `fork` from the parent if a similar variant is wanted.
- **Sole-baseline retirement is forbidden.** A variant cannot be `retired` if it is the only `baseline` in its agent type. Meta must promote a replacement first.
- **Population cap (5 per agent type) enforced on transitions to `active` or `baseline`.** A graduation that would exceed the cap fails; a fork at-cap was already rejected at meta-output validation per Spec B.

---

## 9. Auto-rollback

Auto-rollback is not a separate mechanism. It's the outcome of:

- Q4 demotion (§7.2): a regressing active variant has its `traffic_share` decreased step by step.
- Q5 lifecycle (§5.3): a candidate that fails shadow evaluation is demoted automatically.
- Q5 baseline swap (§7.4): if the baseline itself regresses such that another variant exceeds it consistently, the swap moves the role to the better variant.

The system does **not** roll back a single bad task — that would be brittle. Rollback is statistical, requires a rolling window of evidence, and operates on traffic share (gradual) rather than a hard kill.

Manual override is always available via meta's `promote` / `demote` / `retire` operations, all of which go through `adjustVariantAllocation`.

---

## 10. Capture points (where the code changes)

| File | Change |
|---|---|
| `src/orchestrator/dispatch.ts` (new) | `selectVariant()` per §4 |
| `src/orchestrator/allocation.ts` (new) | `adjustVariantAllocation()` per §8; invariant checks |
| `src/orchestrator/shadow.ts` (new) | Shadow worktree creation, parallel execution, scoring, `shadow_run_completed` emission |
| `src/orchestrator/sequential-test.ts` (new) | Wilcoxon paired (graduation) and Mann-Whitney U stratified (active) |
| `src/orchestrator/auto-tuner.ts` (new) | Aggregates after each terminal task, runs predicates, calls `adjustVariantAllocation` |
| `src/orchestrator/specialty-match.ts` (new) | Naive keyword match; replaced by Spec D's classifier later |
| `src/orchestrator/service.ts` | Replaces Spec A's stub `selectVariant` call with the real one; integrates shadow dispatch in the task lifecycle; calls `autoTuner.evaluate()` on terminal transitions |
| `src/orchestrator/meta-operations.ts` | `promote` / `demote` / `retire` route through `adjustVariantAllocation` (Spec B placeholder writes are removed) |
| `src/config/dispatch.json` (new) | ε, N, M, δ, p-value thresholds, window sizes, auto-retire timer |
| `src/db/client.ts` | Helpers: `loadActivePopulation(agentType)`, `loadShadowPairs(candidateId)`, `loadRecentTaskScores(variantId, window)` |
| `src/web/routes/variants.ts` (new) | Read-only endpoints: list active variants per agent type, view a variant's recent score history, view current allocations. (Approval endpoint stays in Spec D.) |

No schema changes; no new tables.

---

## 11. Implementation sequence

### 11.0 Backward compatibility note

Spec B may ship before Spec C. In the interim, meta's `edit` operation creates `candidate` rows that sit waiting for shadow evaluation that doesn't exist yet. When Spec C ships:

- Existing `candidate` rows are picked up automatically by the auto-tuner on the next terminal task and enter shadow evaluation from a clean state (zero accumulated paired observations).
- Existing `experiments` rows in `proposed` or `active` status remain unchanged; the auto-tuner reads them as-is.
- The `is_active` compatibility shim from Spec A continues to work — Spec C does not remove it.
- No data migration is required. The cutover is operational, not schema-level.

### 11.1 Build order

1. **`allocation.ts` and invariants.** With unit tests for every invariant. This is the foundation; everything else writes through it.
2. **Replace meta-operations writes.** Spec B's `promote`/`demote`/`retire` handlers route through `adjustVariantAllocation`. Tests confirm meta operations cannot violate invariants.
3. **Naive `specialty-match.ts`.** Keyword extraction (reused from Spec B), match function, tests with fixture variants and tasks.
4. **`dispatch.ts` ε-greedy.** Replace Spec A's stub `selectVariant`. Unit tests with seeded RNG covering: pop size 1, pop size > 1 with no candidates, pop size > 1 with candidates, baseline-floor enforcement, exploration sampling, exploitation weighting.
5. **Shadow worktree infrastructure.** `shadow.ts` worktree creation, parallel execution wiring, score aggregation, `shadow_run_completed` event emission. Integration test with a mock executor that returns canned outputs.
6. **`sequential-test.ts`.** Wilcoxon paired and Mann-Whitney U implementations (or wrap a small library). Unit tests on synthetic distributions.
7. **`auto-tuner.ts` graduation path.** Wire into `service.ts` on terminal transitions. End-to-end test: candidate → 10 shadow tasks → graduates → status flips, traffic_share = 0.10.
8. **`auto-tuner.ts` promotion/demotion path.** Same wiring; tests with synthetic rolling-window data.
9. **Baseline swap.** `auto-tuner.ts` swap detector + `allocation.ts` swap support. End-to-end test where a non-baseline accumulates dominance and triggers swap.
10. **Auto-retirement timer.** Server-startup + daily check; tests use injectable clock.
11. **`variants.ts` read-only endpoints.** For operator visibility while we wait for dashboard work.

Steps 1-2 must come first. Step 3 is independent and can be done in parallel. Steps 4-5 require 1-3. Steps 6-9 require 1-5. Steps 10-11 are independent of 6-9.

---

## 12. Testing strategy

- **Allocation invariant tests.** Every invariant in §8.3 has at least one positive (passes) and one negative (rejected) test.
- **ε-greedy dispatch distribution.** With seeded RNG over 10,000 iterations, observed selection frequencies match the configured probabilities within a small tolerance.
- **Baseline floor.** No matter the population state, baseline gets ≥ 0.5 over a long sample.
- **Shadow run end-to-end.** Mock executor; assert `shadow_run_completed` event payload structure; assert worktree cleaned up; assert candidate's failure does not affect the live run's outcome.
- **Graduation timing.** Synthetic paired observations: 10 strongly-positive tasks → graduates with reason `auto_graduation`. 20 mixed tasks → demoted with reason `auto_demote`.
- **Critical regression block.** A candidate with high overall composite but `r_correctness` worse by 0.20 fails graduation.
- **Promotion / demotion thrashing.** A noisy active variant near zero effect does not oscillate (the ±0.05 step + p-value threshold prevent this).
- **Baseline swap.** A non-baseline that consistently outperforms triggers a swap; previous baseline retains its prior `traffic_share` (capped at 0.4).
- **Sole-baseline retirement guard.** Cannot retire the only baseline.
- **Population cap on graduation.** A graduation that would push active count past 5 fails with reason `population_cap`.
- **Concurrency.** Two simultaneous shadow runs against the same candidate (across two tasks) both complete; events are pair-correctly recorded.
- **Allocation contention.** Meta `demote` and auto `auto_promote` racing on the same variant: both serialize through `allocation.ts`; the second sees the first's state and reasons about it correctly (or no-ops).

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 2× executor cost during shadow windows | Acknowledged. Cost ceiling: 3 simultaneous shadows per agent type per task. Replay-based shadow is a Spec D follow-on |
| Naive keyword specialty matcher misroutes some tasks | Acceptable for MVP. Baseline is always eligible as catch-all. Spec D's classifier replaces |
| Wilcoxon / Mann-Whitney assumes exchangeability — codebase drift breaks it | Stale-data eviction (60d for active window, fresh restart for graduation samples) limits drift impact |
| Sequential testing produces false positives at scale (many variants × many tasks) | Conservative thresholds (p ≤ 0.05 plus mean-difference ≥ 0.05) limit this; rolling window with stale eviction and the ±0.05 step further damp; not corrected for multiple testing in MVP |
| Auto-retirement loses a variant that would have come back into use | 90-day window is generous; lessons preserved on lineage so future similar forks inherit memory |
| Allocation write contention (meta vs auto-tuner) | Single transactional write path; tests confirm serialization |
| Dispatcher RNG is not reproducible across processes | Test injection ok; production sees a single process per orchestrator instance |
| A candidate stuck in shadow forever because tasks never reach it (low ε, large population) | Spec C does not solve this directly; if a candidate has not received a shadow run in 90 days, the auto-retirement timer treats it as a `demoted` candidate (configurable) |
| Cross-agent-type interaction (improving the planner makes the coder look better) is not modeled | Per-agent-type independence is a YAGNI choice; if a real interaction problem emerges, joint testing is a future enhancement |

---

## 14. Success criteria

Spec C is complete when:

1. `selectVariant()` returns variants per the ε-greedy + baseline-floor policy; tested distributions match the configuration to within 1%.
2. A new candidate variant created via Spec B's `edit` operation is observed to (a) receive shadow runs paired to baseline runs, (b) accumulate a paired sample, (c) graduate or fail out automatically.
3. The first time an active non-baseline variant is observed to dominate the baseline at p ≤ 0.05 over 30 tasks, its `traffic_share` increases by 0.05 automatically — recorded in a `traffic_allocated` event with reason `auto_promote`.
4. Conversely, a regressing variant has its `traffic_share` decrease and ultimately transitions to `demoted` automatically.
5. The baseline-traffic floor (≥ 0.5) is never violated in a 10,000-iteration distribution test.
6. All allocation writes — whether from meta or auto-tuner — go through `adjustVariantAllocation` and are reflected in `traffic_allocated` events with appropriate `reason` codes.
7. A variant in `demoted` for 90 simulated days transitions to `retired`; its lessons remain queryable via the lineage.
8. Sole-baseline retirement and population-cap violation are rejected at the allocation layer with explicit error events.
9. End-to-end test: from a population size 1 (baseline only) → meta proposes `edit` → candidate enters shadow → graduates → eventually accumulates evidence to trigger promotion → still later, regression triggers auto-demotion. Sequence runs against synthetic data without human intervention.

When these hold, the system is dynamically managing its population safely. Spec D adds the heterogeneity diagnostic, full forking workflow, merging, and a real classifier — but the dispatch and experimentation infrastructure is complete.
