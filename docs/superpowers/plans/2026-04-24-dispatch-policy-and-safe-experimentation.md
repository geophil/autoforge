# Autoforge Spec C — Dispatch Policy and Safe Experimentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Layer 4 of the self-improving-persona-population umbrella: safe variant dispatch, shadow evaluation, automatic graduation/promotion/demotion, baseline protection, and read-only allocation visibility.

**Architecture:** Additive orchestration modules sit beside the existing service: `allocation.ts` owns all `skill_versions.status`/`traffic_share` writes, `dispatch.ts` selects variants using an injectable RNG, `shadow.ts` records candidate comparisons, `sequential-test.ts` evaluates evidence, and `auto-tuner.ts` applies automatic lifecycle decisions through the allocation write path. `OrchestratorService` stops treating `PersonaRegistry.snapshotId()` as dispatch; it asks the dispatcher for a variant, loads persona content from that row, emits richer `variant_selected` events, and runs the auto-tuner after terminal reward inputs are captured.

**Tech Stack:** TypeScript, Bun test, SQLite via `DbClient`, existing events table, existing Spec A reward views, existing Spec B lesson retrieval.

---

## File Structure

- Create: `src/config/dispatch.ts` — typed defaults for epsilon, shadow/graduation thresholds, rolling windows, auto-retire days, and population cap.
- Create: `src/orchestrator/allocation.ts` — single transactional write path for `traffic_share` and `status`; emits `traffic_allocated`.
- Create: `src/orchestrator/specialty-match.ts` — naive keyword overlap matcher reusing Spec B keyword extraction semantics.
- Create: `src/orchestrator/dispatch.ts` — `selectVariant()` implementation with injectable RNG and DB-backed eligible population loading.
- Create: `src/orchestrator/shadow.ts` — shadow event recording and score-pair extraction; executor/worktree execution remains mockable at the boundary.
- Create: `src/orchestrator/sequential-test.ts` — Wilcoxon signed-rank and Mann-Whitney U helpers with deterministic unit tests.
- Create: `src/orchestrator/auto-tuner.ts` — candidate graduation/fail-out, active promotion/demotion, baseline swap, and auto-retirement.
- Create: `src/web/routes/variants.ts` — read-only variant allocation and score-history endpoints.
- Modify: `src/db/client.ts` — population/reward/shadow helper queries only; no new schema required.
- Modify: `src/orchestrator/meta-operations.ts` — route `promote`/`demote`/`retire` through `adjustVariantAllocation`.
- Modify: `src/orchestrator/service.ts` — dispatch through `selectVariant`, emit full selection payload, run shadow hooks, call auto-tuner after terminal capture/reflection.
- Modify: `src/web/server.ts` — mount `variants.ts`.
- Create: `tests/helpers/population-fixtures.ts` — shared temp-DB and `skill_versions` seed helpers for Spec C tests.
- Test: `tests/unit/allocation.test.ts`, `tests/unit/specialty-match.test.ts`, `tests/unit/dispatch.test.ts`, `tests/unit/sequential-test.test.ts`, `tests/unit/auto-tuner.test.ts`, `tests/integration/shadow-dispatch.test.ts`, `tests/integration/spec-c-lifecycle.test.ts`, `tests/unit/variants-route.test.ts`.

---

## Conventions

- Use TDD for every task: write the failing test, verify it fails, implement the minimal code, verify it passes.
- Do not add schema migrations unless a task explicitly reopens the "no schema additions" decision. Spec C stores new data in events and derived views/helpers.
- `persona:<agentType>` remains the `skill_versions.skill_name` convention. The dispatcher selects `skill_versions.id` rows; prompt content must come from the selected row, not from `PersonaRegistry.snapshotId()`.
- Meta operations, auto-tuner decisions, fork approval, and any manual operator endpoint must use `adjustVariantAllocation`; direct `updateTrafficShare()`/`retireVariant()` writes become test failures.
- Commit after each task if the user has asked for commits. Otherwise leave changes uncommitted and report verification.

---

## Task 1: Allocation Write Path

**Files:**
- Create: `src/orchestrator/allocation.ts`
- Modify: `src/db/client.ts`
- Create: `tests/helpers/population-fixtures.ts`
- Test: `tests/unit/allocation.test.ts`

- [ ] **Step 1: Create shared population test fixtures**

```typescript
export function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "spec-c-population-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

export function seedVariant(
  db: DbClient,
  input: { id: string; skill: string; status: string; share: number; specialty?: string | null; parent?: string | null }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share, specialty, parent_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.skill, input.id, `${input.skill} ${input.id}`, input.status, input.share, input.specialty ?? null, input.parent ?? null);
}
```

- [ ] **Step 2: Write failing allocation invariant tests**

```typescript
import { describe, expect, test } from "bun:test";
import { freshDb, seedVariant } from "../helpers/population-fixtures";
import { adjustVariantAllocation } from "../../src/orchestrator/allocation";

test("rejects candidate promotion above zero outside graduation", () => {
  const db = freshDb();
  seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });
  seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });

  const result = adjustVariantAllocation(db, "cand", { kind: "promote", delta: 0.1 }, "meta_promote");

  expect(result.ok).toBe(false);
  expect(result.reason).toBe("candidate_requires_graduation");
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `bun test tests/unit/allocation.test.ts --timeout 20000`

Expected: FAIL because `src/orchestrator/allocation.ts` does not exist.

- [ ] **Step 4: Implement `adjustVariantAllocation`**

```typescript
export type AllocationReason =
  | "auto_graduation" | "auto_promote" | "auto_demote" | "auto_retire"
  | "meta_promote" | "meta_demote" | "meta_retire" | "meta_fork_approved"
  | "baseline_swap";

export type AllocationOp =
  | { kind: "graduate"; newTrafficShare: number }
  | { kind: "promote"; delta: number }
  | { kind: "demote"; delta: number }
  | { kind: "set_status"; newStatus: VariantStatus; newTrafficShare?: number }
  | { kind: "baseline_swap"; newBaselineId: string };

export function adjustVariantAllocation(
  db: DbClient,
  variantId: string,
  op: AllocationOp,
  reason: AllocationReason,
  supportingMetric?: Record<string, unknown>
): AllocationResult {
  return db.transaction(() => {
    const before = loadAllocationState(db, variantId);
    const after = computeAllocation(before, op);
    const violation = validateAllocation(before.population, after);
    if (violation) return { ok: false, reason: violation };
    writeAllocation(db, before, after, reason, supportingMetric);
    return { ok: true };
  });
}
```

- [ ] **Step 5: Emit `traffic_allocated` events**

Add event insertion inside `writeAllocation()` using the existing `events` table. Use `task_id = NULL` only if the schema permits it; otherwise use the triggering task id as an optional parameter and require callers without a task to write a project-level event with a synthetic allocation task id rejected by tests.

Expected payload:

```json
{
  "variant_id": "cand",
  "agent_type": "coder",
  "old_status": "candidate",
  "new_status": "active",
  "old_traffic_share": 0,
  "new_traffic_share": 0.1,
  "reason": "auto_graduation",
  "supporting_metric": { "window_size": 10 }
}
```

- [ ] **Step 6: Run allocation tests**

Run: `bun test tests/unit/allocation.test.ts --timeout 20000`

Expected: PASS for exact-one-baseline, baseline floor, candidate graduation-only traffic, retired no-resurrection, sole-baseline retirement, population cap, and baseline swap.

---

## Task 2: Route Meta Operations Through Allocation

**Files:**
- Modify: `src/orchestrator/meta-operations.ts`
- Test: `tests/unit/meta-operations.test.ts`

- [ ] **Step 1: Write failing tests proving direct writes are gone**

```typescript
test("meta promote emits traffic_allocated through allocation path", () => {
  const db = freshDb();
  seedVariant(db, "base", "persona:coder", "baseline", 0.8);
  seedVariant(db, "active", "persona:coder", "active", 0.2);

  const result = handleMetaOperation({
    db,
    operation: { kind: "promote", target_variant_id: "active", traffic_share: 0.25, hypothesis: "h", evidence: { task_ids: ["t1"] } },
    metaTaskId: "meta-1",
    worktreePath: "/tmp/nope",
    projectId: "p"
  });

  expect(result.ok).toBe(true);
  expect(db.listEvents("meta-1").some((e) => e.type === "traffic_allocated")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/unit/meta-operations.test.ts --timeout 20000`

Expected: FAIL because current meta operations call `updateTrafficShare()` / `retireVariant()`.

- [ ] **Step 3: Refactor handlers**

Replace direct writes:

```typescript
const allocation = adjustVariantAllocation(
  ctx.db,
  target.id,
  { kind: kind === "promote" ? "promote" : "demote", delta: newShare - target.traffic_share },
  kind === "promote" ? "meta_promote" : "meta_demote",
  { meta_task_id: ctx.metaTaskId }
);
if (!allocation.ok) return { ok: false, reason: allocation.reason };
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/meta-operations.test.ts tests/unit/allocation.test.ts --timeout 20000`

Expected: PASS.

---

## Task 3: Specialty Matching

**Files:**
- Create: `src/orchestrator/specialty-match.ts`
- Test: `tests/unit/specialty-match.test.ts`

- [ ] **Step 1: Write failing matcher tests**

```typescript
test("baseline and generalist are always eligible", () => {
  const variants = [
    { id: "base", status: "baseline", specialty: "backend" },
    { id: "general", status: "active", specialty: null },
    { id: "frontend", status: "active", specialty: "React UI" }
  ];
  expect(filterBySpecialty(variants, "write a database migration").map((v) => v.id))
    .toEqual(["base", "general"]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/unit/specialty-match.test.ts --timeout 20000`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement matcher**

```typescript
export function filterBySpecialty<T extends { status: string; specialty: string | null }>(
  variants: T[],
  taskDescription: string
): T[] {
  const taskKeywords = new Set(extractKeywords(taskDescription));
  return variants.filter((variant) => {
    if (variant.status === "baseline") return true;
    if (!variant.specialty) return true;
    return extractKeywords(variant.specialty).some((kw) => taskKeywords.has(kw));
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/specialty-match.test.ts --timeout 20000`

Expected: PASS.

---

## Task 4: Dispatch Policy

**Files:**
- Create: `src/config/dispatch.ts`
- Create: `src/orchestrator/dispatch.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/dispatch.test.ts`

- [ ] **Step 1: Write failing deterministic dispatch tests**

```typescript
test("population size one returns only_eligible", () => {
  const db = freshDb();
  seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });
  const dispatcher = createDispatcher(db, { random: () => 0.99 });

  expect(dispatcher.selectVariant("coder", { description: "x", tier: "STANDARD", projectId: "p" }))
    .toEqual({ variantId: "base", agentType: "coder", rationale: "only_eligible", shadowVariantIds: [] });
});
```

- [ ] **Step 2: Add DB population helper**

```typescript
loadDispatchPopulation(agentType: AgentType): DispatchVariantRow[] {
  return this.sqlite.query(`
    SELECT id, skill_name, content, status, traffic_share, parent_version_id, specialty
      FROM skill_versions
     WHERE skill_name = ?
       AND status IN ('baseline', 'active', 'candidate')
     ORDER BY created_at ASC, id ASC
  `).all(`persona:${agentType}`) as DispatchVariantRow[];
}
```

- [ ] **Step 3: Implement dispatcher**

```typescript
export function createDispatcher(db: DbClient, opts: { random?: () => number } = {}) {
  const random = opts.random ?? cryptoRandomFloat;
  return {
    selectVariant(agentType: AgentType, taskContext: TaskContext): SelectionResult {
      const population = db.loadDispatchPopulation(agentType);
      if (population.length === 1) return onlyEligible(agentType, population[0]);
      const eligible = filterBySpecialty(population, taskContext.description);
      return chooseEpsilonGreedy(agentType, eligible, random());
    }
  };
}
```

- [ ] **Step 4: Distribution test**

Run a seeded/fixed sequence of 10,000 rolls and assert baseline frequency is within 1% of `max(0.5, baseline.traffic_share)`, exploration is near `epsilon`, and exploitation is weighted across active variants.

Run: `bun test tests/unit/dispatch.test.ts --timeout 20000`

Expected: PASS.

---

## Task 5: Orchestrator Dispatch Integration

**Files:**
- Modify: `src/orchestrator/service.ts`
- Modify: `src/personas/registry.ts` only if a content-by-variant accessor is missing
- Test: `tests/unit/variant-selected-event.test.ts`
- Test: `tests/integration/lesson-injection-dispatch.test.ts`

- [ ] **Step 1: Write failing integration test for non-`only_eligible` payload**

Seed baseline + active coder variants, force dispatcher RNG to active exploitation, submit an EXPRESS task, and assert `variant_selected.payload.selection_rationale === "exploitation"` and `eligible_variant_ids` includes both variants.

- [ ] **Step 2: Add selected-variant prompt loading**

```typescript
const selection = this.dispatcher.selectVariant(agentType, {
  description: task.description,
  tier,
  projectId: task.projectId
});
const personaContent = this.personas.resolveVariant(selection.variantId, agentType);
const lessonBundle = await this.loadLessonsForDispatch(selection.variantId, agentType, task.description);
```

- [ ] **Step 3: Extend `emitVariantSelected` input**

```typescript
this.emitVariantSelected({
  taskId,
  projectId,
  agentType,
  selectedVariantId: selection.variantId,
  eligibleVariantIds: selection.eligibleVariantIds,
  selectionRationale: selection.rationale,
  shadowVariantIds: selection.shadowVariantIds,
  injectedLessonIds: lessonBundle.ids,
  budgetSeconds
});
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/variant-selected-event.test.ts tests/integration/lesson-injection-dispatch.test.ts --timeout 30000`

Expected: PASS.

---

## Task 6: Shadow Evaluation Event Path

**Files:**
- Create: `src/orchestrator/shadow.ts`
- Modify: `src/orchestrator/service.ts`
- Test: `tests/integration/shadow-dispatch.test.ts`

- [ ] **Step 1: Write failing mock shadow test**

```typescript
test("candidate in selection emits shadow_run_completed without changing live task output", async () => {
  const { service, db } = createTestService({ coder: cannedCoder, reflector: skipReflector });
  seedBaselineAndCandidate(db, "persona:coder");

  const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

  expect(task.state).toBe("awaiting_approval");
  const shadow = db.listEvents(task.id).find((e) => e.type === "shadow_run_completed");
  expect(shadow).toBeDefined();
});
```

- [ ] **Step 2: Implement shadow recorder boundary**

For MVP, keep shadow execution isolated behind an interface so unit/integration tests can use a mock executor. The production path creates a separate worktree and runs the selected shadow persona; if worktree creation fails, emit a `shadow_run_completed` event with `candidate_score_components: null` and `error`.

- [ ] **Step 3: Emit event payload**

```typescript
recordShadowRunCompleted(db, {
  taskId,
  agentType,
  baselineVariantId,
  candidateVariantId,
  baselineScoreComponents,
  candidateScoreComponents,
  baselineComposite,
  candidateComposite,
  baselineLessonsInjected,
  candidateLessonsInjected,
  candidateExecutorUsed
});
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/integration/shadow-dispatch.test.ts --timeout 40000`

Expected: PASS.

---

## Task 7: Sequential Test Helpers

**Files:**
- Create: `src/orchestrator/sequential-test.ts`
- Test: `tests/unit/sequential-test.test.ts`

- [ ] **Step 1: Write failing statistical helper tests**

```typescript
test("wilcoxon detects consistently positive paired differences", () => {
  const result = wilcoxonSignedRankGreaterOrEqual([
    [0.8, 0.6],
    [0.9, 0.7],
    [0.7, 0.6],
    [0.85, 0.65]
  ]);
  expect(result.effect).toBeGreaterThan(0);
  expect(result.pValue).toBeLessThanOrEqual(0.10);
});
```

- [ ] **Step 2: Implement minimal exact tests**

Use exact rank-sum enumeration for small N and normal approximation for larger N. Keep the API narrow:

```typescript
export interface StatisticalTestResult {
  pValue: number;
  effect: number;
  n: number;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/unit/sequential-test.test.ts --timeout 20000`

Expected: PASS.

---

## Task 8: Auto-Tuner Candidate Graduation

**Files:**
- Create: `src/orchestrator/auto-tuner.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/auto-tuner.test.ts`

- [ ] **Step 1: Write failing graduation tests**

Seed 10 `shadow_run_completed` events where candidate composite >= baseline, every reward term is within regression tolerance, and Wilcoxon passes. Assert candidate becomes `active`, `traffic_share = 0.10`, experiment status becomes `active`, and `traffic_allocated.reason = "auto_graduation"`.

- [ ] **Step 2: Add DB helper**

```typescript
loadShadowPairs(candidateId: string): ShadowPair[] {
  return this.sqlite.query(`
    SELECT payload
      FROM events
     WHERE event_type = 'shadow_run_completed'
       AND json_extract(payload, '$.candidate_variant_id') = ?
     ORDER BY timestamp ASC
  `).all(candidateId).map(parseShadowPair);
}
```

- [ ] **Step 3: Implement candidate evaluation**

```typescript
export function evaluateCandidate(db: DbClient, candidateId: string): AutoTuneDecision {
  const pairs = db.loadShadowPairs(candidateId).filter((p) => !p.error);
  if (pairs.length >= config.graduation.maxPairs && !passesGraduation(pairs)) {
    return demoteCandidate(db, candidateId, "graduation_timeout");
  }
  if (pairs.length >= config.graduation.minPairs && passesGraduation(pairs)) {
    return graduateCandidate(db, candidateId);
  }
  return { kind: "continue" };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/auto-tuner.test.ts --timeout 20000`

Expected: PASS for graduation, critical regression block, timeout demotion, and repeated shadow errors.

---

## Task 9: Active Variant Promotion, Demotion, Baseline Swap, Auto-Retire

**Files:**
- Modify: `src/orchestrator/auto-tuner.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/auto-tuner.test.ts`

- [ ] **Step 1: Write failing rolling-window tests**

Seed live `variant_selected` events and `task_quality_score` rows for baseline and active variants. Assert a strongly better active variant receives `auto_promote`, a worse one receives `auto_demote`, a dominant one triggers `baseline_swap`, and a stale demoted variant transitions to `retired`.

- [ ] **Step 2: Add recent score helper**

```typescript
loadRecentTaskScores(variantId: string, window: { limit: number; maxAgeDays: number }): VariantScore[] {
  return this.sqlite.query(`
    SELECT tqs.*
      FROM task_quality_score tqs
      JOIN events e ON e.task_id = tqs.task_id
     WHERE e.event_type = 'variant_selected'
       AND json_extract(e.payload, '$.selected_variant_id') = ?
       AND json_extract(e.payload, '$.selection_rationale') IN ('exploitation','exploration')
     ORDER BY e.timestamp DESC
     LIMIT ?
  `).all(variantId, window.limit) as VariantScore[];
}
```

- [ ] **Step 3: Implement active evaluation**

Use Mann-Whitney U for active-vs-baseline windows; apply `delta = 0.05` through `adjustVariantAllocation`. Track baseline-swap dominance in-memory for MVP if persistent counters are not already available; if persistence is needed, encode the counter in `traffic_allocated.supporting_metric`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/auto-tuner.test.ts --timeout 20000`

Expected: PASS.

---

## Task 10: Terminal Hook Wiring

**Files:**
- Modify: `src/orchestrator/service.ts`
- Test: `tests/integration/spec-c-lifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle test**

Run synthetic sequence: baseline only -> meta edit creates candidate -> candidate receives shadow runs -> candidate graduates -> active variant receives live selections -> promotion/demotion events appear. Use mock executors and seeded dispatch RNG.

- [ ] **Step 2: Wire auto-tuner after terminal reward capture**

At each non-meta terminal path:

```typescript
this.captureTaskDiffStats(taskId);
try {
  await this.reflectOnTask(taskId);
  await this.autoTuner.evaluate(taskId);
} finally {
  this.cleanupWorktree(taskId);
}
```

If `autoTuner.evaluate()` throws, record an `auto_tuner_failed` event and do not fail the user task.

- [ ] **Step 3: Run integration test**

Run: `bun test tests/integration/spec-c-lifecycle.test.ts --timeout 60000`

Expected: PASS.

---

## Task 11: Variants Read-Only Routes

**Files:**
- Create: `src/web/routes/variants.ts`
- Modify: `src/web/server.ts`
- Test: `tests/unit/variants-route.test.ts`

- [ ] **Step 1: Write failing route tests**

```typescript
test("GET /api/variants/coder returns current allocation rows", async () => {
  const { app, db } = createRouteTestApp();
  seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
  const res = await app.request("/api/variants/coder");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ agentType: "coder", variants: [{ id: "base" }] });
});
```

- [ ] **Step 2: Implement routes**

Endpoints:
- `GET /api/variants/:agentType` — current active allocation rows.
- `GET /api/variants/:id/scores` — recent `task_quality_score` rows for that variant.
- `GET /api/variants/:id/shadow` — recent `shadow_run_completed` events.

- [ ] **Step 3: Mount route**

Add to `src/web/server.ts` using the same pattern as `experiments`, `tasks`, and `metrics`.

- [ ] **Step 4: Run route tests**

Run: `bun test tests/unit/variants-route.test.ts --timeout 20000`

Expected: PASS.

---

## Final Verification

- [ ] **Step 1: Focused Spec C suite**

Run:

```bash
bun test tests/unit/allocation.test.ts tests/unit/specialty-match.test.ts tests/unit/dispatch.test.ts tests/unit/sequential-test.test.ts tests/unit/auto-tuner.test.ts tests/integration/shadow-dispatch.test.ts tests/integration/spec-c-lifecycle.test.ts tests/unit/variants-route.test.ts --timeout 60000
```

Expected: all Spec C tests pass.

- [ ] **Step 2: Full test suite**

Run:

```bash
bun test --timeout 60000
```

Expected: all tests pass.

- [ ] **Step 3: Lint/typecheck**

Run:

```bash
bun run lint
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 4: Manual event sanity**

Run a synthetic lifecycle and inspect:

```bash
sqlite3 "$SQLITE_FILE" "SELECT event_type, payload FROM events WHERE event_type IN ('variant_selected','shadow_run_completed','traffic_allocated') ORDER BY timestamp"
```

Expected: selection payloads include rationale and shadow IDs; shadow events pair candidate/baseline; allocation events explain every status/share change.

---

## Plan Self-Review

After implementation, re-read [Spec C](../specs/2026-04-19-dispatch-policy-and-safe-experimentation-design.md) and verify:

1. **§3 events** — `traffic_allocated` and `shadow_run_completed` payloads are emitted and tested.
2. **§4 dispatch** — `selectVariant()` covers only-eligible, specialty filtering, epsilon exploration, exploitation weighting, baseline floor, and injectable RNG.
3. **§5 shadow** — shadow candidates do not affect live worktree or task output; failures are recorded without crashing live dispatch.
4. **§6 graduation** — N/M thresholds, critical-regression guard, p-value threshold, and experiment status updates are covered.
5. **§7 active testing** — promotion, demotion, stale-window eviction, baseline swap, and auto-retirement are covered.
6. **§8 single write path** — meta and auto-tuner traffic/status changes use `adjustVariantAllocation`.
7. **§9 rollback** — demotion, failed graduation, baseline swap, and manual override are all allocation outcomes.
8. **§10 capture points** — every file listed in the spec has either been created/modified or explicitly deferred.
9. **§12 testing strategy** — every bullet has at least one unit or integration test.
10. **§14 success criteria** — the synthetic end-to-end lifecycle demonstrates candidate -> shadow -> graduation -> promotion -> demotion without human `/conclude`.

If any gap is found, add a task inline and re-run verification.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-dispatch-policy-and-safe-experimentation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Requires the `superpowers:subagent-driven-development` sub-skill.

2. **Inline Execution** — Execute tasks in the current session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
