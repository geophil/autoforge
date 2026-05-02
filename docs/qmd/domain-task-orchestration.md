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

## Core Flows

### Submit Task Flow

A new task progresses from submission through to a PR awaiting human approval.

1. **Entry point**: `POST /api/tasks` → `OrchestratorService.submitTask(projectId, description)`
2. **Assessment**: `assessComplexity(description)` assigns scope/novelty/risk/coupling dimensions. `routeTier(assessment)` maps them to EXPRESS/STANDARD/THOROUGH. See `domain-complexity-routing.md`.
3. **Worktree creation**: A git branch `autoforge/{taskId}` and isolated working directory are created. See `domain-pr-gate.md` > Git Worktree Isolation.
4. **Initial events**: `created` and `state.assessing`/`state.planning` events are recorded atomically.
5. **Planner dispatch**: `OrchestratorService` asks `createDispatcher().selectVariant("planner", taskContext)` for the selected population variant, resolves that variant's prompt content through `PersonaRegistry.resolveVariant()`, injects active lineage lessons from `loadLessonsForDispatch()`, and emits `variant_selected`.
6. **Planner agent**: Executor runs a `planner` type agent; output is parsed into `PlanSubtask[]` and the turn-by-turn transcript is persisted to `agent_transcripts` (stage `planner`, attempt 0).
7. **Plan-review pause** (STANDARD/THOROUGH, or any task submitted with `reviewPlan: true`): task transitions to `awaiting_plan_approval` and awaits human action. On approve, the pipeline resumes at step 8. On critique, the planner re-runs with the prior plan and critique appended (up to `PLANNER_MAX_ITERATIONS` revisions), producing a new `agent_transcripts` row per attempt and returning to `awaiting_plan_approval`. EXPRESS tasks skip this pause and proceed directly to step 8.
8. **Execute & Review loop**: `executeAndReview()` runs coders for each subtask, commits their output, runs `post_coder_pre_review` lifecycle hooks, then runs the reviewer (unless EXPRESS). Each planner/coder/reviewer/doc dispatch selects a population variant, injects selected variant content and lineage lessons, and runs any candidate shadow variants after the live result. Repeats up to 3 iterations if CRITICAL/MAJOR findings exist.
9. **PR Gate**: `evaluatePrGate()` checks test pass rate, review score, and unresolved CRITICAL findings. See `domain-pr-gate.md`.
10. **PR creation**: If gate passes, `createPullRequest()` pushes the branch and opens a GitHub PR.
11. **State**: Task transitions to `awaiting_approval`.

**Error paths**:
- Any coder returning FAILED/TIMEOUT → task transitions to `failed`
- Rework iteration > 3 → `failed`
- PR gate rejected → `failed`

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
received → assessing → planning → awaiting_plan_approval ⇄ replanning
                                        ↓ (approve)
                                    executing → reviewing → reworking → executing (...)
                                                          ↓
                                                     pr_created → awaiting_approval
                                                                        ↓         ↓
                                                                   documenting  failed
                                                                        ↓
                                                                   completed
```

EXPRESS-tier tasks and tasks submitted with `reviewPlan: false` skip `awaiting_plan_approval` and transition directly from `planning` to `executing`. Internal reviewer findings can still trigger `reviewing → reworking → executing` within the same task. Operator rejection at `awaiting_approval` does not requeue the same task; it fails the old task and spawns a fresh restart task linked by `restart_spawned`. Any stage can transition to `failed`. See `domain-event-sourcing.md` for how transitions are persisted.

### Plan-review states

- `awaiting_plan_approval` — Set after the planner completes on STANDARD/THOROUGH tasks (or any task submitted with `reviewPlan: true`). Human gate; no in-flight work; exempt from the staleness sweeper.
- `replanning` — Transient state during a critique-driven planner re-run. Returns to `awaiting_plan_approval` on success, transitions to `failed` on planner error or when `PLANNER_MAX_ITERATIONS` is exceeded.

The plan attempt counter (0-indexed internally, displayed 1-indexed) is the row count of `agent_transcripts` for the task with `stage = 'planner'`. The cap is configurable via `PLANNER_MAX_ITERATIONS` (default 3 revisions, so up to 4 planner runs total).

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

### Plan Subtask Fallback

If the planner agent returns no structured subtasks, a single catch-all subtask is synthesized:

```typescript
// src/orchestrator/service.ts
return [{
  id: `${taskId}-subtask-1`,
  sequence: 1,
  description: "Implement requested behavior with tests-first workflow.",
  filesInScope: ["src/"],
  dependencies: [],
  testCriteria: ["All tests pass."]
}];
```

**Implemented in**: `OrchestratorService.parsePlannerOutput()`.

## Integration Points

- **Complexity & Tier Routing**: `assessComplexity` + `routeTier` called in `submitTask`. See `domain-complexity-routing.md`.
- **Agent Execution**: All agent steps dispatched via `AgentExecutor.execute()`. See `domain-agent-execution.md`.
- **PR Gate & Version Control**: `evaluatePrGate`, `createPullRequest`, `mergePullRequest`, `closePullRequest`, `WorktreeManager`. See `domain-pr-gate.md`.
- **Event Sourcing**: Every state change recorded via `recordEvent()` + `transition()`. See `domain-event-sourcing.md`.
- **Dispatch Policy**: `createDispatcher()`, `filterSpecialtyEligible()`, `emitVariantSelected()`, and `runShadowDispatchesSafely()` select population variants, inject lineage lessons, and emit selection/shadow telemetry.
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
