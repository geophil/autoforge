# Architecture Overview

Autoforge is a self-improving agentic software development system. It receives natural-language feature requests, routes them through a multi-agent pipeline, and produces human-reviewable pull requests. A meta agent analyzes pipeline outcomes and improves specialist personas and skills through measured experimentation. The system runs as a single Bun process backed by SQLite, with NATS JetStream as an optional event bus and a QMD knowledge base for architecture context.

## System Topology

Autoforge is a **monolith with pluggable agent backends**. There are no microservices. One Bun process owns the orchestrator, HTTP server, database client, and NATS client. Agent runtimes (Claude Code subprocess, Anthropic SDK API calls) are external processes or network calls spawned per task.

```
Human → HTTP POST /api/tasks
          ↓
    OrchestratorService (Bun process)
          ↓
    Complexity Assessment → Tier Routing
          ↓
    Lead Agent (planner) ←→ QMD MCP (architecture knowledge base)
          ↓ PlanSubtask[]
    Specialist Agents (persona + skills per type)
      ├── coder    — implements subtasks
      ├── reviewer — inspects output, produces findings
      └── doc      — updates documentation after approval
          ↓
    Git Worktree (isolated branch per task)
          ↓
    PR Gate (tests + review score + findings)
          ↓
    GitHub PR (via gh CLI)
          ↓
    Human Approval → PR Merge

Human → HTTP POST /api/meta
          ↓
    Meta Agent — queries agent_performance, proposes persona/skill edit
          ↓
    Experiment activated in skill_versions (PersonaRegistry DB-first)
          ↓
    Canary: next N tasks use new version → compare outcomes → keep or revert
```

**Composition**: Every agent — planner, coder, reviewer, doc, meta — is composed the same way: `persona(type) + skills(type) + task_context`, resolved through `PersonaRegistry` and `SkillRegistry`, dispatched through `AgentExecutor`. No special paths per agent type.

**Storage**:
- `SQLite` — append-only event log + materialized projections (source of truth); includes `skill_versions` for persona/skill versioning and `experiments` for improvement history
- `NATS JetStream` — event streaming, optional (system runs without it)
- `Git worktrees` — per-task isolated working directories under `.runtime-worktrees/`
- `QMD index` — vector + BM25 index of `docs/qmd/` served via HTTP MCP on port 8181

## Domain Boundaries

| Domain | Responsibility | Key Entry Points |
|--------|---------------|-----------------|
| Task Orchestration | Pipeline coordination, state machine, agent dispatch | `OrchestratorService.submitTask`, `approveTask`, `rejectTask`, `submitMetaTask` |
| Complexity & Tier Routing | Classify task description, select tier | `assessComplexity()`, `routeTier()` |
| Agent Execution | Dispatch work to AI runtimes, enforce budgets, inject personas + skills | `AgentExecutor.execute()`, `PersonaRegistry.resolve()`, `SkillRegistry.skillsForAgent()` |
| Persona & Skill Versioning | Version and activate prompt assets; track experiments | `PersonaRegistry.snapshotId()`, `DbClient.upsertPromptAsset()`, `experiments` table |
| PR Gate & Version Control | Quality gate, GitHub operations, git isolation | `evaluatePrGate()`, `createPullRequest()`, `WorktreeManager` |
| Event Sourcing & Recovery | Durable event log, projections, crash recovery | `DbClient.appendEvent()`, `RecoveryService.recover()` |
| Web API & Dashboard | HTTP routes, SSE live updates | `createWebServer()`, `/api/tasks`, `/api/meta`, `/api/events` |

## Data Flow: Task Submission to PR

```
1. POST /api/tasks {projectId, description}
2. OrchestratorService.submitTask()
   a. assessComplexity(description)  → ComplexityAssessment
   b. routeTier(assessment)          → Tier (EXPRESS|STANDARD|THOROUGH)
   c. WorktreeManager.create(taskId) → branch + isolated directory
   d. recordEvent("created")
   e. executor.execute({
        type: "planner",
        model: plannerModel(tier),                  ← tier-aware planner model
        systemPrompt: personas.resolve("planner"),  ← persona injected
        skillFiles: skills.skillsForAgent("planner"),
        environment: { QMD_MCP_URL }                ← knowledge base access
      }) → PlanSubtask[] + AgentTranscript (captured turn-by-turn)
        db.insertTranscript({ taskId, stage: "planner", attempt, turns, ... })
   f. if pausePolicy(tier, opts.reviewPlan):
        transition to "awaiting_plan_approval" → return
        Human inspects plan + transcript via dashboard Plan Review Panel.
        On approve  → continue at step g.
        On critique → re-run planner with original prompt + prior plan + critique
                      (up to PLANNER_MAX_ITERATIONS revisions, default 3),
                      append a new agent_transcripts row, stay at (f).
   g. for each subtask:
        executor.execute({
          type: subtask.agentType ?? "coder",
          systemPrompt: personas.resolve(agentType),  ← specialist persona
          skillFiles: skills.skillsForAgent(agentType)
        })
        worktrees.commit(branch, message)
        recordEvent("subtask_done", { persona_version_id, skill_version_ids, token_usage })
      (loop up to 3x if reviewer finds CRITICAL/MAJOR; EXPRESS skips reviewer)
   h. runAuthenticatedTests(worktreePath)
   i. recordEvent("test_results", { passRate })
   j. evaluatePrGate(passRate, reviewScore, findings)
   k. createPullRequest(branch, description, findings)
   l. recordEvent("state.awaiting_approval")
3. Return task { state: "awaiting_approval", prUrl }

4. Human reviews PR on GitHub
5. POST /api/tasks/:id/approve
   a. executor.execute({ type: "doc", systemPrompt: personas.resolve("doc"), ... })
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
| Containerization | Docker Compose | NATS + QMD + Autoforge services |
| Knowledge Base | QMD (`@tobilu/qmd`) | BM25 + vector search over `docs/qmd/`, served via HTTP MCP |

## Key Architectural Decisions

**Brain / Hands / Session separation**: The orchestrator (brain) is stateless — it can crash and recover by replaying events. Agent runtimes (hands) are disposable subprocesses with no persistent state. The event log (session) is the single source of truth.

**Composition over configuration**: Every agent type — including the meta agent — is composed identically from a persona and skills. There are no special code paths per agent type. Adding a new specialist means adding a persona file and a skills mapping entry.

**Agents never hold credentials**: `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` live only in the orchestrator process. Git push and PR operations happen after the agent completes, in the orchestrator. The exception is `QMD_MCP_URL`, which the planner receives to query the knowledge base.

**Unified prompt asset versioning**: Personas and skills are both stored in `skill_versions` under a naming convention (`persona:coder`, `skill:tdd`). `PersonaRegistry` resolves the DB-active version first, enabling the meta-loop to activate improvements without file changes. Each agent execution records its `persona_version_id` and `skill_version_ids` in the event payload for outcome attribution.

**Sequential agent pipeline by default**: Each stage waits for the previous to complete. This lets the output of planning inform coding, and the output of coding inform review. Parallelism is a future opt-in.

**SQLite + WAL as the durable core**: NATS adds streaming and recovery speed but is not required. On startup, if NATS replay returns 0 events, the system rebuilds from SQLite.

## Deployment

**Local development**: `bun run src/index.ts` without NATS or QMD (SQLite-only, planner falls back to filesystem exploration).

**Docker Compose**: Three services — `nats` (JetStream), `qmd` (knowledge base, port 8181), and `autoforge` (Bun, port 3000). Project repo, skills, and docs are volume-mounted from the host. `autoforge` waits for `qmd` to pass its health check before starting.

```yaml
# docker-compose.yml (abridged)
services:
  nats:
    image: nats:latest
    command: ["--jetstream", "--store_dir=/data"]
  qmd:
    build: ./docker/qmd          # embeds docs/qmd/ on boot, re-indexes every 3h
    environment:
      - QMD_DOCS_DIR=/data/docs/qmd
    ports: ["8181:8181"]
  autoforge:
    image: oven/bun:latest
    command: ["bun", "run", "src/index.ts"]
    depends_on:
      qmd: { condition: service_healthy }
    environment:
      - QMD_MCP_URL=http://qmd:8181/mcp
```
