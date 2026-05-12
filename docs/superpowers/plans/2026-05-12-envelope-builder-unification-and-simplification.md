# Envelope Builder Unification and Simplification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace split envelope-building paths with one canonical dispatch-envelope builder, then opportunistically simplify adjacent orchestration seams without changing behavior.

**Architecture:** Keep one prompt/envelope construction primitive in `src/orchestrator/dispatch-envelope.ts`, and make planner/coder/reviewer/doc all consume it. Retain planner-specific prompt policy in `planner-prompt.ts` but eliminate planner-only envelope shaping logic. After each phase, run a hard review gate (tests + diff review) before proceeding.

**Tech Stack:** TypeScript, Bun test runner, SQLite-backed event log, Hono routes.

---

## Scope

### In scope
- Unify `planner-envelope` onto `dispatch-envelope`.
- Remove duplicated envelope-shaping code paths.
- Opportunistically simplify nearby architecture where behavior is preserved.
- Keep strict regression safety via existing plan-review/integration tests.

### Out of scope
- Semantic changes to planner output parsing or state machine transitions.
- New token-budget policy beyond already-landed guardrails.
- Broad data model migrations.

---

## File Map (Target End State)

- **Canonical envelope builder**
  - Modify: `src/orchestrator/dispatch-envelope.ts`
  - Delete or reduce to compatibility shim: `src/orchestrator/planner-envelope.ts`
- **Planner flow**
  - Modify: `src/orchestrator/service.ts`
  - Keep planner prompt policy isolated in: `src/orchestrator/planner-prompt.ts`
- **Telemetry/query simplification (opportunistic)**
  - Modify: `src/db/client.ts`
  - Modify: `src/web/routes/metrics.ts`
  - Modify: `src/web/token-kpi-utils.ts`
- **Tests**
  - Modify: `tests/unit/planner-envelope.test.ts`
  - Modify: `tests/unit/dispatch-envelope.test.ts`
  - Run regression: `tests/integration/plan-review.test.ts`, `tests/unit/metrics-route.test.ts`

---

## Phase 1: Planner-on-Shared-Envelope

**Objective:** planner uses the same generic envelope builder implementation as all other agent types.

**Files:**
- Modify: `src/orchestrator/dispatch-envelope.ts`
- Modify: `src/orchestrator/planner-envelope.ts`
- Modify: `src/orchestrator/service.ts`
- Modify: `tests/unit/planner-envelope.test.ts`
- Modify: `tests/unit/dispatch-envelope.test.ts`

- [ ] Replace planner-envelope internals to delegate directly to `buildAgentDispatchEnvelope(...)`.
- [ ] Keep planner-facing API stable initially (`buildPlannerDispatchEnvelope`) to reduce blast radius.
- [ ] Ensure hash and prompt content parity by asserting old/new test expectations.
- [ ] Verify planner call sites in `service.ts` still compile without behavior changes.

**Verification:**
- `bun test tests/unit/planner-envelope.test.ts tests/unit/dispatch-envelope.test.ts`

**Review gate (required before Phase 2):**
- Confirm no planner prompt behavior drift by inspecting `service.ts` diff.
- Confirm no hash field regressions in planner `recordEvent(...)` calls.

---

## Phase 2: Collapse to One Builder API

**Objective:** remove planner-specific envelope builder abstraction unless required for readability.

**Files:**
- Modify: `src/orchestrator/service.ts`
- Delete (preferred) or deprecate: `src/orchestrator/planner-envelope.ts`
- Modify: `tests/unit/planner-envelope.test.ts` (replace with planner dispatch tests against shared builder)
- Modify: imports in any affected files

- [ ] Switch planner call site in `runPlannerAttempt(...)` to `buildAgentDispatchEnvelope(...)`.
- [ ] If planner wrapper becomes trivial/no-value, remove file and update imports.
- [ ] Keep planner-specific metadata at callsite (description/tier/attempt/model) with shared builder inputs.

**Verification:**
- `bun test tests/unit/dispatch-envelope.test.ts tests/unit/planner-prompt.test.ts`
- `bun test tests/integration/plan-review.test.ts`

**Review gate (required before Phase 3):**
- Diff audit: one envelope builder entry point remains for all dispatches.
- Confirm no behavior changes in plan review flow tests.

---

## Phase 3: Opportunistic Simplifications (Behavior-Preserving)

**Objective:** simplify adjacent architecture while code is in focus.

**Candidate simplifications (apply only if low-risk and test-backed):**
1. Move metrics SQL execution from route-level raw SQL to `DbClient` helpers for clearer layering.
2. Centralize envelope-hash telemetry payload shaping in one helper to avoid repeated provenance logic.
3. Remove now-obsolete comments/docs that imply hash is unused.

**Files:**
- Modify: `src/db/client.ts`
- Modify: `src/web/routes/metrics.ts`
- Modify: `src/web/token-kpi-utils.ts`
- Modify docs:
  - `docs/qmd/domain-task-orchestration.md`
  - `docs/qmd/domain-web-api.md`
  - `docs/design/observability-and-recovery.md`
- Tests:
  - `tests/unit/metrics-route.test.ts`
  - `tests/unit/envelope-hash-stats.test.ts`

- [ ] Promote project-scoped KPI/reuse queries into typed `DbClient` methods.
- [ ] Keep route handlers thin and declarative.
- [ ] Keep output schema unchanged to avoid dashboard/API breakage.

**Verification:**
- `bun test tests/unit/metrics-route.test.ts tests/unit/token-kpi-utils.test.ts tests/unit/envelope-hash-stats.test.ts`

**Review gate (required before Phase 4):**
- Confirm route response contracts unchanged.
- Confirm docs match actual endpoint behavior and field names.

---

## Phase 4: Hardening and Final Review

**Objective:** ensure unification is complete, coherent, and easy to maintain.

**Files:**
- Modify as needed based on findings from prior review gates.

- [ ] Run focused regression suite:
  - `bun test tests/integration/plan-review.test.ts tests/unit/planner-output.test.ts tests/unit/metrics-route.test.ts`
- [ ] Run lint/TS check and report pre-existing vs new failures:
  - `bun run lint`
- [ ] Perform manual code review checklist:
  - one envelope builder path
  - no duplicate prompt+hash assembly
  - docs updated for new canonical path
  - no orphaned tests

---

## Risks and Mitigations

1. **Hidden planner behavior drift**
   - Mitigation: keep planner prompt policy in `planner-prompt.ts`; only unify envelope shaping.
2. **Over-refactor scope creep**
   - Mitigation: each phase has strict review gate before moving on.
3. **Route-layer breakage during metrics cleanup**
   - Mitigation: preserve API response shape and enforce via route tests.

---

## Done Criteria

- Planner, coder, reviewer, and doc dispatches all rely on the same envelope construction primitive.
- No duplicated hash/prompt assembly logic remains in `service.ts`.
- Existing plan-review and metrics regressions remain green.
- Docs accurately describe the unified architecture and hash usage.
