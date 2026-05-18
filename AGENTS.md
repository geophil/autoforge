# Autoforge Agent Map

Autoforge is a self-improving agentic software development harness. Treat this repository as the system of record: if a rule, command, or decision is not in the repo, do not assume it.

## Quick Start

- Install: `bun install`
- Test: `bun test`
- Type check: `bun run lint`
- Run app: `bun run dev`
- Full local stack with QMD/NATS: `docker compose up`

## Primary Context

- Architecture map: `docs/qmd/architecture-overview.md`
- Task orchestration: `docs/qmd/domain-task-orchestration.md`
- Agent execution/runtime boundary: `docs/qmd/domain-agent-execution.md`
- PR gate and tests: `docs/qmd/domain-pr-gate.md`
- Event sourcing/recovery: `docs/qmd/domain-event-sourcing.md`
- Conventions: `docs/qmd/patterns-and-conventions.md`

## Hard Rules

- Agents never hold credentials or push directly; privileged git/GitHub operations belong to the orchestrator.
- Work happens in isolated task worktrees/workspaces.
- Keep WIP to one active subtask until its verification evidence is recorded.
- A subtask contract needs behavior, files in scope, verification commands, test criteria, and completion evidence.
- STANDARD and THOROUGH tasks must not treat missing tests as a passing PR gate.
- Before a PR is opened, the task must emit test results and a clean task-exit check.

## Planner Expectations

When producing an execution plan, include one-session-sized subtasks. Each subtask should be a behavior/evidence contract, not just a coding note.

For QMD-enabled runs, planner output must include `planningContext.qmdContext` evidence.
