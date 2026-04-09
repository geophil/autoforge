# AUTOFORGE: Architecture & Implementation Plan

## Document Purpose

This is the actionable blueprint for building AUTOFORGE. It supersedes the earlier engineering prompt, brainstorm, and implementation strategy documents by consolidating all decisions made during the design process into a single source of truth. Hand this to Claude Code to start building.

---

## 1. WHAT AUTOFORGE IS

AUTOFORGE is a self-improving agentic software development system. It receives feature requests in natural language, decomposes them into specialized tasks, dispatches AI coding agents to execute each task, reviews and merges the results, and continuously improves its own processes through an autoresearch-style experiment loop.

The system is **LLM-agnostic by design.** The orchestration layer defines interfaces for agent execution, not implementations. Claude Code is the initial agent runtime, but the architecture supports swapping in Codex, local models, or future agent runtimes via adapter implementations. Skills are markdown files that get translated to whatever format the target runtime expects.

The system's unique value: **it gets better at building software the more software it builds.** Every completed task produces metrics. Every review produces insights. The meta-loop analyzes patterns across all completed work, generates hypotheses for process improvements, tests them empirically, and keeps what works. Skills, prompts, and routing logic all evolve through measured experimentation.

### Core Architecture (Brain / Hands / Session)

Inspired by Anthropic's managed agents architecture, AUTOFORGE decouples three concerns:

```
BRAIN  — The Orchestrator: stateless event processor that makes decisions,
         constructs context envelopes, and dispatches work. Can crash and
         recover from the event log. LLM-agnostic.

HANDS  — Agent Executors: pluggable runtimes (Claude Code, Codex, future
         providers) that receive tasks and return results. Disposable.
         No secrets, no persistent state. Cattle, not pets.

SESSION — Event Log + Database: append-only record of everything that
          happened. The single source of truth for recovery. NATS JetStream
          streams + SQLite materialized views.
```

```
Human → Feature Request (text)
  → BRAIN: Orchestrator (TypeScript state machine, event-driven)
    → Complexity Assessment → Tier Routing
    → HANDS: Specialized Agent Pipeline (via AgentExecutor interface):
        Planner → Coder(s) → Reviewer → PR Agent → Doc Agent
    → Human Approval (PR review)
    → SESSION: Metrics Collection + Event Log
    → Meta-Loop (periodic skill improvement)
    → QMD Knowledge Base (accumulating institutional knowledge)
```

### Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Bun | Fast, native TS, good subprocess mgmt, aligns with QMD |
| Language | TypeScript | Shared with QMD, web UI, full-stack simplicity |
| Agent Engine | Pluggable (Claude Code default) | Via AgentExecutor interface; Codex, local models swappable |
| Skills Framework | Superpowers + gstack patterns | Execution discipline + role-based review perspectives |
| Messaging | NATS with JetStream | Event-driven coordination, persistent streams, event log |
| Knowledge Base | QMD (MCP server) | Hybrid search over markdown docs in repo |
| State/Metrics DB | SQLite (single-writer via orchestrator) | Simple, no extra service, sufficient for single-orchestrator |
| Deployment | Docker Compose (local), scale-to-zero (cloud) | Pay only when agents are running |
| Web UI | Bun + Hono/Elysia backend, React frontend | Dashboard for visibility and control |
| VCS | Git | Worktree isolation per task, PRs for review |

---

## 2. CORE PRINCIPLES

These govern every design decision. They are not parameters the meta-loop can optimize away.

### From Autoresearch

**P1: FIXED-BUDGET EXPERIMENTS.** Every agent task gets a time budget. This makes experiments comparable. If a planning step takes 5 minutes, all planning experiments take 5 minutes.

**P2: MEASURABLE OUTCOMES.** Each agent type has a primary metric. The meta-loop's keep/discard decisions are driven by these metrics.

**P3: KEEP OR DISCARD.** After each meta-loop experiment, measure the primary metric. Improved → keep. Equal or worse → revert. No partial keeps.

**P4: ONE VARIABLE AT A TIME.** Each meta-loop experiment modifies exactly one skill or one agent prompt. Never bundle changes.

**P5: SIMPLICITY CRITERION.** A small improvement that adds ugly complexity is not worth it. Removing something and getting equal results IS worth it. Process complexity must be earned through measured improvement.

**P6: NEVER STOP.** The meta-loop runs continuously. If stuck, shift strategies: combine near-misses, expand search space, mine the knowledge base, flag for human attention.

### From Superpowers

**P7: SPECIALIZED AGENTS FOR SPECIALIZED TASKS.** Short-lived agents with narrow, well-defined skills executing focused tasks are simpler and more effective than generalist agents. Each specialist has smaller context, clearer mandate, more measurable output.

**P8: MANDATORY SKILL ACTIVATION.** Before any action, an agent checks whether a skill applies. If there's even a 1% chance it does, the skill is invoked. Anti-rationalization: agents cannot talk themselves out of following a skill.

**P9: TESTS BEFORE CODE. ALWAYS.** No exceptions. TDD: RED (write failing test) → GREEN (minimal code to pass) → REFACTOR.

**P10: CONTEXT ISOLATION.** Each agent receives only the context it needs. No inheriting parent session history. The orchestrator constructs context envelopes.

**P11: STRUCTURED STATUS PROTOCOL.** Agents report: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT. The orchestrator handles each status differently.

### From Our Design Sessions

**P12: EVENT-DRIVEN ORCHESTRATION.** The orchestrator listens to NATS events and reacts. No polling. Database backs the state machine but NATS events are the triggers.

**P13: SEQUENTIAL BY DEFAULT.** Learning from one step informs the next. Parallelize only when dependency analysis proves tasks are independent and parallelism is explicitly configured.

**P14: HUMAN APPROVAL ON PRS.** Every PR requires human review to start. The meta-loop always requires human sign-off for kept experiments. Trust is earned over time.

**P15: CONTINUOUS SKILL IMPROVEMENT IS THE CORE VALUE.** The flywheel: specialized agents produce measurable outcomes → metrics reveal patterns → meta-loop improves skills → agents perform better → richer data → smarter improvements.

### From Brain/Hands/Session Architecture

**P16: STATELESS ORCHESTRATOR, DURABLE EVENT LOG.** The orchestrator (brain) is a stateless event processor. It can crash and fully recover by replaying the event log (session). All state transitions are recorded as events with enough context to resume from any point.

**P17: DISPOSABLE EXECUTION ENVIRONMENTS.** Agent runtimes (hands) are cattle, not pets. They are created for a task, produce artifacts, report results, and are destroyed. No persistent state lives in the execution environment. If one dies, the orchestrator spawns a replacement and retries.

**P18: LLM-AGNOSTIC EXECUTOR INTERFACE.** The orchestrator dispatches tasks through an `AgentExecutor` interface. The implementation (Claude Code, Codex, local models, managed services) is a configuration choice, not a code change. Skills are markdown; the adapter translates them to whatever format the target runtime expects.

**P19: SECRETS NEVER REACH THE SANDBOX.** Agent execution environments do not hold credentials. Git operations (push, PR creation) and authenticated API calls happen in the orchestrator after the agent produces artifacts. Test runs requiring project secrets use a separate, orchestrator-controlled test runner.

---

## 3. SYSTEM TOPOLOGY

### Local Development (Docker Compose)

```
┌──────────────────────────────────────────────────────────────────────┐
│                          DOCKER COMPOSE                              │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │   NATS     │  │    QMD     │  │ ORCHESTR-  │  │   WEB UI     │  │
│  │  CLUSTER   │  │   (MCP)   │  │   ATOR     │  │  (React +    │  │
│  │            │  │            │  │  (BRAIN)   │  │   Hono)      │  │
│  │ JetStream  │  │ Indexes    │  │            │  │              │  │
│  │ enabled    │  │ /docs in   │  │ Stateless  │  │ Dashboard    │  │
│  │            │  │ project    │  │ event      │  │ Task view    │  │
│  │ (SESSION)  │  │ repo       │  │ processor  │  │ Approval     │  │
│  │            │  │            │  │            │  │ queue        │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
│         │               │               │               │            │
│         └───────────────┴───────┬───────┴───────────────┘            │
│                                 │                                    │
│                          Shared Network                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    VOLUMES                                   │    │
│  │  /data/db          - SQLite database (materialized views)   │    │
│  │  /data/projects    - Cloned project repos + worktrees       │    │
│  │  /data/skills      - Skill files (version controlled)       │    │
│  │  /data/docs        - QMD-indexed documentation              │    │
│  │  /data/results.tsv - Human-scannable experiment log         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘

         Agent runtimes (HANDS) are spawned as subprocesses
         by the Orchestrator via the AgentExecutor interface.
         Each gets its own git worktree and skill set.
         No secrets. No persistent state. Disposable.
```

### Cloud Deployment (Scale-to-Zero)

The cloud architecture minimizes cost by ensuring compute runs only when agents are actively working. When no tasks are in flight, the system costs near-zero beyond minimal storage.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ALWAYS ON (minimal cost, ~$15-25/month total):                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  NATS        │  │  Database    │  │  Event       │              │
│  │  (smallest   │  │  (RDS micro  │  │  Bridge      │              │
│  │   instance   │  │   or SQLite  │  │  (Lambda/    │              │
│  │   or managed │  │   on EFS)    │  │   tiny       │              │
│  │   service)   │  │              │  │   container) │              │
│  │              │  │              │  │              │              │
│  │  Receives    │  │  Durable     │  │  Listens to  │              │
│  │  events,     │  │  state       │  │  NATS, wakes │              │
│  │  persists    │  │  store       │  │  orchestrator│              │
│  │  streams     │  │              │  │  on new tasks│              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                      │
│  SCALE-TO-ZERO (runs only when tasks are active):                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ ORCHESTRATOR │  │  QMD         │  │  WEB UI      │              │
│  │ (Fargate     │  │  (Fargate    │  │  (Fargate    │              │
│  │  or Lambda)  │  │   or Lambda) │  │   or static  │              │
│  │              │  │              │  │   S3+CF)     │              │
│  │ Wakes when   │  │ Wakes when   │  │ Static site  │              │
│  │ Event Bridge │  │ orchestrator │  │ + API calls  │              │
│  │ triggers it  │  │ needs KB     │  │ to wake API  │              │
│  │              │  │ queries      │  │              │              │
│  │ Spawns agent │  │              │  │              │              │
│  │ runtimes     │  │              │  │              │              │
│  └──────┬───────┘  └──────────────┘  └──────────────┘              │
│         │                                                            │
│  ON-DEMAND (runs only during task execution):                        │
│  ┌──────▼───────┐                                                    │
│  │  AGENT       │  ← Fargate tasks, or managed agent APIs           │
│  │  RUNTIMES    │  ← Spawned per-subtask, destroyed after           │
│  │  (HANDS)     │  ← Claude Code / Codex / future providers        │
│  │              │  ← No secrets, no persistent state                │
│  │  Cost: $0    │                                                    │
│  │  when idle   │                                                    │
│  └──────────────┘                                                    │
│                                                                      │
│  STORAGE (persistent, low cost):                                     │
│  ┌──────────────┐  ┌──────────────┐                                 │
│  │  EFS         │  │  S3          │                                 │
│  │  (repos,     │  │  (backups,   │                                 │
│  │   worktrees, │  │   artifacts, │                                 │
│  │   skills)    │  │   results)   │                                 │
│  └──────────────┘  └──────────────┘                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

Idle cost: ~$15-25/month (NATS + DB + storage)
Active cost: per-second Fargate billing + LLM API usage
```

### Scale-to-Zero Flow

```
1. IDLE STATE
   - NATS running (tiny instance, persistent streams)
   - Database persisted (RDS micro or SQLite on EFS)
   - Event Bridge listening (near-zero cost)
   - Everything else: OFF

2. NEW TASK ARRIVES (via API call or scheduled trigger)
   - Event published to NATS
   - Event Bridge detects new task event
   - Event Bridge wakes Orchestrator (Fargate task or Lambda)

3. ORCHESTRATOR WAKES
   - Reads event log from NATS JetStream (recovers full state)
   - Materializes current state into database
   - Runs complexity assessment
   - Begins dispatching agent tasks via AgentExecutor interface

4. AGENTS EXECUTE
   - Each agent is a Fargate task (or API call to managed service)
   - Agent runs, produces artifacts, reports status
   - Orchestrator receives completion event, dispatches next step

5. PIPELINE COMPLETES
   - All steps done, PR created, awaiting human approval
   - Orchestrator publishes final events, shuts down
   - Back to idle state

6. HUMAN APPROVES (via dashboard)
   - Dashboard sends API call → publishes NATS event
   - Event Bridge wakes Orchestrator
   - Orchestrator performs merge, triggers doc agent, records metrics
   - Back to idle state
```

### Agent Executor Interface (LLM-Agnostic)

The orchestrator never calls a specific LLM provider directly. All agent work goes through this interface:

```typescript
interface AgentExecutor {
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}

interface AgentTask {
  id: string;
  type: AgentType;           // planner | coder | reviewer | doc
  prompt: string;            // Assembled from skills + context
  workingDirectory: string;  // Where to find/write code
  budgetSeconds: number;
  environment: Record<string, string>;  // Non-secret env vars ONLY
  skillFiles: string[];      // Paths to relevant skill markdown
}

interface AgentResult {
  status: TaskStatus;        // DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT | FAILED | TIMEOUT
  artifacts: string[];       // Paths to output files
  concerns?: string;
  blockReason?: string;
  metrics: {
    elapsedSeconds: number;
    tokenInput?: number;
    tokenOutput?: number;
    estimatedCost?: number;
  };
}
```

**Adapter implementations (pluggable via config):**

```typescript
class ClaudeCodeExecutor implements AgentExecutor {
  // Spawns `claude --print --dangerously-skip-permissions <prompt>` as subprocess
  // prompt is passed as a positional CLI argument (avoids stdin complexity)
  // --dangerously-skip-permissions required so agent can write files non-interactively
  // After process exits, reads .autoforge-status.json from workingDirectory for status + artifacts
  // Budget enforced: SIGTERM at deadline, SIGKILL after 10-second grace period
  // If agent exits 0 but did not write the status file → DONE_WITH_CONCERNS
}

class CodexExecutor implements AgentExecutor {
  // Calls OpenAI Codex agent API
  // Translates skill markdown to AGENTS.md format
  // Maps context envelope to Codex session format
}

class ManagedAgentsExecutor implements AgentExecutor {
  // Calls Claude Managed Agents API
  // Creates session with system prompt + tools
  // Polls or subscribes for completion
  // Pulls artifacts from session sandbox
}

class LocalModelExecutor implements AgentExecutor {
  // For future: local models via Ollama/vLLM
  // Same interface, API-based backend
}
```

**Configuration per project or per agent type:**

```yaml
# autoforge-projects/my-project.yaml
executors:
  default: claude-code
  overrides:
    planner: claude-code     # Planning benefits from strongest model
    coder: claude-code       # Or codex, configurable
    reviewer: claude-code    # Could use different provider for diversity
    doc: claude-code
```

The meta-loop can even experiment with executor selection — running the same task through different providers and comparing outcomes.

### Secrets Architecture

Agents are sandboxed and never hold credentials. The orchestrator owns all secrets and performs privileged operations on behalf of agents.

```
ORCHESTRATOR (trusted, holds secrets):
  ├── Git push / PR creation (uses git credentials)
  ├── Authenticated test runner (uses project DB creds, API keys)
  ├── NATS publishing (uses NATS credentials)
  └── QMD queries (uses QMD endpoint)

AGENT RUNTIMES (untrusted, no secrets):
  ├── Read code from worktree (mounted read-write for agent's scope)
  ├── Write code to worktree
  ├── Run local tests (no external dependencies)
  ├── Read skill files (mounted read-only)
  └── Report status via convention file or stdout
```

**Flow for operations requiring secrets:**
1. Agent writes code and tests to worktree
2. Agent reports DONE via status convention
3. Orchestrator picks up artifacts from worktree
4. Orchestrator runs authenticated test suite (separate process with secrets)
5. Orchestrator commits and pushes to git (using git credentials)
6. Orchestrator creates PR via GitHub API (using GitHub token)

If an agent is compromised via prompt injection, it cannot exfiltrate secrets because they are not in its environment.

---

## 4. NATS SUBJECT HIERARCHY & MESSAGE CONTRACTS

> **Implementation note:** NATS is optional in local development. The orchestrator connects with a 3-second timeout; if NATS is unavailable it logs a warning and runs in SQLite-only mode. All event publishing is fire-and-forget — a NATS failure never blocks the pipeline. Set `NATS_URL` in `.env` to enable (defaults to `nats://127.0.0.1:4222`).

### Subject Hierarchy

```
autoforge.task.{project}.{task_id}.{event}
  .created          - New task entered the pipeline
  .assessed         - Complexity assessment complete
  .planned          - Plan created
  .subtask.{sub_id} - Subtask lifecycle
    .dispatched     - Sent to agent
    .progress       - Heartbeat / progress update
    .completed      - Agent finished (with status)
    .failed         - Agent failed or timed out
  .reviewed         - Review complete
  .pr.created       - PR opened
  .pr.approved      - Human approved
  .pr.merged        - PR merged
  .pr.rejected      - PR rejected, rework needed
  .documented       - Docs generated and indexed
  .completed        - Full pipeline complete

autoforge.meta.{event}
  .experiment.proposed   - Hypothesis generated
  .experiment.running    - Experiment in progress
  .experiment.completed  - Results available
  .experiment.approved   - Human approved keep/discard
  .skill.updated         - Skill file changed
  .calibration           - Routing calibration data

autoforge.system.{event}
  .heartbeat       - Orchestrator health
  .error           - System-level errors
  .cost            - Token/cost tracking events
```

### Message Envelope

Every NATS message uses this envelope:

```typescript
interface AutoforgeMessage<T = unknown> {
  id: string;              // UUID v4
  taskId: string;          // Feature/task identifier
  projectId: string;       // Which project this belongs to
  timestamp: string;       // ISO-8601
  agent: AgentType;        // planner | coder | reviewer | doc | pr | orchestrator
  type: string;            // Event type matching subject suffix
  status: TaskStatus;      // pending | in_progress | done | done_with_concerns | blocked | needs_context | failed | timeout
  payload: T;              // Type-specific payload
  budgetSeconds: number;   // Allocated budget
  elapsedSeconds?: number; // Actual time taken
  tokenUsage?: {           // Cost tracking
    input: number;
    output: number;
    estimatedCost: number;
  };
}

type AgentType = 'planner' | 'coder' | 'reviewer' | 'doc' | 'pr' | 'orchestrator' | 'meta';
type TaskStatus = 'pending' | 'in_progress' | 'done' | 'done_with_concerns' | 'blocked' | 'needs_context' | 'failed' | 'timeout';
```

### JetStream Streams

```
TASKS stream:
  subjects: autoforge.task.>
  retention: limits (keep last 1000 per subject)
  storage: file
  purpose: All task lifecycle events. Must survive restarts.

META stream:
  subjects: autoforge.meta.>
  retention: limits (keep all)
  storage: file
  purpose: Meta-loop experiments. Permanent record.

SYSTEM stream:
  subjects: autoforge.system.>
  retention: limits (keep last 100 per subject)
  storage: memory
  purpose: Heartbeats, errors. Ephemeral.
```

---

## 5. TASK LIFECYCLE (Inner Loop)

### State Machine

```
                    ┌──────────────┐
                    │   RECEIVED   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  ASSESSING   │  ← Complexity assessment
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   PLANNING   │  ← Planner agent: KB query + spec + plan
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
              ┌────►│  EXECUTING   │  ← Coder agent(s): TDD per subtask
              │     └──────┬───────┘
              │            │
              │     ┌──────▼───────┐
              │     │  REVIEWING   │  ← Reviewer agent: spec compliance + quality
              │     └──────┬───────┘
              │            │
              │            ├─── CRITICAL/MAJOR findings
              │            │
              │     ┌──────▼───────┐
              └─────│  REWORKING   │  ← Coder agent: fix findings
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  PR_CREATED  │  ← PR agent: threshold checks
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   AWAITING   │  ← Human reviews PR
                    │   APPROVAL   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  DOCUMENTING │  ← Doc agent: generate + index
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  COMPLETED   │  ← Metrics recorded
                    └──────────────┘

    At any point: BLOCKED → escalate to human
                  TIMEOUT → log + retry or escalate
                  FAILED  → log + retry or escalate
```

### Rework Cycle

When a PR is rejected (by automated checks or human review):
1. State returns to REWORKING
2. Rework context includes: original spec, review findings, previous implementation, rejection reason
3. The state machine tracks iteration count
4. After 3 rework cycles without approval, escalate to human with full history
5. Each rework attempt learns from prior failures (sequential accumulation)

### Step Details

**STEP 0: COMPLEXITY ASSESSMENT** (Orchestrator)
- Input: Feature request text
- Action: Query QMD for similar past tasks. Classify signals: scope, novelty, risk, coupling.
- Output: Tier assignment (EXPRESS / STANDARD / THOROUGH) + rationale
- Budget: 1 minute

**STEP 1: PLANNING** (Planner Agent — Claude Code)
- Input: Feature request + tier + QMD context bundle
- Skills loaded: Superpowers brainstorming, writing-plans
- Action (varies by tier):
  - EXPRESS: Minimal plan, 1-3 subtasks, no brainstorming
  - STANDARD: Spec + plan, 3-8 subtasks, single refinement pass
  - THOROUGH: Full brainstorming with alternatives, iterative refinement (up to 3 rounds), detailed plan with dependency graph, 5-15 subtasks
- Output: spec.md + plan.md with subtask definitions
- Each subtask declares: files in scope, expected behavior, test criteria, dependencies
- Budget: 3 min (EXPRESS) / 8 min (STANDARD) / 15 min (THOROUGH)

**STEP 2: EXECUTION** (Coder Agent(s) — Claude Code)
- Input: plan.md (current subtask) + relevant context from prior subtasks
- Skills loaded: Superpowers TDD, systematic-debugging, verification-before-completion
- Action per subtask:
  1. RED: Write failing tests
  2. GREEN: Minimal code to pass
  3. REFACTOR: Clean up
  4. Verify: Re-read spec criteria, confirm coverage
- Status reporting via `.autoforge-status.json` written by the agent before exit:
  ```json
  {
    "status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
    "artifacts": ["relative/path/to/changed/file"],
    "concerns": "(if DONE_WITH_CONCERNS)",
    "blockReason": "(if BLOCKED or NEEDS_CONTEXT)"
  }
  ```
- On test failure: Invoke systematic-debugging skill (reproduce → isolate → root cause → fix)
- Sequential by default. Orchestrator may parallelize independent subtasks if configured.
- Budget: 5 min per subtask (EXPRESS) / 8 min (STANDARD) / 12 min (THOROUGH)

**STEP 3: REVIEW** (Reviewer Agent — Claude Code)
- Input: spec.md + plan.md + all code + all tests
- Skills loaded: Superpowers two-stage review, gstack-style role perspectives
- Action (varies by tier):
  - EXPRESS: Self-review only (done by Coder agent, no separate Reviewer)
  - STANDARD: Single-stage code quality review
  - THOROUGH: Two-stage review:
    - Stage 1 (Spec Compliance): Does implementation match spec? All criteria met? Edge cases?
    - Stage 2 (Code Quality): Correctness, readability, performance, security, simplicity
  - gstack perspectives (THOROUGH only): Security reviewer lens, performance reviewer lens
- Findings: CRITICAL (blocks merge) / MAJOR (must fix) / MINOR (log) / NITPICK (ignore)
- Budget: 3 min (STANDARD) / 8 min (THOROUGH)

**STEP 4: REWORK** (Coder Agent — Claude Code, if needed)
- Input: review.md (CRITICAL + MAJOR findings) + original code
- Skills loaded: receiving-code-review
- Action: Fix exactly the findings, nothing else. Diff must touch only related code.
- Re-run all tests after fixes
- Budget: 5 min per rework cycle

**STEP 5: PR CREATION** (PR Agent — TypeScript, not Claude Code)
- Input: All artifacts (spec, plan, tests, code, review)
- Action: Programmatic threshold checks:
  - test_pass_rate >= 100% (hard gate)
  - code_review_score >= configurable threshold (default 0.7)
  - no unresolved CRITICAL findings
  - documentation exists for public APIs (THOROUGH tier)
- Create git branch, commit, push, open PR with structured description
- If thresholds not met: reject, state → REWORKING
- Budget: 1 min (automated, no LLM needed)

**STEP 6: HUMAN APPROVAL** (Dashboard)
- PR appears in the web UI approval queue
- Human reviews: approve, request changes, or reject
- On approve: state → DOCUMENTING
- On request changes: state → REWORKING with human feedback
- On reject: task marked as failed, logged for meta-loop analysis

**STEP 7: DOCUMENTATION** (Doc Agent — Claude Code)
- Input: spec.md + code + review.md
- Skills loaded: documentation generation
- Action: Generate feature docs in markdown, add to project's docs/ directory
- Run `qmd embed` to index new docs (blocking — wait for completion)
- Include: what was built, why, key decisions, gotchas, related docs
- Budget: 3 min (EXPRESS) / 5 min (STANDARD/THOROUGH)

**STEP 8: METRICS COLLECTION** (Orchestrator — automated)
- Record to SQLite:
  - task_duration_seconds (per step and total)
  - test_pass_rate
  - code_review_score + finding counts by severity
  - pr_outcome (merged / rejected / rework_count)
  - lines_of_code_added / removed
  - token_usage + estimated_cost
  - subtask status distribution (DONE vs DONE_WITH_CONCERNS vs BLOCKED vs NEEDS_CONTEXT)
  - tier_assigned vs tier_that_would_have_been_appropriate (for routing calibration)
- Append to results.tsv (human-scannable)
- Publish to autoforge.task.{project}.{task_id}.completed

---

## 6. COMPLEXITY ASSESSMENT & TIER ROUTING

### Signal Dimensions

```typescript
interface ComplexityAssessment {
  scope: 'small' | 'medium' | 'large';    // Files affected
  novelty: 'low' | 'medium' | 'high';     // Familiarity from KB
  risk: 'low' | 'medium' | 'high';        // Security, data, critical path
  coupling: 'low' | 'medium' | 'high';    // Dependencies on other work
  rationale: string;                        // Why this classification
  similarPastTasks: string[];               // QMD matches for calibration
}
```

### Tier Routing Rules (Deterministic, Not LLM Judgment)

```
EXPRESS:  ALL signals are low/small
          → Single coder, self-review, auto-PR, minimal docs
          → Budget: 15 min total

STANDARD: ANY signal is medium, NONE high/large
          → Planner + coder(s) + single-stage review + PR + docs
          → Budget: 45 min total

THOROUGH: ANY signal is high/large
          → Full brainstorm + planner + coder(s) + two-stage review
            + PR + full docs + post-merge verification
          → Budget: 90 min total (flexible)
```

The classification is done by a Claude Code agent with a structured output schema. But the routing decision (which tier, given the classification) is deterministic TypeScript code. The LLM assesses complexity; the code routes.

### Routing Calibration (Meta-Loop)

After each task completes, the orchestrator records:
- Tier assigned vs. what would have been appropriate (hindsight)
- Under-tiering signals: rework cycles, BLOCKED status, budget overruns
- Over-tiering signals: zero review findings, completed well under budget

The meta-loop can adjust the classification prompt and the signal thresholds over time.

---

## 7. THE META-LOOP (Outer Loop)

Runs on a configurable cadence: every N completed features, or on human trigger.

### Meta-Loop Steps

```
1. ANALYZE METRICS
   Query SQLite for trends:
   - Which pipeline steps are bottlenecks? (duration trends)
   - Which review finding types recur? (clustering)
   - Are rework rates trending up or down?
   - What's the defect escape rate? (bugs found post-merge)
   - Token cost per task by tier
   - Status distribution (too many BLOCKED = planning problem)

2. QUERY KNOWLEDGE BASE
   QMD queries across collections:
   - "recurring code review findings" → reviews/ + insights/
   - "tasks that required most rework" → incidents/
   - "planning gaps identified in reviews" → reviews/ + specs/
   Surface cross-cutting patterns that individual agents wouldn't see.

3. GENERATE HYPOTHESIS
   A Claude Code agent (with meta-analysis skills) produces:
   {
     hypothesis: string,       // What we think will improve
     skillToModify: string,    // Which skill file
     agentAffected: string,    // Which agent type
     expectedImpact: string,   // What metric should change
     experiment: string,       // Concrete change to make
   }

   Examples:
   - "Reviews show recurring null-check issues → add pre-implementation
      checklist to Coder agent's TDD skill"
   - "API tasks take 2x longer → create specialized API planning template"
   - "Async test quality is low → add async testing examples to Coder context"

4. HUMAN APPROVAL OF EXPERIMENT
   Hypothesis appears in dashboard. Human approves or rejects.
   Human can modify the hypothesis before approving.

5. EXECUTE EXPERIMENT
   - Branch the skill file being modified (git tag: skill-v{N})
   - Apply the change
   - Run N tasks through the pipeline with modified skill
   - Compare against baseline (historical data for similar task types)
   - Measure primary metric for the affected agent

6. KEEP OR DISCARD (with human sign-off)
   - Results presented in dashboard
   - If metric improved AND human approves: merge skill change, tag new version
   - If equal or worse: revert to previous skill version
   - If improved but adds complexity: apply simplicity criterion (human judgment)
   - Log to meta_results.tsv:
     experiment_id | skill | metric_before | metric_after | status | description

7. UPDATE KNOWLEDGE BASE
   - If kept: write insight doc explaining what changed and why
   - Index into QMD insights/ collection
   - Skill file version history updated

8. REPEAT
```

### Skill File Format

```markdown
# skill: {name}

## Version
v{N}.{M} — {date}

## When to Activate
{trigger conditions — checked by the 1% rule}

## Instructions
{what the agent should do when this skill activates}

## Examples
{concrete examples of good and bad outcomes}

## Anti-Patterns
{what NOT to do — anti-rationalization patterns}

## Metrics
{how to measure if this skill is working}

## Version History
- v1.0: Initial version
- v1.1: Added null-check reminder (experiment #47, +3% test_pass_rate)
- v1.2: Removed redundant step (experiment #52, no metric change, simpler)
```

### Skill Registry & Mandatory Activation

Each agent session starts by loading its skill registry:

```typescript
interface SkillRegistry {
  loadSkillsForAgent(agentType: AgentType, taskContext: TaskContext): Skill[];
}

// The registry queries QMD skills/ collection
// Returns all skills where trigger conditions match the task context
// 1% rule: if there's any plausible match, include it
// Skills are injected into the Claude Code agent's prompt
```

### Constraints & Objectives (Multi-Objective Handling)

```typescript
// The meta-loop optimizes objectives while respecting constraints

interface MetaLoopEvaluation {
  objectives: {
    // These get optimized (higher is better unless noted)
    planQualityScore: number;
    testPassRate: number;
    defectDetectionRate: number;
    pipelineDuration: number;  // lower is better
  };
  constraints: {
    // These must not regress by more than the threshold
    taskDuration: { value: number; maxRegression: 0.05 };
    falsePositiveRate: { value: number; maxRegression: 0.05 };
    tokenCost: { value: number; maxRegression: 0.10 };
    docsRetrievalRelevance: { value: number; maxRegression: 0.05 };
  };
}

// An experiment is kept only if:
// 1. At least one objective improved
// 2. No constraint violated
// 3. Human approved
```

---

## 8. ORCHESTRATOR DESIGN

The Orchestrator is the BRAIN of the system. It is a **stateless event processor** that:

1. Subscribes to NATS subjects (or is woken by Event Bridge on cloud)
2. Recovers full state from the event log on startup
3. Maintains a materialized view of current state in SQLite
4. Dispatches agent tasks via the AgentExecutor interface
5. Constructs context envelopes for each agent (context isolation)
6. Enforces budgets (kills processes that exceed time limits)
7. Performs privileged operations (git push, PR creation, authenticated tests)
8. Exposes an API for the web UI

### Stateless Recovery (Event Sourcing)

The orchestrator can crash at any time and fully recover.

**Source of truth hierarchy (as implemented):**
- **SQLite** is the primary source of truth. Every event is written to SQLite atomically before anything else happens.
- **NATS JetStream** is a secondary durable log. The orchestrator fire-and-forgets a JetStream publish after every SQLite write. NATS is optional — if unavailable, the system runs in SQLite-only mode with a startup warning.
- On recovery, JetStream replay is attempted first. If NATS is unavailable or the stream is empty, SQLite event replay is used.

**Implementation notes:**
- Use `consumer.fetch()` (not `consume()`) for JetStream replay. `consume()` blocks indefinitely on an empty stream. Always pre-check `stream.state.messages > 0` before fetching to avoid startup hangs.
- NATS connection uses a 3-second timeout. Failure is non-fatal; the system continues in SQLite-only mode.

```typescript
async function recoverState(): Promise<void> {
  // 1. Try JetStream replay first (if NATS available and stream non-empty)
  if (nats.isConnected) {
    const info = await jsm.streams.info('TASKS');
    if (info.state.messages > 0) {
      const consumer = await js.consumers.get('TASKS');
      const messages = await consumer.fetch({ max_messages: info.state.messages, expires: 5_000 });
      for await (const msg of messages) {
        await applyEventToDatabase(JSON.parse(msg.data));
        msg.ack();
      }
      return;
    }
  }

  // 2. Fall back to SQLite event log replay
  db.rebuildProjectionsFromEvents();

  // 3. Check for in-flight tasks that timed out while orchestrator was down
  const stuckTasks = await db.query(
    `SELECT * FROM subtasks WHERE state = 'in_progress' 
     AND started_at < datetime('now', '-' || budget_seconds || ' seconds')`
  );
  for (const task of stuckTasks) {
    await markAsTimeout(task);
  }
}
```

### Event Log Design

Every state transition is recorded as an event with enough context to resume:

```typescript
interface TaskEvent {
  id: string;                 // UUID
  taskId: string;
  subtaskId?: string;
  timestamp: string;          // ISO-8601
  eventType: string;          // created | assessed | planned | dispatched | completed | ...
  
  // Full state snapshot at this point
  stateAfter: TaskState;
  
  // What was produced (if anything)
  artifactPaths?: string[];
  
  // Recovery metadata
  resumable: boolean;         // Can we pick up from here?
  contextEnvelopeHash?: string; // Hash of context sent to agent
  executorUsed?: string;      // Which AgentExecutor adapter was used
  
  // Cost tracking
  tokenInput?: number;
  tokenOutput?: number;
  estimatedCost?: number;
  elapsedSeconds?: number;
}
```

### Agent Dispatch (via AgentExecutor)

```typescript
async function dispatchAgent(subtask: Subtask, task: Task): Promise<void> {
  // 1. Construct context envelope (context isolation)
  const envelope = await buildContextEnvelope(subtask, task);
  
  // 2. Get the configured executor for this agent type + project
  const executor = getExecutor(subtask.agentType, task.projectId);
  
  // 3. Build the agent task
  const agentTask: AgentTask = {
    id: subtask.id,
    type: subtask.agentType,
    prompt: assemblePrompt(envelope),  // Skills + context + constraints
    workingDirectory: subtask.worktreePath,
    budgetSeconds: subtask.budgetSeconds,
    environment: getNonSecretEnv(task.projectId),  // NO secrets
    skillFiles: envelope.skills,
  };
  
  // 4. Publish dispatch event
  await publishEvent({
    taskId: task.id,
    subtaskId: subtask.id,
    eventType: 'dispatched',
    stateAfter: 'in_progress',
    resumable: true,
    executorUsed: executor.name,
    contextEnvelopeHash: hash(envelope),
  });
  
  // 5. Execute (with budget timeout)
  const result = await withTimeout(
    executor.execute(agentTask),
    subtask.budgetSeconds * 1000
  );
  
  // 6. Run privileged operations if needed
  if (result.status === 'done' || result.status === 'done_with_concerns') {
    // Run authenticated tests (orchestrator holds secrets)
    const testResult = await runAuthenticatedTests(subtask.worktreePath, task.projectId);
    
    // Commit to git (orchestrator holds git credentials)
    await gitCommit(subtask.worktreePath, subtask.description);
  }
  
  // 7. Publish completion event
  await publishEvent({
    taskId: task.id,
    subtaskId: subtask.id,
    eventType: 'completed',
    stateAfter: result.status,
    artifactPaths: result.artifacts,
    tokenInput: result.metrics.tokenInput,
    tokenOutput: result.metrics.tokenOutput,
    estimatedCost: result.metrics.estimatedCost,
    elapsedSeconds: result.metrics.elapsedSeconds,
  });
}
```

### Context Envelope Construction (Context Isolation)

```typescript
interface ContextEnvelope {
  task: {
    id: string;
    description: string;
    subtaskIndex: number;
    filesInScope: string[];
    testCriteria: string[];
    dependencies: string[];    // IDs of prerequisite subtasks
  };
  skills: string[];            // Loaded skill file contents
  context: {
    spec: string;              // From planner output
    plan: string;              // Relevant portion of plan
    priorSubtaskOutputs: string[];  // Results from dependency subtasks
    qmdInsights: string[];     // Relevant KB entries
    reviewFindings?: string;   // If this is a rework cycle
  };
  constraints: {
    budgetSeconds: number;
    statusProtocol: string;    // Instructions for reporting status
    scopeEnforcement: string;  // "Only modify files listed in filesInScope"
  };
}
```

### State Machine (Event-Sourced, NATS-Triggered)

```typescript
// NATS event arrives → record event → update materialized state → determine next action → dispatch

async function handleEvent(msg: AutoforgeMessage) {
  await db.transaction(async (tx) => {
    // 1. Record the event (append-only, never modified)
    await tx.insertEvent(msg);

    // 2. Update materialized view (database is a projection of the event log)
    const task = await tx.getTask(msg.taskId);
    const newState = stateMachine.transition(task.state, msg);
    await tx.updateTaskState(msg.taskId, newState);

    // 3. Determine next action
    const action = stateMachine.nextAction(newState, task);

    // 4. Dispatch if needed
    if (action.type === 'dispatch_agent') {
      const envelope = await buildContextEnvelope(task, action);
      const executor = getExecutor(action.agentType, task.projectId);
      await dispatchAgent(executor, envelope);
    } else if (action.type === 'await_human') {
      await notifyDashboard(task);
    } else if (action.type === 'run_privileged') {
      // Git push, PR creation, authenticated tests
      await runPrivilegedOperation(action, task);
    } else if (action.type === 'complete') {
      await recordFinalMetrics(task);
    }
  });
}
```

**Recovery guarantee:** If the orchestrator crashes between recording the event and dispatching the action, on restart it replays the event log, sees the recorded event, and re-derives the action. Idempotent dispatching (checking if a subtask is already in_progress before re-dispatching) prevents duplicate work.

---

## 9. DATABASE SCHEMA

```sql
-- Project configuration
CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    repo_url        TEXT NOT NULL,
    docs_path       TEXT DEFAULT 'docs/',
    conventions     TEXT,           -- JSON: language, test framework, etc.
    default_tier    TEXT DEFAULT 'STANDARD',
    human_approval  TEXT DEFAULT 'required',  -- required | tier_based | monitor
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Feature tasks (top-level)
CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    description     TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'received',
    tier            TEXT,            -- EXPRESS | STANDARD | THOROUGH
    assessment      TEXT,            -- JSON: ComplexityAssessment
    spec            TEXT,            -- Planner output
    plan            TEXT,            -- JSON: subtask definitions
    iteration       INTEGER DEFAULT 0,  -- Rework cycle count
    pr_url          TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP,
    total_cost      REAL DEFAULT 0
);

-- Subtasks within a task
CREATE TABLE subtasks (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    sequence        INTEGER NOT NULL,  -- Execution order
    description     TEXT NOT NULL,
    files_in_scope  TEXT,            -- JSON array
    dependencies    TEXT,            -- JSON array of subtask IDs
    state           TEXT DEFAULT 'pending',
    status          TEXT,            -- DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
    concerns        TEXT,            -- If DONE_WITH_CONCERNS, what concerns
    agent_type      TEXT,
    started_at      TIMESTAMP,
    completed_at    TIMESTAMP,
    budget_seconds  INTEGER,
    elapsed_seconds REAL,
    token_input     INTEGER,
    token_output    INTEGER,
    estimated_cost  REAL
);

-- Events log (append-only)
CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    subtask_id      TEXT,
    timestamp       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    agent           TEXT,
    event_type      TEXT NOT NULL,
    status          TEXT,
    payload         TEXT,            -- JSON
    token_input     INTEGER,
    token_output    INTEGER
);

-- Review findings
CREATE TABLE review_findings (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    severity        TEXT NOT NULL,    -- CRITICAL | MAJOR | MINOR | NITPICK
    category        TEXT,            -- null_check | error_handling | security | etc.
    description     TEXT NOT NULL,
    file_path       TEXT,
    resolved        BOOLEAN DEFAULT FALSE,
    resolved_in_iteration INTEGER
);

-- Meta-loop experiments
CREATE TABLE experiments (
    id              TEXT PRIMARY KEY,
    hypothesis      TEXT NOT NULL,
    skill_modified  TEXT,
    agent_affected  TEXT,
    change_description TEXT NOT NULL,
    metric_name     TEXT NOT NULL,
    metric_before   REAL NOT NULL,
    metric_after    REAL,
    constraint_violations TEXT,      -- JSON: any constraints violated
    status          TEXT DEFAULT 'proposed',  -- proposed | approved | running | keep | discard | rejected
    human_notes     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP
);

-- Skill versions
CREATE TABLE skill_versions (
    id              TEXT PRIMARY KEY,
    skill_name      TEXT NOT NULL,
    version         TEXT NOT NULL,
    content         TEXT NOT NULL,    -- Full skill markdown
    experiment_id   TEXT REFERENCES experiments(id),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active       BOOLEAN DEFAULT FALSE
);

-- Routing calibration
CREATE TABLE routing_calibration (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    tier_assigned   TEXT NOT NULL,
    tier_appropriate TEXT,            -- Hindsight assessment
    under_tiered    BOOLEAN,
    over_tiered     BOOLEAN,
    signals         TEXT,            -- JSON: what signals were wrong
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 10. QMD INTEGRATION

### Setup

QMD runs as a Docker Compose service, serving its MCP endpoint. It indexes markdown files in the project's docs/ directory and AUTOFORGE's own skills/ and insights/ directories.

```yaml
# docker-compose.yml (QMD service excerpt)
qmd:
  image: qmd:latest
  volumes:
    - ./docs:/data/docs
    - ./skills:/data/skills
  ports:
    - "3100:3100"  # MCP endpoint
  command: qmd serve --port 3100
```

### Collections

```
Per project:
  {project}/specs/      - Feature specifications
  {project}/plans/      - Implementation plans
  {project}/reviews/    - Code review findings and patterns
  {project}/docs/       - Project documentation

Shared across projects:
  autoforge/skills/     - Skill file library
  autoforge/insights/   - Meta-loop discoveries
  autoforge/incidents/  - Post-mortems from failures
  autoforge/metrics/    - Periodic metric reports
```

### Agent Queries

Claude Code agents use QMD's MCP server directly during execution. The orchestrator includes the QMD MCP endpoint in the agent's environment, and skills instruct agents how to query it.

```
# Example: Planner agent querying for context
qmd query "rate limiting patterns in microservices" -c {project}/specs -c autoforge/insights
qmd query "past failures related to authentication" -c {project}/reviews -c autoforge/incidents
```

### Indexing Lifecycle

1. Doc agent generates markdown → writes to project docs/
2. Doc agent runs `qmd embed` (blocking) → docs indexed
3. Doc agent publishes NATS completion event
4. Next task's planning step can now find these docs via QMD

---

## 11. WEB UI DASHBOARD

### Views

**Task Queue** — List of active/pending/completed tasks with status, tier, current stage, duration, cost. Filterable by project.

**Task Detail** — Full pipeline visualization for a single task. Shows each step, its status, agent output summary, review findings, and rework history.

**Approval Queue** — PRs awaiting human review. Shows: diff summary, test results, review findings, link to actual PR. Approve/request changes/reject buttons.

**Meta-Loop** — Experiment history. Proposed hypotheses awaiting approval. Running experiments with progress. Completed experiments with before/after metrics. Skill version timeline.

**Metrics Dashboard** — Trends over time: task completion rate, average duration by tier, review finding distribution, rework rate, cost per task, skill improvement trajectory.

**Project Config** — Manage project configurations. Onboard new projects (provide repo URL, docs path, conventions).

### API (Hono)

```typescript
// Task management
POST   /api/tasks                    // Submit new feature request
GET    /api/tasks                    // List tasks (filterable)
GET    /api/tasks/:id                // Task detail with full history
POST   /api/tasks/:id/approve        // Approve PR
POST   /api/tasks/:id/reject         // Reject PR with feedback
POST   /api/tasks/:id/request-changes // Request changes with notes

// Meta-loop
GET    /api/experiments              // List experiments
POST   /api/experiments/:id/approve  // Approve experiment
POST   /api/experiments/:id/reject   // Reject experiment

// Projects
POST   /api/projects                 // Onboard new project
GET    /api/projects                 // List projects
PUT    /api/projects/:id             // Update project config

// Metrics
GET    /api/metrics/:projectId       // Aggregated metrics
GET    /api/metrics/:projectId/trends // Time-series data

// Real-time (WebSocket or SSE)
WS     /api/ws                       // Live task status updates
```

---

## 12. SECRETS & CONFIGURATION

### Secrets Architecture (Secrets Never Reach the Sandbox)

Agent runtimes are untrusted environments. They never hold credentials.

```bash
# .env (gitignored, loaded by orchestrator only)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...          # For Codex executor, when configured
NATS_URL=nats://localhost:4222
QMD_MCP_URL=http://localhost:3100
DATABASE_PATH=/data/db/autoforge.sqlite
GITHUB_TOKEN=ghp_...           # For PR creation (orchestrator only)
GIT_AUTHOR_NAME=autoforge
GIT_AUTHOR_EMAIL=autoforge@localhost

# Per-project secrets (loaded by orchestrator for privileged operations)
# .env.my-v2-project
PROJECT_DATABASE_URL=postgres://...
PROJECT_API_KEY=...
```

**What the orchestrator does with secrets:**
- Passes ANTHROPIC_API_KEY to Claude Code subprocess (required for LLM calls)
- Uses GITHUB_TOKEN to create PRs after agent produces artifacts
- Uses project secrets to run authenticated test suites
- Never forwards project secrets to agent environments

**What agents receive:**
- Working directory path
- Non-secret environment variables (project name, task ID, conventions)
- Skill files (read-only mount)
- The prompt (assembled by orchestrator)

### Cloud Secrets Management

On AWS, secrets move to Secrets Manager:
- Orchestrator retrieves secrets at startup via IAM role
- Agent Fargate tasks receive only the LLM API key (needed for the agent runtime to call the model)
- Git and project secrets stay in the orchestrator's task definition only
- Secret rotation doesn't require container restarts (orchestrator re-fetches on each use)

### Security Rules

1. Agent environments never hold git credentials, GitHub tokens, or project API keys
2. The orchestrator sanitizes agent output, stripping patterns matching secrets
3. LLM API keys are the one exception — agents need them to call the model
4. The web UI never displays secret values
5. Event log entries never contain secret values (sanitized before recording)

---

## 13. GIT WORKFLOW

### Per-Task Branching

```
main
├── autoforge/{task-id}              # Task branch
│   ├── (worktree for planner)       # Read-only main + write to branch
│   ├── (worktree for coder-sub-1)   # Scoped to declared files
│   ├── (worktree for coder-sub-2)   # Parallel if independent
│   └── (worktree for reviewer)      # Read-only view of branch
```

### Worktree Lifecycle

1. Orchestrator creates branch: `git branch autoforge/{task-id}`
2. Per subtask: `git worktree add /tmp/worktree-{subtask-id} autoforge/{task-id}`
3. Agent works in worktree, commits to branch
4. After all subtasks: orchestrator squashes or keeps commits (configurable)
5. PR created from branch
6. After merge: `git worktree remove`, `git branch -d`

### Conflict Handling

If parallel agents modify overlapping files (shouldn't happen if scope declarations are correct):
1. Second agent's commit will fail to push
2. Orchestrator detects conflict
3. Falls back to sequential execution for conflicting subtasks
4. Logs a routing calibration signal (scope declarations were wrong)

---

## 14. INVARIANTS (Never Violate)

These are structural constraints that no agent, no meta-loop experiment, and no configuration change can override.

```
1. Tests before code. Always. RED → GREEN → REFACTOR.

2. Every event is logged. Even crashes. Even timeouts. Even reverts.
   The events table is append-only. The event log is the system's
   memory — without it, recovery is impossible.

3. The knowledge base is append-mostly. Deletions require human approval.

4. No agent modifies another agent's artifacts directly.
   Communication is via NATS messages only. Artifacts are passed
   through the orchestrator's context envelope construction.

5. Budgets are hard limits. An agent process that exceeds its
   budget is killed (SIGTERM, then SIGKILL) and the subtask is
   marked as timeout.

6. The meta-loop cannot modify:
   - The invariants themselves
   - The test requirement
   - The review step (can modify HOW review works, not WHETHER)
   - The metrics collection system
   - Its own keep/discard logic
   - The human approval requirement

7. Every merged PR includes documentation. No docs = no merge.

8. Simplicity wins ties. Equal metrics → simpler approach kept.

9. One variable at a time. Meta-loop experiments modify exactly
   one skill or one prompt. Never bundle changes.

10. Human approval is required for:
    - All PRs (initially; relaxable per project config)
    - All meta-loop experiments that are proposed to be kept
    - Any change to invariants (which should be extremely rare)

11. Secrets never reach agent sandboxes. Git operations, PR creation,
    and authenticated test runs happen in the orchestrator. The only
    secret an agent receives is the LLM API key (required for the
    agent runtime to call the model).

12. The orchestrator is stateless and recoverable. It can crash at
    any point and fully recover from the NATS event log. All state
    transitions are recorded as events before actions are taken.

13. The AgentExecutor interface is the only way to dispatch work
    to agents. No direct LLM API calls from the orchestrator.
    Provider selection is a configuration choice.

14. Pipeline stages are bypassable. Every stage must earn its place
    through measured improvement. The meta-loop can experiment with
    removing stages, not just improving them.
```

---

## 15. IMPLEMENTATION PHASES

### Phase 1: Foundation (Get One Thing Working End-to-End)

**Goal:** A feature request goes in, a PR comes out, with human approval.

```
□ Project scaffolding
  - Bun project with TypeScript
  - Directory structure:
    autoforge/
    ├── src/
    │   ├── orchestrator/       # Core state machine + event processing
    │   ├── executors/          # AgentExecutor interface + adapters
    │   │   ├── interface.ts    # AgentExecutor, AgentTask, AgentResult
    │   │   ├── claude-code.ts  # ClaudeCodeExecutor (default)
    │   │   ├── codex.ts        # CodexExecutor (future)
    │   │   └── factory.ts      # Executor factory from config
    │   ├── events/             # Event sourcing + recovery
    │   ├── assessment/         # Complexity classification
    │   ├── db/                 # SQLite schema + materialized views
    │   ├── nats/               # NATS connection + message types
    │   ├── skills/             # Skill registry + loading
    │   ├── git/                # Worktree + branch management
    │   ├── privileged/         # Git push, PR creation, auth'd tests
    │   ├── web/                # Hono API + React dashboard
    │   └── meta/               # Meta-loop (Phase 3)
    ├── skills/                 # Skill markdown files
    ├── docs/                   # QMD-indexed docs
    ├── docker-compose.yml
    ├── CLAUDE.md               # Project conventions for Claude Code
    ├── program.md              # Autoresearch-style program file
    └── results.tsv

□ NATS setup
  - Docker Compose with NATS + JetStream
  - TypeScript NATS client wrapper
  - Message envelope types
  - Stream creation (TASKS, META, SYSTEM)
  - Integration test: publish → receive → verify

□ Event sourcing foundation
  - Event types and recording functions
  - Event replay for state recovery
  - SQLite as materialized view of event log
  - Test: record events → crash → recover → state matches

□ SQLite setup
  - Schema creation (all tables from Section 9)
  - Materialized view update functions (applied from events)
  - Test: event sequence → correct state materialization

□ AgentExecutor interface
  - Define AgentExecutor, AgentTask, AgentResult interfaces
  - Implement ClaudeCodeExecutor (spawns claude CLI)
  - Executor factory: select adapter from config
  - Budget timeout wrapper (kills process on deadline)
  - Test: spawn agent via interface, verify artifacts in worktree

□ Orchestrator skeleton
  - NATS subscription to task events
  - Event-sourced state machine transitions
  - Recovery on startup (replay event log)
  - Single-path: RECEIVED → PLANNING → EXECUTING → COMPLETED
  - No assessment, no review, no PR — just the spine

□ Privileged operations module
  - Git commit (orchestrator holds credentials, not agents)
  - Test runner with project secrets injection
  - PR creation placeholder (manual for now)

□ Minimal Planner agent
  - Receives task description via AgentExecutor interface
  - Produces a simple plan (list of subtasks)
  - No QMD integration yet — just LLM planning

□ Minimal Coder agent
  - Receives subtask from plan via AgentExecutor interface
  - Writes tests + code in worktree
  - Reports DONE status via convention file

□ Git integration
  - Create branch per task
  - Create worktree per subtask
  - Orchestrator commits agent output (agents don't push)
  - Clean up worktrees

□ End-to-end test
  - Submit "add a hello world endpoint" as a feature request
  - Watch it flow through: plan → code → commit
  - Verify event log captures full history
  - Crash orchestrator mid-pipeline → restart → verify recovery
  - Manually verify the output
```

### Phase 2: Quality Pipeline (Make It Correct)

**Goal:** Full pipeline with review, rework, PR thresholds, and human approval.

```
□ Complexity assessment
  - Classification via Claude Code agent (structured output)
  - Deterministic tier routing
  - Test: known tasks classified correctly

□ Reviewer agent
  - Two-stage review (spec compliance + code quality)
  - Structured findings output
  - Severity classification

□ Rework cycle
  - State machine supports REVIEWING → REWORKING → EXECUTING loop
  - Iteration tracking
  - Escalation after 3 cycles

□ PR agent
  - Threshold checks (automated, no LLM)
  - Git push + PR creation (GitHub API or CLI)
  - Structured PR description

□ Doc agent
  - Generate markdown documentation
  - Placeholder for QMD integration

□ Status protocol
  - DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT
  - Orchestrator handles each status appropriately

□ Web UI (minimal)
  - Task list with status
  - Approval queue (approve/reject buttons)
  - Real-time updates via WebSocket

□ Human approval flow
  - PR appears in dashboard
  - Human approves → pipeline continues
  - Human rejects → rework cycle
```

### Phase 3: Knowledge & Skills (Make It Learn)

**Goal:** QMD integration, skill system, and meta-loop foundation.

```
□ QMD integration
  - Docker Compose service for QMD
  - Initial indexing of docs/ and skills/
  - Planner agent queries QMD for context
  - Doc agent indexes new docs after completion

□ Skill registry
  - Load skills from skills/ directory
  - Match skills to agent type + task context
  - 1% rule enforcement
  - Inject matched skills into agent prompts

□ Core skills implemented
  - systematic-debugging
  - verification-before-completion
  - receiving-code-review
  - writing-skills (for meta-loop)

□ Superpowers integration
  - Ensure Superpowers skills available in Claude Code sessions
  - TDD enforcement via skill activation
  - Two-stage review via skill activation

□ Context isolation enforcement
  - Orchestrator constructs context envelopes
  - Agents receive ONLY relevant context
  - Test: agent cannot see parent session history

□ Meta-loop foundation
  - Metrics analysis (query SQLite for patterns)
  - Hypothesis generation (Claude Code agent)
  - Experiment proposal → dashboard for human approval
  - Skill branching (git tag on skill files)
  - Keep/discard logic
  - results.tsv logging
```

### Phase 4: Self-Improvement (Make It Get Better)

**Goal:** The meta-loop runs, skills evolve, routing calibrates.

```
□ Full meta-loop
  - Periodic analysis trigger (every N tasks or manual)
  - Hypothesis generation from patterns
  - Experiment execution (N tasks with modified skill)
  - Statistical comparison against baseline
  - Human approval for kept experiments
  - Automatic rollback for discarded experiments

□ Skill versioning
  - Immutable snapshots per version
  - skill_versions table tracking
  - Revert = activate previous version

□ Routing calibration
  - Post-task hindsight assessment
  - Over-tiering / under-tiering detection
  - Classification prompt improvement experiments

□ Constraint/objective evaluation
  - Multi-objective tracking
  - Constraint violation detection
  - Experiments rejected if constraints violated

□ Diminishing returns detection
  - Track consecutive discarded experiments
  - Strategy shift: combine near-misses, expand search space
  - Human notification when stuck

□ Dashboard enhancements
  - Metrics trends over time
  - Skill evolution timeline
  - Experiment history with before/after
  - Cost tracking and projections
```

### Phase 5: Multi-Project & Maturity

**Goal:** Onboard external projects, harden for continuous operation.

```
□ Project onboarding
  - Project config YAML
  - Repo cloning + QMD indexing
  - Convention detection
  - First task with extra human oversight

□ Dog-fooding
  - Use AUTOFORGE to implement an AUTOFORGE feature
  - Log the experience as first insights/ entry

□ Onboard V2 project
  - Index existing docs
  - Configure project-specific settings
  - Run first feature from roadmap

□ Robustness
  - Graceful handling of Claude Code failures
  - NATS reconnection on disconnect
  - Database backup/recovery
  - Container restart policies

□ Cost optimization
  - Model tier selection by task complexity
  - Token usage dashboards
  - Budget alerts and circuit breakers
```

---

## 16. PROJECT FILES FOR CLAUDE CODE

### CLAUDE.md

```markdown
# AUTOFORGE Development Conventions

## Language & Runtime
- TypeScript with Bun runtime
- Strict TypeScript (no `any` types without justification)
- Use Bun's built-in test runner for unit tests

## Code Style
- Functions over classes where possible
- Explicit error handling (no swallowed errors)
- All database operations in transactions
- All NATS messages use the AutoforgeMessage envelope

## Architecture (Brain / Hands / Session)
- BRAIN: Orchestrator is a stateless event processor. It can crash
  and recover from the NATS event log. No in-memory state that
  isn't derivable from events.
- HANDS: Agent runtimes are dispatched via the AgentExecutor interface.
  Never call a specific LLM provider directly from orchestrator code.
  New providers are added as adapter implementations.
- SESSION: The NATS JetStream event log is the source of truth.
  SQLite is a materialized view for fast queries. Events are recorded
  BEFORE actions are taken (write-ahead pattern).
- SECRETS: Agent environments never hold git credentials, GitHub tokens,
  or project API keys. Only the orchestrator performs privileged operations.

## Testing
- TDD: write failing test first, then implementation
- Integration tests for NATS message flows and event recovery
- Unit tests for state machine transitions
- Recovery test: crash orchestrator → restart → verify state matches
- Use Bun's test runner: `bun test`

## Git
- Conventional commits: feat:, fix:, refactor:, test:, docs:
- One logical change per commit
- Tests must pass before commit

## File Organization
- src/orchestrator/ — State machine, event processing, recovery
- src/executors/ — AgentExecutor interface + provider adapters
- src/events/ — Event types, recording, replay, recovery
- src/db/ — Schema, materialized views, migrations
- src/nats/ — Connection, message types, stream setup
- src/skills/ — Skill registry, loading, matching
- src/git/ — Worktree management, branching
- src/privileged/ — Git push, PR creation, authenticated test runs
- src/web/ — Hono API routes, WebSocket handlers
- src/meta/ — Meta-loop analysis, hypothesis generation, experiments
- skills/ — Markdown skill files (not code)
- docs/ — QMD-indexed documentation
```

### program.md

```markdown
# AUTOFORGE Development Program

This project follows the autoresearch pattern: modify → measure → keep or discard.

## Current Focus
{Updated by whoever is working on it — which phase, which task}

## Metrics We Track
- test_pass_rate: All tests must pass (hard gate)
- build_success: TypeScript compiles without errors
- integration_test_pass: NATS message flows work correctly
- state_machine_coverage: All state transitions have tests

## Experiment Log
See results.tsv for the full history.

## How to Run
```bash
bun install
docker compose up -d    # NATS + QMD
bun test                # Unit + integration tests
bun run dev             # Start orchestrator + web UI
```

## How to Submit a Task
```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectId": "autoforge", "description": "Add a hello world endpoint"}'
```
```

---

## 17. BOOTSTRAPPING SEQUENCE

Day 1: Get the skeleton standing.

1. `bun init` + install dependencies (nats, better-sqlite3, hono)
2. Docker Compose with NATS (JetStream enabled)
3. NATS client wrapper + message types
4. SQLite schema creation
5. Orchestrator: subscribe to task events, log them
6. Test: publish a task event via NATS CLI, see it in SQLite

Day 2: First agent spawn.

1. Claude Code subprocess spawning
2. Minimal prompt: "Write a function that does X. Write a test first."
3. Worktree creation + cleanup
4. Collect output, log to events table
5. Test: spawn agent, verify code appears in worktree

Day 3: Connect the pipeline.

1. State machine: RECEIVED → PLANNING → EXECUTING → COMPLETED
2. Planner agent produces subtask list
3. Coder agent executes subtasks sequentially
4. Results committed to git branch
5. Test: full flow from feature request to committed code

This is the bootstrap. Everything after this is incremental improvement — which is what AUTOFORGE is designed to do.

---

## APPENDIX A: Docker Compose (Local Development)

```yaml
version: '3.8'

services:
  nats:
    image: nats:latest
    command: ["--jetstream", "--store_dir=/data"]
    ports:
      - "4222:4222"
      - "8222:8222"  # Monitoring
    volumes:
      - nats-data:/data

  qmd:
    image: qmd:latest
    ports:
      - "3100:3100"
    volumes:
      - ./docs:/data/docs
      - ./skills:/data/skills
    command: ["qmd", "serve", "--port", "3100"]

  autoforge:
    build: .
    depends_on:
      - nats
      - qmd
    ports:
      - "3000:3000"  # Web UI
    environment:
      - NATS_URL=nats://nats:4222
      - QMD_MCP_URL=http://qmd:3100
      - DATABASE_PATH=/data/db/autoforge.sqlite
      - EXECUTOR_DEFAULT=claude-code  # AgentExecutor adapter selection
    env_file:
      - .env  # ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.
    volumes:
      - db-data:/data/db
      - ./skills:/data/skills:ro   # Read-only for agents
      - ./docs:/data/docs
      - projects:/data/projects

volumes:
  nats-data:
  db-data:
  projects:
```

## APPENDIX B: Cloud Deployment (AWS Scale-to-Zero)

### Architecture Summary

```
Component           AWS Service              Cost When Idle    Cost When Active
────────────────────────────────────────────────────────────────────────────────
NATS                EC2 t4g.nano             ~$3/month         Same (always on)
                    or managed NATS service
Database            RDS db.t4g.micro         ~$15/month        Same (always on)
                    or SQLite on EFS
Event Bridge        Lambda (NATS listener)   ~$0/month         Pennies per invoke
Orchestrator        Fargate (scale to zero)  $0 when idle      ~$0.01/hour active
QMD                 Fargate (scale to zero)  $0 when idle      ~$0.01/hour active
Web UI              S3 + CloudFront (static) ~$1/month         Same
API backend         Lambda or Fargate        $0 when idle      Per-request
Agent Runtimes      Fargate tasks            $0 when idle      ~$0.03/task
EFS                 File storage             ~$3-10/month      Same
S3                  Backups/artifacts        ~$1/month         Same
────────────────────────────────────────────────────────────────────────────────
TOTAL IDLE:         ~$20-30/month
TOTAL ACTIVE:       Idle + per-second Fargate + LLM API costs
```

### Wake/Sleep Mechanism

```
SLEEP (no active tasks):
  ├── NATS: running (t4g.nano, $3/month)
  ├── Database: running (RDS micro, $15/month)
  ├── Lambda (Event Bridge): subscribed to NATS, dormant ($0)
  ├── Orchestrator: OFF ($0)
  ├── QMD: OFF ($0)
  └── Agent runtimes: OFF ($0)

WAKE (new task submitted):
  1. Web UI or API call publishes task to NATS
  2. Lambda detects new task event on NATS stream
  3. Lambda starts Orchestrator Fargate task
  4. Orchestrator recovers state from event log
  5. Orchestrator starts QMD Fargate task if needed
  6. Orchestrator dispatches agent Fargate tasks
  7. Agents execute, publish results to NATS
  8. Orchestrator processes results, dispatches next steps
  9. When pipeline reaches human approval: orchestrator shuts down
  10. Human approves via dashboard → Lambda re-wakes orchestrator
  11. Orchestrator merges, documents, records metrics
  12. Orchestrator shuts down → back to SLEEP
```

### Infrastructure-as-Code (CDK Sketch)

```typescript
// This is a sketch, not production code. Build this when ready for cloud.
const stack = new cdk.Stack(app, 'AutoforgeStack');

// Always-on: NATS + Database
const nats = new ec2.Instance(stack, 'NATS', {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
  // ... NATS server config
});

const db = new rds.DatabaseInstance(stack, 'Database', {
  engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
});

// Shared storage
const efs = new efs.FileSystem(stack, 'SharedStorage');

// Scale-to-zero: Orchestrator
const orchestratorTask = new ecs.FargateTaskDefinition(stack, 'Orchestrator', {
  cpu: 512, memoryLimitMiB: 1024,
});
// Note: NO always-running service. Started by Lambda on demand.

// Event Bridge: Wake orchestrator on new tasks
const wakeFunction = new lambda.Function(stack, 'WakeOrchestrator', {
  // Subscribes to NATS, starts Orchestrator Fargate task when events arrive
});

// Agent runtime task definition (template for on-demand tasks)
const agentTask = new ecs.FargateTaskDefinition(stack, 'AgentRuntime', {
  cpu: 512, memoryLimitMiB: 2048,
  // Agent containers: Claude Code, Codex, etc.
  // Orchestrator calls ecs.runTask() to spawn these on demand
});
```

## APPENDIX C: Key Dependencies

```json
{
  "dependencies": {
    "nats": "latest",
    "better-sqlite3": "latest",
    "hono": "latest",
    "@hono/node-server": "latest",
    "uuid": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/better-sqlite3": "latest",
    "@types/bun": "latest"
  }
}
```

## APPENDIX C: Results.tsv Format

```
experiment_id	skill	agent	metric_name	metric_before	metric_after	complexity_delta	status	description	timestamp
bootstrap	-	-	-	0.0	0.0	0	keep	Initial system standing up	2026-04-09T00:00:00Z
```

Tab-separated. Append-only. Human-scannable. Machine-parseable. One row per meta-loop experiment.
