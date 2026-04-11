# Architecture Overview

Autoforge is a self-improving agentic software development system. It receives natural-language feature requests, routes them through a multi-agent pipeline, and produces human-reviewable pull requests. Over time it accumulates institutional knowledge and — via a planned meta-loop — improves its own processes through measured experimentation. The system runs as a single Bun process backed by SQLite, with NATS JetStream as an optional event bus.

## System Topology

Autoforge is a **monolith with pluggable agent backends**. There are no microservices. One Bun process owns the orchestrator, HTTP server, database client, and NATS client. Agent runtimes (Claude Code subprocess, Anthropic SDK API calls) are external processes or network calls spawned per task.

```
Human → HTTP POST /api/tasks
          ↓
    OrchestratorService (Bun process)
          ↓
    Complexity Assessment → Tier Routing
          ↓
    AgentExecutor (pluggable)
      ├── ClaudeCodeExecutor (subprocess)
      ├── AnthropicSdkExecutor (API)
      └── MockExecutor (tests)
          ↓
    Git Worktree (isolated branch per task)
          ↓
    PR Gate (tests + review score + findings)
          ↓
    GitHub PR (via gh CLI)
          ↓
    Human Approval → PR Merge
```

**Storage**:
- `SQLite` — append-only event log + materialized task/finding views (source of truth)
- `NATS JetStream` — event streaming, optional (system runs without it)
- `Git worktrees` — per-task isolated working directories under `.runtime-worktrees/`

## Domain Boundaries

| Domain | Responsibility | Key Entry Points |
|--------|---------------|-----------------|
| Task Orchestration | Pipeline coordination, state machine, agent dispatch | `OrchestratorService.submitTask`, `approveTask`, `rejectTask` |
| Complexity & Tier Routing | Classify task description, select tier | `assessComplexity()`, `routeTier()` |
| Agent Execution | Dispatch work to AI runtimes, enforce budgets | `AgentExecutor.execute()`, `SkillRegistry.skillsForAgent()` |
| PR Gate & Version Control | Quality gate, GitHub operations, git isolation | `evaluatePrGate()`, `createPullRequest()`, `WorktreeManager` |
| Event Sourcing & Recovery | Durable event log, projections, crash recovery | `DbClient.appendEvent()`, `RecoveryService.recover()` |
| Web API & Dashboard | HTTP routes, SSE live updates | `createWebServer()`, `/api/tasks`, `/api/events` |

## Data Flow: Task Submission to PR

```
1. POST /api/tasks {projectId, description}
2. OrchestratorService.submitTask()
   a. assessComplexity(description)  → ComplexityAssessment
   b. routeTier(assessment)          → Tier (EXPRESS|STANDARD|THOROUGH)
   c. WorktreeManager.create(taskId) → branch + isolated directory
   d. recordEvent("created")
   e. executor.execute({ type: "planner", ... })  → PlanSubtask[]
   f. for each subtask:
        executor.execute({ type: "coder", ... })
        worktrees.commit(branch, message)
      (loop up to 3x if reviewer finds CRITICAL/MAJOR; EXPRESS skips reviewer)
   g. runAuthenticatedTests(worktreePath)
   h. evaluatePrGate(passRate, reviewScore, findings)
   i. createPullRequest(branch, description, findings)
   j. recordEvent("state.awaiting_approval")
3. Return task { state: "awaiting_approval", prUrl }

4. Human reviews PR on GitHub
5. POST /api/tasks/:id/approve
   a. executor.execute({ type: "doc", ... })
   b. mergePullRequest(prUrl)
   c. recordEvent("state.completed")
```

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | Fast TS execution, native SQLite, subprocess management |
| Language | TypeScript (ESM) | Strict mode, Zod for runtime validation |
| HTTP Framework | Hono + @hono/node-server | Lightweight, edge-compatible |
| Database | SQLite via `bun:sqlite` | WAL mode, single writer (orchestrator) |
| Messaging | NATS JetStream | Optional; graceful degradation to SQLite-only |
| AI Agent (default) | Claude Code CLI | Spawned as subprocess |
| AI Agent (alt) | Anthropic SDK (`@anthropic-ai/sdk`) | Tool-use agentic loop |
| GitHub Integration | `gh` CLI | PR create/merge/close |
| Containerization | Docker Compose | NATS + Autoforge services |

## Key Architectural Decisions

**Brain / Hands / Session separation**: The orchestrator (brain) is stateless — it can crash and recover by replaying events. Agent runtimes (hands) are disposable subprocesses with no persistent state. The event log (session) is the single source of truth.

**Agents never hold credentials**: `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` live only in the orchestrator process. Git push and PR operations happen after the agent completes, in the orchestrator.

**Sequential agent pipeline by default**: Each stage waits for the previous to complete. This lets the output of planning inform coding, and the output of coding inform review. Parallelism is a future opt-in.

**SQLite + WAL as the durable core**: NATS adds streaming and recovery speed but is not required. On startup, if NATS replay returns 0 events, the system rebuilds from SQLite.

## Deployment

**Local development**: `bun run src/index.ts` with optional `docker-compose up` for NATS.

**Docker Compose**: Two services — `nats` (JetStream enabled) and `autoforge` (Bun, binds port 3000). Project repo and skills are volume-mounted from the host.

```yaml
# docker-compose.yml
services:
  nats:      { image: nats:latest, command: ["--jetstream", "--store_dir=/data"] }
  autoforge: { image: oven/bun:latest, command: ["bun", "run", "src/index.ts"] }
```
