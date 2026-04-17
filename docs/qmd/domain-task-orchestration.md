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

**Enforced in**: `src/orchestrator/service.ts:99`

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

**Enforced in**: `src/orchestrator/service.ts:256`

### EXPRESS Tier Skips Review

Tasks routed to EXPRESS tier bypass the reviewer agent entirely to trade quality tolerance for speed.

```typescript
// src/orchestrator/service.ts
// EXPRESS tier skips the reviewer — faster turnaround, lower risk tolerance.
if (tier === "EXPRESS") {
  break;
}
```

**Enforced in**: `src/orchestrator/service.ts:219`

### Orchestrator Owns All Git Operations

Agents never push directly. The orchestrator commits each subtask's output after the agent reports success.

```typescript
// src/orchestrator/service.ts
// Orchestrator commits agent output — agents never push directly.
this.deps.worktrees.commit({ branch, path: worktreePath }, `autoforge: ${subtask.description}`);
```

**Enforced in**: `src/orchestrator/service.ts:214`. See `domain-pr-gate.md` > Git Worktree Isolation.

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

**Enforced in**: `src/orchestrator/service.ts:364`

## Core Flows

### Submit Task Flow

A new task progresses from submission through to a PR awaiting human approval.

1. **Entry point**: `POST /api/tasks` → `OrchestratorService.submitTask(projectId, description)`
2. **Assessment**: `assessComplexity(description)` assigns scope/novelty/risk/coupling dimensions. `routeTier(assessment)` maps them to EXPRESS/STANDARD/THOROUGH. See `domain-complexity-routing.md`.
3. **Worktree creation**: A git branch `autoforge/{taskId}` and isolated working directory are created. See `domain-pr-gate.md` > Git Worktree Isolation.
4. **Initial events**: `created` and `state.assessing`/`state.planning` events are recorded atomically.
5. **Planner agent**: Executor runs a `planner` type agent; output is parsed into `PlanSubtask[]` and the turn-by-turn transcript is persisted to `agent_transcripts` (stage `planner`, attempt 0).
6. **Plan-review pause** (STANDARD/THOROUGH, or any task submitted with `reviewPlan: true`): task transitions to `awaiting_plan_approval` and awaits human action. On approve, the pipeline resumes at step 7. On critique, the planner re-runs with the prior plan and critique appended (up to `PLANNER_MAX_ITERATIONS` revisions), producing a new `agent_transcripts` row per attempt and returning to `awaiting_plan_approval`. EXPRESS tasks skip this pause and proceed directly to step 7.
7. **Execute & Review loop**: `executeAndReview()` runs coders for each subtask, commits their output, then runs the reviewer (unless EXPRESS). Repeats up to 3 iterations if CRITICAL/MAJOR findings exist.
8. **PR Gate**: `evaluatePrGate()` checks test pass rate, review score, and unresolved CRITICAL findings. See `domain-pr-gate.md`.
9. **PR creation**: If gate passes, `createPullRequest()` pushes the branch and opens a GitHub PR.
10. **State**: Task transitions to `awaiting_approval`.

**Error paths**:
- Any coder returning FAILED/TIMEOUT → task transitions to `failed`
- Rework iteration > 3 → `failed`
- PR gate rejected → `failed`

### Approve Task Flow

Human approves the PR via `POST /api/tasks/:id/approve`.

1. **Guard**: Task must be in `awaiting_approval`; throws otherwise.
2. **Doc agent**: Runs a `doc` type agent in the worktree to update documentation.
3. **PR merge**: `mergePullRequest(task.prUrl)` merges via `gh pr merge --squash`.
4. **Completion**: Task transitions to `completed`.

### Reject Task Flow

Human rejects via `POST /api/tasks/:id/reject` with a reason.

1. **Guard**: Task must be in `awaiting_approval`.
2. **PR close**: `closePullRequest(task.prUrl)` closes the PR without merging.
3. **Re-queue**: Transitions through `reworking → executing → reviewing → pr_created → awaiting_approval` (all recorded as events) with incremented iteration.

## State Transitions

```
received → assessing → planning → awaiting_plan_approval ⇄ replanning
                                        ↓ (approve)
                                    executing → reviewing → reworking → executing (...)
                                                          ↓
                                                     pr_created → awaiting_approval
                                                                        ↓         ↓
                                                                   documenting  reworking
                                                                        ↓
                                                                   completed
```

EXPRESS-tier tasks and tasks submitted with `reviewPlan: false` skip `awaiting_plan_approval` and transition directly from `planning` to `executing`. Any stage can transition to `failed`. See `domain-event-sourcing.md` for how transitions are persisted.

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

**Enforced in**: `src/orchestrator/service.ts:250`

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

**Enforced in**: `src/orchestrator/service.ts:423`

## Integration Points

- **Complexity & Tier Routing**: `assessComplexity` + `routeTier` called in `submitTask`. See `domain-complexity-routing.md`.
- **Agent Execution**: All agent steps dispatched via `AgentExecutor.execute()`. See `domain-agent-execution.md`.
- **PR Gate & Version Control**: `evaluatePrGate`, `createPullRequest`, `mergePullRequest`, `closePullRequest`, `WorktreeManager`. See `domain-pr-gate.md`.
- **Event Sourcing**: Every state change recorded via `recordEvent()` + `transition()`. See `domain-event-sourcing.md`.
- **Skills Registry**: `SkillRegistry.skillsForAgent()` injects skill files into each agent prompt.
- **Web API**: Routes delegate directly to `OrchestratorService`. See `domain-web-api.md`.

## File Map

| File | Purpose |
|------|---------|
| `src/orchestrator/service.ts` | Core pipeline logic, agent dispatch, approval/rejection flows |
| `src/orchestrator/state-machine.ts` | Allowed state transitions, `assertTransition` guard |
| `src/orchestrator/recovery.ts` | Crash recovery via NATS replay or SQLite rebuild |
| `src/types/core.ts` | Canonical types: `PipelineTask`, `TaskStage`, `Tier`, `ReviewFinding`, `PlanSubtask` |
