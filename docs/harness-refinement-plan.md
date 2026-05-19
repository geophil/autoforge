# Harness Refinement Plan

## Summary

This plan refines Autoforge's operator experience and token-economy reporting
without rebuilding surfaces that already exist. The dashboard already has a task
event timeline, token summary, planning wizard, checkpoint retry, steering,
`execution_contract`, `task_exit_check`, and token KPI endpoints. The work below
closes visibility and control gaps in self-contained, verifiable blocks.

Status as of this revision: Blocks 0-4 are implemented, Blocks 5-7 have useful
first slices in place, and the remaining work is listed under each partial
block.

## Key Changes

- Enhance the existing task-detail timeline instead of creating a second one.
- Split plan-contract work into enforced backend contract validity and advisory
  operator warnings.
- Render PR gate reporting from both accepted readiness evidence
  (`task_exit_check`) and rejection diagnostics (`test_results` +
  `failure_analysis`).
- Keep QMD snippet injection as a future architecture change; for now, display
  captured `planningContext.qmdContext` evidence and retrieval provenance.
- Prefer persisted/provider-aware event cost data over UI-side cost estimates.
- Make every block independently implementable and verifiable.

## Block 0: Plan Document - Implemented

Update this file so it remains the source of truth for the phased work.

Expected behavior:

- Current state is named explicitly so existing features are enhanced, not
  duplicated.
- Blocks below include implementation intent, acceptance criteria, and
  verification commands.
- Future phases capture larger architecture changes.

Verification:

- `bun run lint`
- Manual review that this plan no longer asks to rebuild existing surfaces.

Implemented:

- This document now names current dashboard/API surfaces and organizes the work
  into independently verifiable blocks.

## Block 1: Task Detail Visibility Gaps - Implemented

Enhance the existing task-detail timeline using `/api/tasks/:id/events`.

Implementation intent:

- Add clearer event labels for stage transitions, agent dispatches, variant
  selections, test results, PR gate pauses, and task exit checks.
- Show elapsed time, tokens, and persisted `estimatedCost` when available; use a
  clearly labeled estimate only when persisted cost is missing.
- Surface `variant_selected` payloads with persona/skill variant IDs and
  injected lesson IDs.

Acceptance criteria:

- Operators can scan a task and identify planner, coder, reviewer, test,
  PR-gate, and intervention events without opening raw JSON.
- Cost display uses persisted event data where present.
- No duplicate timeline component is introduced.

Verification:

- `bun test tests/unit`
- `bun test tests/integration/happy-path.test.ts`
- Browser check of a completed task and an `awaiting_intervention` task.

Implemented:

- Existing event log now has semantic event labels and grouping for stage,
  dispatch, execution, review, verification, and intervention events.
- `variant_selected` rows show variant/persona/skill/lesson details.
- Event and task cost displays prefer persisted event cost and fall back to an
  explicitly labeled estimate.

## Block 2: PR Gate Readiness And Rejection Report - Implemented

Build a task-detail report that works for both accepted and rejected PR gate
outcomes.

Implementation intent:

- For accepted tasks, render readiness from `task_exit_check`.
- For PR gate rejections, render diagnostics from the latest `test_results` and
  `failure_analysis` where `failure_category = pr_gate`.
- Show verification status, pass rate, runner, review score, unresolved findings
  count, artifact validation status, PR URL when present, and rejection reason
  when blocked.
- Preserve current backend persistence unless existing payloads prove
  insufficient.

Acceptance criteria:

- Accepted tasks show ready evidence from `task_exit_check`.
- Rejected tasks paused in `awaiting_intervention` show why the gate blocked.
- STANDARD/THOROUGH unavailable verification is shown as blocking; EXPRESS
  unavailable verification is shown as allowed.

Verification:

- `bun test tests/unit/pr-gate.test.ts`
- `bun test tests/integration/happy-path.test.ts`
- UI unit coverage for accepted and rejected report rendering.

Implemented:

- Task detail renders a PR Gate Report from `task_exit_check`, `test_results`,
  and PR-gate `failure_analysis` events.
- Report state distinguishes ready, blocked, allowed, pending, and unavailable
  evidence.

## Block 3: Plan Contract Review Warnings - Implemented

Improve the planning wizard's subtask cards so operators can review the full
contract before approval.

Implementation intent:

- Render behavior, files in scope, verification commands, test criteria,
  completion evidence, dependencies, and WIP order.
- Keep the orchestrator's hard gate for missing required contract fields on
  STANDARD/THOROUGH work.
- Add advisory warnings for broad scope such as `src/`, missing or generic
  evidence, and THOROUGH work without runtime/integration/e2e verification.
- Make warning copy clear that warnings are advisory unless the backend marks
  the contract invalid.

Acceptance criteria:

- Every required contract field is visible in plan review.
- Invalid contracts remain backend-blocked through `execution_contract`.
- Warnings help the operator critique plans before execution without changing
  backend gate semantics.

Verification:

- `bun test tests/unit/planning-wizard.test.ts`
- `bun test tests/unit/plan-markdown.test.ts`
- `bun test tests/integration/plan-review.test.ts`

Implemented:

- Planning wizard subtask cards render behavior, dependencies, files in scope,
  verification commands, test criteria, completion evidence, and WIP order.
- UI warnings distinguish blocking missing fields from advisory weak-contract
  concerns such as broad scope, generic evidence, and missing THOROUGH runtime
  checks.

## Block 4: Intervention Recommendations - Implemented

Make the intervention console guided by failure category while preserving the
existing retry, checkpoint, steering, and cancel endpoints.

Implementation intent:

- Map known categories to recommended actions:
  - `planner_missing_qmd_context`: retry from planning and inspect QMD evidence
    or transcript.
  - `planner_contract_incomplete`: retry or critique planning and inspect
    contract warnings.
  - `planner_prompt_budget_exceeded`: retry planning with narrower critique.
  - `pr_gate`: inspect PR gate report, then retry execution or planning
    depending on the reason.
  - `lifecycle_hook_failed`: inspect hook output and retry execution after
    steering.
  - `coder_failed` / `reviewer_failed`: retry execution and optionally roll
    back to checkpoint.
- Keep `/api/tasks/:id/retry` and `/api/tasks/:id/steer` unchanged.
- Show recommendations as UI guidance; never auto-run recovery.

Acceptance criteria:

- Paused tasks show a recommendation based on `failure_category`.
- Existing rollback checkpoint and operator note flows still work.
- Unsupported categories fall back to transcript inspection plus retry from the
  failed stage.

Verification:

- `bun test tests/integration/awaiting-intervention.test.ts`
- UI unit coverage for recommendation mapping.
- Browser check with representative failure payloads.

Implemented:

- Intervention console renders category-specific recovery guidance while using
  the existing retry, checkpoint, steering, and cancel controls.
- Recommendation mapping covers planner/QMD, contract, prompt budget, PR gate,
  lifecycle hook, pre-review check, coder, and reviewer failures.

## Block 5: Transcript And Attempt Diff Viewer - Partial

Add comparison affordances for planner retries, coder rework, and reviewer loops.

Implementation intent:

- Use existing transcript routes.
- Compare adjacent attempts by stage/subtask where possible.
- Show prompt, output, finding, token, elapsed, and outcome deltas.
- Keep the full transcript viewer available; the diff viewer is a summary
  layer.

Acceptance criteria:

- Planner spec and execution-plan retries can be compared.
- Coder and reviewer loops show whether tokens increased and findings improved.
- Missing transcripts degrade to a clear unavailable state.

Verification:

- `bun test tests/unit/transcripts.test.ts`
- UI unit coverage for transcript comparison rendering.
- Browser check on a task with multiple planner attempts.

Implemented:

- Transcript metadata now shows an adjacent-attempt token/elapsed/content delta
  summary when a prior attempt exists for the same stage.

Remaining:

- Add richer prompt/output/finding diff panels beyond the compact metadata
  summary.
- Add browser coverage with real multi-attempt planner/reviewer examples.

## Block 6: Token Discipline Reporting - Partial

Focus first on reporting and policy visibility, not prompt architecture changes.

Implementation intent:

- Expand metrics/dashboard surfaces to show token usage by task, stage, tier,
  persona/skill variant, failure category, retry, and accepted PR.
- Use persisted event/transcript cost fields and provider/model-aware pricing;
  keep UI-side pricing only as an explicit fallback.
- Show planner prompt-envelope reuse and retry token deltas using existing
  `context_envelope_hash` data.
- Show injected lesson IDs and approximate lesson token contribution where data
  exists.

Acceptance criteria:

- Operators can identify high-cost stages and high-cost failure categories.
- Cost display is consistent between task detail and metrics APIs.
- Existing `/api/metrics/:projectId/token-kpis` and
  `/api/metrics/:projectId/envelope-reuse` remain compatible.

Verification:

- `bun test tests/unit/metrics-route.test.ts`
- `bun test tests/unit/token-kpi-utils.test.ts`
- `bun test tests/unit/pricing.test.ts`

Implemented:

- Task detail and event rows use persisted `estimated_cost` where available.
- Timeline rows expose injected lesson counts from `variant_selected` events.
- Existing token KPI and envelope-reuse APIs remain compatible.

Remaining:

- Expand project metrics views by tier, failure category, accepted PR, and
  persona/skill variant.
- Add explicit lesson token-cost reporting once lesson token contribution is
  persisted per dispatch.

## Block 7: Cheap Pre-Review Checks Policy - Partial

Clarify and implement only genuinely cheap checks before model reviewer
dispatch.

Implementation intent:

- Do not move full authenticated PR-gate tests ahead of review by default.
- Add or expose cheap checks before reviewer dispatch: changed-file scope check,
  debug-code scan, and artifact existence/shape validation where applicable.
- Treat lifecycle hooks as the existing place for configured lint/test scripts.
- Model review still runs when semantic review is required by tier or when cheap
  checks pass.

Acceptance criteria:

- Cheap deterministic failures are surfaced before reviewer tokens are spent.
- Full PR-gate tests remain at the PR gate unless configured as lifecycle hooks.
- The policy is documented here and in QMD docs if runtime behavior changes.

Verification:

- Unit tests for each cheap check.
- Integration test showing a cheap-check failure pauses or reworks before
  reviewer dispatch.
- `bun test`

Implemented:

- STANDARD/THOROUGH tasks now record `pre_review_checks` after
  `post_coder_pre_review` and before reviewer dispatch.
- Failed cheap checks pause in `awaiting_intervention` with
  `failure_category=pre_review_check_failed`.
- Current checks cover reported-artifact scope and obvious debug leftovers in
  reported source artifacts.
- QMD orchestration docs now describe the pre-review boundary.

Remaining:

- Add dedicated unit/integration tests for each cheap-check failure mode.
- Decide whether changed-file scope should inspect post-hook changed files,
  reported artifacts, or both.
- Tune debug-code scanning to avoid false positives in intentional test fixtures
  or logging-focused changes.

## Future Phases

- Orchestrator-owned QMD retrieval and snippet-level prompt envelopes, replacing
  agent-led QMD-only usage.
- Enforced per-stage prompt budgets beyond planner retry guardrails.
- Automated lesson deduplication and impact-scoring UI if current lineage lesson
  budgeting proves insufficient.
- Cross-task cost dashboard trends and cost-per-accepted-PR optimization views.
- Full attempt-diff persistence if client-side transcript comparison becomes too
  slow.

## Assumptions

- Existing API shapes are preserved unless a block proves current payloads are
  insufficient.
- UI improvements enhance existing dashboard and planning-wizard surfaces
  instead of introducing parallel replacements.
- Verification defaults to `bun test` plus the focused commands listed per
  block.
