# Task Orchestration

The Task Orchestration domain is the central nervous system of Autoforge. It receives natural-language feature requests, drives them through a multi-agent pipeline (plan → code → review → PR → doc), enforces state transitions, and coordinates with all other domains to produce a human-reviewable pull request.

## Business Rules and Invariants

### Task Must Reach `awaiting_approval` or Fail

`submitTask` either resolves with a task in `awaiting_approval` state or throws. The caller can never receive a task stuck in an intermediate stage.

```typescript
// src/orchestrator/service.ts
if (task.state === "awaiting_approval") {
  return task;
}
throw new Error(`Task ${taskId} did not reach approval state; current state: ${task.state}`);
```

**Implemented in**: `OrchestratorService.submitTask()`.

### Rework Is Capped at 3 Iterations

If the reviewer finds CRITICAL or MAJOR findings after 3 rework cycles, the task fails rather than looping indefinitely.

```typescript
// src/orchestrator/service.ts
if (iteration > 3) {
  this.transition(taskId, projectId, "reviewing", "failed", {
    reason: "Exceeded rework iteration limit",
    iteration
  });
  throw new Error("Exceeded rework iteration limit");
}
```

**Implemented in**: `OrchestratorService.executeAndReview()`.

### EXPRESS Tier Skips Review

Tasks routed to EXPRESS tier bypass the reviewer agent entirely to trade quality tolerance for speed.

```typescript
// src/orchestrator/service.ts
// EXPRESS tier skips the reviewer — faster turnaround, lower risk tolerance.
if (tier === "EXPRESS") {
  break;
}
```

**Implemented in**: `OrchestratorService.executeAndReview()`.

### Orchestrator Owns All Git Operations

Agents never push directly. The orchestrator commits each subtask's output after the agent reports success.

```typescript
// src/orchestrator/service.ts
// Orchestrator commits agent output — agents never push directly.
this.deps.worktrees.commit({ branch, path: worktreePath }, `autoforge: ${subtask.description}`);
```

**Implemented in**: `OrchestratorService.executeAndReview()`. See `domain-pr-gate.md` > Git Worktree Isolation.

### Lifecycle Hooks Run at Guarded Boundaries

Autoforge runs allowlisted Bun scripts in two deterministic phases:

- `post_coder_pre_review` (mutating allowed): after coder commits, before reviewer dispatch.
- `pre_pr_gate` (read-only): after review passes, before authenticated tests and PR gate.

V1 is Bun-only and only discovers fixed allowlisted script names from `package.json` (`format`, `lint:fix`, `lint`, `test`), with deterministic phase gating.

If a lifecycle hook fails, the orchestrator records `lifecycle_hook_failed` and pauses the task in `awaiting_intervention` with `failure_category=lifecycle_hook_failed`.

### Rollback and Steering Are Boundary-Safe

- Checkpoints are durable event-log markers (`checkpoint_created`) captured at safe stage boundaries and subtask commits.
- Rollback (`rollback_applied`) is only valid when retrying from `awaiting_intervention`; terminal/archived tasks are not rollback targets because worktrees are pruned at terminal cleanup.
- Steering (`steering_message`) is injected only on the next agent dispatch boundary and marked consumed with `steering_consumed` *after* the executor returns; no live in-loop interruption is attempted.

#### Checkpoint SHA Lifecycle

Checkpoint *events* persist in the event log indefinitely. Checkpoint *SHAs* are tied to the task worktree branch and may become unreachable after terminal cleanup prunes the worktree. Rollback is therefore only meaningful while the task is non-terminal.

| Capture point | Stage payload | Label |
|---|---|---|
| Right after `WorktreeManager.create(taskId)` resolves | `planning` | `task-start` |
| After each subtask commit inside `executeAndReview()` | `executing` | `subtask-<sequence>` |
| When entering `awaiting_intervention` via `pauseForIntervention` | `awaiting_intervention` | encodes prior stage / failure category |
| Inside `retryFromIntervention` before the new attempt begins | `awaiting_intervention` | `pre-retry` |

Each checkpoint records `checkpoint_id`, `task_id`, `iteration`, `stage`, `git_sha`, and `label`. If the worktree HEAD cannot be resolved (non-git context) the checkpoint is skipped and no event is recorded.

`WorktreeManager.resetToCommit(worktreePath, sha)` enforces three preconditions before mutating the worktree:

1. The path must be the task worktree under the manager's root and contain the `.autoforge-worktree.json` marker.
2. The target SHA must be reachable from the current HEAD (`git merge-base --is-ancestor <sha> HEAD`).
3. The orchestrator only calls it from `retryFromIntervention`, which requires the task to be in `awaiting_intervention`.

The reset uses `git reset --hard <sha>` followed by `git clean -fd`, which destroys uncommitted changes — including any in-flight hook output, scratch files, or partial coder writes.

### Agents Receive a Time Budget

Every agent invocation is constrained by `budgetSeconds`. Budget is tier- and step-dependent; the orchestrator enforces it via the executor.

```typescript
// src/orchestrator/service.ts
private budgetForTier(tier, step): number {
  const budgets = {
    EXPRESS:   { planner: 180,  coder: 300, reviewer: 0,   doc: 120 },
    STANDARD:  { planner: 480,  coder: 480, reviewer: 180, doc: 180 },
    THOROUGH:  { planner: 900,  coder: 720, reviewer: 480, doc: 300 }
  };
  return budgets[tier][step];
}
```

**Implemented in**: `OrchestratorService.budgetForTier()`.

### QMD Evidence Is Required for Planner Runs When Configured

When `QMD_MCP_URL` is configured, planner outputs must include usable knowledgebase evidence in `planningContext.qmdContext` (`status: "used"` plus at least one query or retrieved document). Outputs that omit this are rejected and routed to intervention instead of progressing silently.

```typescript
// src/orchestrator/service.ts
if (!this.deps.env.QMD_MCP_URL) return;
const qmdContext = args.parsed.planningContext.qmdContext ?? null;
const hasEvidence =
  qmdContext?.status === "used" &&
  ((qmdContext.queries?.length ?? 0) > 0 || (qmdContext.documents?.length ?? 0) > 0);
if (!hasEvidence) {
  this.pauseForIntervention({
    failureCategory: "planner_missing_qmd_context",
    failureReason: "planner output missing required QMD knowledgebase evidence"
  });
}
```

**Implemented in**: `OrchestratorService.requireQmdEvidenceForPlanner()`.

## Core Flows

### Submit Task Flow

A new task progresses from submission through to a PR awaiting human approval.

1. **Entry point**: `POST /api/tasks` → `OrchestratorService.submitTask(projectId, description)`
2. **Assessment**: `assessComplexity(description)` assigns scope/novelty/risk/coupling dimensions. `routeTier(assessment)` maps them to EXPRESS/STANDARD/THOROUGH. See `domain-complexity-routing.md`.
3. **Worktree creation**: A git branch `autoforge/{taskId}` and isolated working directory are created. See `domain-pr-gate.md` > Git Worktree Isolation.
4. **Initial events**: `created` and `state.assessing`/`state.planning` events are recorded atomically.
5. **Planner dispatch**: `OrchestratorService` asks `createDispatcher().selectVariant("planner", taskContext)` for the selected population variant, resolves that variant's prompt content through `PersonaRegistry.resolveVariant()`, injects active lineage lessons from `loadLessonsForDispatch()`, and emits `variant_selected`.
6. **Phase 1 — Spec generation** (STANDARD/THOROUGH with `reviewPlan: true`): the prompt carries `## Phase\nspec` and is built through `planner-prompt.ts` (slimmed static constraints + bounded retry compaction). Executor runs the planner; every parsed planner attempt is checked for QMD evidence when `QMD_MCP_URL` is configured. If valid, `PlannerSpecArtifacts` (discovery + spec) are persisted to `agent_transcripts` (stage `planner:spec`, attempt 0) and the task transitions to `awaiting_spec_approval`.
7. **Spec-review pause**: On approve (`approveSpec`), `planningContext.approvalMode = "manual"` and `reviewedAt` are set, the orchestrator advances to phase 2. On critique (`critiqueSpec`), the planner re-runs in spec phase with the prior spec, the operator's critique (or `## Operator Answer To Question` prefix when a `blockingQuestion` was emitted), up to `PLANNER_SPEC_MAX_ITERATIONS` revisions. EXPRESS tasks skip phases 6–7 entirely.
8. **Phase 2 — Execution-plan generation**: the prompt carries `## Phase\nexecution_plan` plus the approved spec under `## Approved Spec` (compacted on retries to bound token growth). Output is `PlanSubtask[]`, persisted to `agent_transcripts` (stage `planner:execution_plan`). QMD evidence enforcement applies here too when configured. Planner retries also enforce a prompt-token guardrail: over-budget retries pause to intervention (`failure_category=planner_prompt_budget_exceeded`) instead of dispatching an oversized prompt.
9. **Plan-review pause**: Same critique loop as spec, capped by `PLANNER_MAX_ITERATIONS` and scoped to `planner:execution_plan` transcripts. The two budgets are independent.
10. **Combined fast path** (`reviewPlan: false`): phases 6–9 collapse to a single planner call with `## Phase\ncombined`; output carries both spec and subtasks. `planningContext.approvalMode = "auto"` is set and the task runs straight to step 11 with no pause. If the combined call returns spec only, the orchestrator transparently issues a second `execution_plan` call (records `planner_phase_fallback_to_two_call`) and never pauses — this is the path `rejectTask` exercises on every restart.
11. **Execution contract**: Before coder work, the orchestrator emits `execution_contract` with WIP limit 1, validation hierarchy, and each subtask's behavior/scope/verification/evidence contract. STANDARD/THOROUGH tasks pause to `awaiting_intervention` if the contract is incomplete.
12. **Execute & Review loop**: `executeAndReview()` runs coders for each subtask, commits their output, runs `post_coder_pre_review` lifecycle hooks, then runs the reviewer (unless EXPRESS). Each planner/coder/reviewer/doc dispatch selects a population variant, injects selected variant content and lineage lessons, and runs any candidate shadow variants after the live result. Repeats up to 3 iterations if CRITICAL/MAJOR findings exist.
13. **PR Gate**: `evaluatePrGate()` checks test pass rate, verification availability, review score, and unresolved CRITICAL findings. See `domain-pr-gate.md`.
14. **Task exit check**: If the PR gate accepts, the orchestrator emits `task_exit_check` summarizing clean-state dimensions, verification status, review score, and subtask evidence.
15. **PR creation**: If gate passes, `createPullRequest()` pushes the branch and opens a GitHub PR.
16. **State**: Task transitions to `awaiting_approval`.

**Error paths**:
- Any coder returning FAILED/TIMEOUT → task transitions to `failed`
- Rework iteration > 3 → `failed`
- PR gate rejected → `awaiting_intervention` with `failure_category=pr_gate`
- Execution contract incomplete for STANDARD/THOROUGH → `awaiting_intervention` with `failure_category=planner_contract_incomplete`
- Planner output missing required QMD evidence (while `QMD_MCP_URL` is configured) → task transitions to `awaiting_intervention` with `failure_category=planner_missing_qmd_context`

### Population Dispatch Flow (`OrchestratorService.selectPersonaForDispatch`)

Before each live planner, coder, reviewer, doc, or meta agent run, `OrchestratorService` delegates persona selection to the dispatcher. The result drives both prompt content and observability:

```typescript
// src/orchestrator/dispatch.ts
export interface SelectionResult {
  variantId: string;
  agentType: AgentType;
  rationale: "only_eligible" | "baseline" | "exploitation" | "exploration" | "shadow_parallel";
  shadowVariantIds: string[];
  eligibleVariantIds: string[];
}
```

Dispatch rules:
- `filterSpecialtyEligible()` always keeps the `baseline` and generalist variants eligible, then adds specialists whose `specialty_embedding` or keyword specialty matches the task description.
- Baseline protection reserves at least `baselineMinTrafficShare` (`0.5` by default) for the baseline variant.
- Epsilon exploration reserves `epsilon` (`0.1` by default) for uniform selection among active competitors.
- Exploitation uses active variants weighted by `traffic_share`.
- Candidate shadow selection picks up to `maxShadowVariantsPerAgentType` newest `candidate` variants for parallel evaluation; candidates do not receive live traffic until graduation.

`OrchestratorService` then resolves selected variant content and lessons before execution:

```typescript
// src/orchestrator/service.ts
const subtaskDispatch = await this.selectPersonaForDispatch(subtaskAgentType, { description, tier, projectId });
const coderLessons = await this.loadLessonsForDispatch(subtaskDispatch.selection.variantId, subtaskAgentType, description);

const liveTask = {
  type: subtaskAgentType,
  systemPrompt: subtaskDispatch.content,
  lessons: coderLessons.block || undefined
};
```

Lineage lessons come from `retrieveActiveLessonsForDispatch()` and are scoped to the selected variant's lineage root, so forked variants inherit useful corrections without globalizing niche behavior.

### Approve Task Flow

Human approves the PR via `POST /api/tasks/:id/approve`.

1. **Guard**: Task must be in `awaiting_approval`; throws otherwise.
2. **Doc agent**: Runs a `doc` type agent in the worktree to update documentation.
3. **PR merge**: `mergePullRequest(task.prUrl)` merges via `gh pr merge --squash`.
4. **Completion**: Task transitions to `completed`.

### Reject Task Flow

Human rejects via `POST /api/tasks/:id/reject` with a reason.

1. **Guard**: Task must be in `awaiting_approval`.
2. **PR close**: `closePullRequest(task.prUrl)` best-effort closes the old PR without merging.
3. **Old task failure**: The old task records `failure_analysis`, transitions from `awaiting_approval` to `failed`, and runs terminal cleanup/reflection.
4. **Fresh restart task**: `submitTask()` creates a new task from current HEAD with rejection feedback appended to the description and `reviewPlan: false`.
5. **Lineage event**: The old task emits `restart_spawned` with `restart_child_task_id` and rejection categories. The HTTP response body is the new restart task.

## State Transitions

```
received → assessing → planning → awaiting_spec_approval ⇄ replanning (spec)
                                          ↓ (approveSpec)
                                      planning → awaiting_plan_approval ⇄ replanning (plan)
                                                          ↓ (approvePlan)
                                                      executing → reviewing → reworking → executing (...)
                                                                            ↓
                                                                       pr_created → awaiting_approval
                                                                                          ↓         ↓
                                                                                     documenting  failed
                                                                                          ↓
                                                                                     completed
```

EXPRESS-tier tasks and tasks submitted with `reviewPlan: false` skip both `awaiting_spec_approval` and `awaiting_plan_approval` and transition directly from `planning` to `executing`. Internal reviewer findings can still trigger `reviewing → reworking → executing` within the same task. Operator rejection at `awaiting_approval` does not requeue the same task; it fails the old task and spawns a fresh restart task linked by `restart_spawned`. Any stage can transition to `failed`. See `domain-event-sourcing.md` for how transitions are persisted.

### Plan-review states

- `awaiting_spec_approval` — Set after the spec-phase planner attempt completes on STANDARD/THOROUGH tasks with `reviewPlan: true`. Human gate; no in-flight work; exempt from the staleness sweeper. Dashboard surfaces the spec body, decisions with alternatives rejected, and any `blockingQuestion` posed by the planner.
- `awaiting_plan_approval` — Set after the execution-plan-phase planner attempt completes. Same staleness exemption; dashboard renders the subtasks plus a collapsed Shared Understanding panel showing the approved spec for context.
- `planningContext.qmdContext` — Persisted alongside planner artifacts. Records whether QMD knowledgebase context was used (`status: "used"`) or the planner explicitly fell back when QMD was unavailable (`status: "fallback"`).
- `replanning` — Transient state during a critique-driven planner re-run. Returns to whichever review state it came from on success, transitions to `failed` on planner error or when the respective iteration budget is exceeded.

The two phases keep independent transcript namespaces and budgets:

| Phase | Transcript stage | Budget env var | Default |
|-------|-------------------|------------------|---------|
| Spec | `planner:spec` | `PLANNER_SPEC_MAX_ITERATIONS` | 3 revisions |
| Execution plan | `planner:execution_plan` | `PLANNER_MAX_ITERATIONS` | 3 revisions |

Worst-case planner runs per `THOROUGH` task: 1 + 3 (spec) + 1 + 3 (plan) = 8. For `combined`-phase tasks (`reviewPlan: false`) the single transcript counts against neither budget and there is no critique loop. Legacy tasks with `stage = 'planner'` rows are rewritten to `planner:execution_plan` by migration `011_spec_artifacts.sql`.

### `blockingQuestion` answer loop

When the spec-phase planner emits a non-empty `blockingQuestion`, the orchestrator persists it on the task projection as `currentBlockingQuestion`, pauses at `awaiting_spec_approval`, and surfaces the question as "Answer this question" in the dashboard. The operator's `critiqueSpec` reply is routed back to the next planner attempt prefixed with `## Operator Answer To Question\n> Q: <question>\n\nA: <operator text>`. `currentBlockingQuestion` clears on every successful planner attempt and re-sets if the new attempt asks a new question. Multi-question batching is out of scope in v1.

### Rollback-to-approved-spec policy

When a task in `awaiting_intervention` has an already-approved spec (`planningContext.reviewedAt` non-null), the retry API guards against silently discarding that approval:

- **Rollback to a spec-phase checkpoint** (`checkpoint.planning_phase = "spec"`): the orchestrator clears `planningContext.reviewedAt` and `approvalMode`, records `rollback_applied` with `invalidated_planning_context: true`, and retries in spec phase so the operator gets a fresh spec gate. Existing transcripts are preserved; new ones carry `rollback_event_id` so the critique budget effectively resets while the monotonic attempt counter does not.
- **Retry with `planningPhase: "spec"` but no spec-checkpoint rollback**: rejected with HTTP 409 `cannot_rollback_to_approved_spec` unless `force: true` is included in the request body.

## Decision Points

### Rework Trigger: CRITICAL or MAJOR Findings

```typescript
// src/orchestrator/service.ts
const mustRework = unresolvedFindings.some(
  (finding) => finding.severity === "CRITICAL" || finding.severity === "MAJOR"
);
if (!mustRework) {
  break; // MINOR/NITPICK findings do not block — proceed to PR
}
```

**Implemented in**: `OrchestratorService.executeAndReview()`.

### Phase-Aware Planner Output Parsing

`parsePlannerStructuredOutput` (in `src/orchestrator/planner-output.ts`) classifies planner output by *shape*, not by the planner's self-reported `planningPhase`. Four phases:

| Parsed phase | Shape | Used by orchestrator |
|---|---|---|
| `spec` | `discovery` + `spec` present, `subtasks` empty/missing | Persist spec, pause at `awaiting_spec_approval` |
| `execution_plan` | `subtasks` non-empty, no spec | Persist subtasks, pause at `awaiting_plan_approval` (or continue when review is bypassed) |
| `combined` | Both spec and subtasks present | Persist both; only valid when the orchestrator requested `combined` |
| `legacy_subtasks` | Same as `execution_plan` but no `requestedPhase` was set | Backward-compatibility bucket for pre-V2 tasks |

When the parsed phase contradicts the orchestrator's `requestedPhase`:

- `spec` requested, got `execution_plan` → records `planner_phase_mismatch`, drops the subtasks, pauses at `awaiting_spec_approval` with a `blockingQuestion` asking for clarification.
- `execution_plan` requested, got `spec` → records the warning, pauses at `awaiting_intervention` so the operator can decide.
- `combined` requested, got `spec` only → records `planner_phase_fallback_to_two_call` and immediately invokes the planner again with `execution_plan` (no pause). Combined-phase tasks never land at a human gate by design.
- `combined` requested, got `execution_plan` only → accepts and proceeds with spec artifacts null and `approvalMode: "auto"`.

The synthetic single-subtask fallback is only used as a last-resort when the planner returns neither subtasks nor a parseable spec.

## Integration Points

- **Complexity & Tier Routing**: `assessComplexity` + `routeTier` called in `submitTask`. See `domain-complexity-routing.md`.
- **Agent Execution**: All agent steps dispatched via `AgentExecutor.execute()`. See `domain-agent-execution.md`.
- **PR Gate & Version Control**: `evaluatePrGate`, `createPullRequest`, `mergePullRequest`, `closePullRequest`, `WorktreeManager`. See `domain-pr-gate.md`.
- **Event Sourcing**: Every state change recorded via `recordEvent()` + `transition()`. See `domain-event-sourcing.md`.
- **Dispatch Policy**: `createDispatcher()`, `filterSpecialtyEligible()`, `emitVariantSelected()`, and `runShadowDispatchesSafely()` select population variants, inject lineage lessons, and emit selection/shadow telemetry.
- **Prompt Envelope / Hashing**: planner dispatches use `buildPlannerDispatchEnvelope()` (from `planner-envelope.ts`) to centralize prompt composition + deterministic context envelope hashing. Token events persist `context_envelope_hash`, and payload telemetry includes prior hash occurrences plus `token_input_delta_from_last_hash`.
- **Skills Registry**: `SkillRegistry.skillsForAgent()` injects skill files into each agent prompt.
- **Web API**: Routes delegate directly to `OrchestratorService`. See `domain-web-api.md`.

## File Map

| File | Purpose |
|------|---------|
| `src/orchestrator/service.ts` | Core pipeline logic, agent dispatch, approval/rejection flows |
| `src/orchestrator/dispatch.ts` | Population dispatch policy: baseline, exploration, exploitation, shadow candidate selection |
| `src/orchestrator/classifier.ts` | Specialty eligibility filtering via `specialty_embedding` and keyword fallback |
| `src/orchestrator/lessons.ts` | Lineage-scoped active lesson retrieval for prompt injection |
| `src/orchestrator/state-machine.ts` | Allowed state transitions, `assertTransition` guard |
| `src/orchestrator/recovery.ts` | Crash recovery via NATS replay or SQLite rebuild |
| `src/types/core.ts` | Canonical types: `PipelineTask`, `TaskStage`, `Tier`, `ReviewFinding`, `PlanSubtask` |
