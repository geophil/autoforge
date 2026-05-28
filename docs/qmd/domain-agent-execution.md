# Agent Execution

Autoforge now runs a single production execution path:

- `HarnessExecutor` drives the agent loop.
- `AnthropicProvider` is the model provider.
- `RuntimeToolRegistry` provides the runtime tool surface.
- `Workspace` is the file/exec sandbox boundary.

The only alternate mode is `mock` for deterministic tests.

## Runtime Contract

### Executors

`createExecutors(env)` returns one `primary` executor:

- `EXECUTOR_DEFAULT=harness` -> real runtime (`HarnessExecutor`)
- `EXECUTOR_DEFAULT=mock` -> test runtime (`MockExecutor`)

`OrchestratorService.routeExecutor()` always returns the configured primary executor. Tier and agent type still affect budget/model/prompt policy, but not executor selection.

### Status File Invariant

All agents must write `.autoforge-status.json`:

```json
{
  "status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
  "artifacts": ["relative/path/to/file1"],
  "concerns": "(optional)",
  "blockReason": "(optional)"
}
```

If the status file is missing, the runtime returns `DONE_WITH_CONCERNS`.

### Workspace Boundary

`AgentTask.workspace` is the only file/exec surface. `LocalWorkspace` enforces root-constrained paths and controlled child-process environment.

### Local Docker Workspace Provider

Autoforge can route agent execution through local Docker containers by
setting `WORKSPACE_PROVIDER=docker`. The orchestrator creates one git
worktree per task and **one container per task**; that container is shared
by every agent dispatch in the task (planner, coder subtasks, reviewer
iterations, doc, meta) and torn down when the worktree is cleaned up.

The runtime contract remains `Workspace`:

- `readFile` and `writeFile` use host-side path checks against the mounted
  worktree (the worktree is bind-mounted at `/workspace` inside the
  container, so writes from either side are visible immediately on the
  other).
- `exec` runs through `docker exec` with `cwd` mapped under `/workspace`.
  The cwd must exist on the host before exec is invoked (strict realpath
  check, matching `LocalWorkspace`).
- `destroy` removes the per-task container; idempotent across restarts
  via the in-memory workspace map plus a recovery-time event-log walker.

The rollback path is `WORKSPACE_PROVIDER=local`. This restores legacy
local worktree execution without changing planner, coder, reviewer, doc,
or meta agent behavior.

#### Trust boundary (what runs where)

When `WORKSPACE_PROVIDER=docker`:

- **Inside the container** (cannot reach host fs / network / credentials):
  - All agent tool calls (`read_file`, `write_file`, `exec`, `done`, …).
  - Lifecycle hooks: `bun run lint`, `bun run test`, `bun run format`,
    `bun run lint:fix` from the agent-mutated `package.json`.
  - PR-gate test runners: `bun test`, `npm test`, `npx vitest run`,
    `npx jest`.
- **On the host** (trusted operations only):
  - `git worktree add/remove` and orchestrator-driven `git status`/`add`/
    `commit` (git itself is trusted; agent files it operates on are not
    executed by git).
  - `bun install --frozen-lockfile` (or `npm ci` / `yarn install` / `pnpm
    install`). Lockfile is human-committed; `--frozen-lockfile` blocks
    drift; `--network=none` inside the container blocks mid-task
    `bun add`. **This is the documented trust boundary** — postinstall
    scripts in third-party deps still run as the orchestrator user unless
    you set `WORKSPACE_INSTALL_IGNORE_SCRIPTS=1`, which adds
    `--ignore-scripts` to the host install (fewer moving parts on the host,
    but some packages may need their install hooks — default remains off).
  - Diagnostic and reflection runs always use a per-run local tmpdir
    workspace (regardless of `WORKSPACE_PROVIDER`) so neither agent can
    bind-mount the autoforge source tree.

#### Image contract

The default `WORKSPACE_DOCKER_IMAGE=autoforge-agent:local` is built by
`bun run image:agent` from `docker/autoforge-agent/Dockerfile`. Custom
images must:

- Have `bun` and `git` on `PATH`.
- Contain a user with the numeric uid/gid matching
  `WORKSPACE_DOCKER_UID` / `WORKSPACE_DOCKER_GID` (defaults: 1000/1000).
- Use `/workspace` as the conventional working directory.

#### Recovery and orphan cleanup

If the orchestrator crashes mid-task, the in-memory workspace handle is
lost but the event log still records `workspace_created`. The next
`cleanupWorktree` call walks events and emits compensating
`workspace_destroyed` events so analytics consumers see a well-paired
lifecycle. The actual container (still running) is reaped by
`reapOrphanWorkspaceContainers` if `WORKSPACE_DOCKER_REAP_ON_START=1`;
otherwise the operator runs the manual sweep:

```
docker ps -a --filter label=autoforge.workspace=true -q | xargs -r docker rm -f
```

Tasks paused at human gates (`awaiting_spec_approval`,
`awaiting_plan_approval`, `awaiting_approval`, `awaiting_intervention`)
are intentionally exempt from the staleness sweeper, so they
legitimately survive an orchestrator restart. When the operator
subsequently calls `approveSpec`, `critiqueSpec`, `approvePlan`,
`critiquePlan`, `approveTask`, or `retryFromIntervention`, the
orchestrator lazily re-creates the per-task workspace via
`ensureTaskWorkspace` before any agent dispatch. The workspace
`id` is logically deterministic (`${taskId}:task`), so the existing
`workspace_created` event is reused and no duplicate is appended; the
single paired `workspace_destroyed` is emitted when `cleanupWorktree`
runs at task termination. The physical container left behind by the
previous incarnation is the orphan reaper's responsibility (see
above).

#### Operational gates before making Docker the team default

- Docker preflight succeeds on developer machines (`docker info` and
  `docker image inspect autoforge-agent:local`).
- The Docker-gated integration test passes (`AUTOFORGE_DOCKER_TESTS=1
  bun test tests/integration/container-workspace-docker.test.ts`).
- No persistent `autoforge.workspace=true` orphan containers after
  repeated failed runs (verify with the manual sweep above).
- `WORKSPACE_PROVIDER=local` rollback succeeds after an induced Docker
  failure.

### Provider Boundary

`ModelProvider` abstracts model APIs. `AnthropicProvider` currently implements this boundary for production.

## Harness Loop

`HarnessExecutor`:

1. Builds the system prompt from persona + lessons + skills + status instructions.
2. Calls the provider with tool definitions.
3. Executes `tool_use` calls through `RuntimeToolRegistry`.
4. Appends tool results back into history.
5. Finalizes from `.autoforge-status.json`.

Important behavior:

- Deadline checked before each provider and tool call.
- Timeout-like failures return `TIMEOUT`.
- Tool failures become `tool_result` errors unless timeout-like.
- `exec` tool results are artifact-backed: full stdout/stderr are written under ignored `.autoforge/tool-results/`, while the model receives a structured summary by default.
- QMD MCP tool calls use a separate bounded allowance from the base agent budget, plus a per-call timeout.
- Large QMD MCP results are artifact-backed above the configured threshold; small QMD results pass through unchanged.
- Planner spec runs have guardrails for final reserve time, QMD call count, total tool calls, and serialized context growth.
- Runtime failure diagnostics distinguish subtypes such as `qmd_call_timeout`, `qmd_allowance_exceeded`, `model_call_timeout`, `planner_final_reserve_exhausted`, `max_tool_iterations`, and `context_budget_exceeded`.
- Transcript includes assistant and tool_result turns plus loaded skill attribution.

## Model Routing

Planner, coder, reviewer, and doc dispatches use a deterministic model router before execution. The router selects a configured tier (`cheap`, `standard`, or `strong`) from phase, task tier, failure count, description, and file-scope risk signals. V1 keeps engineering dispatches on `standard` by default and escalates to `strong` for auth/security/secrets, payments, database migrations/schema, production infrastructure, orchestrator/runtime/provider changes, and repeated failures. If a routed dispatch returns `FAILED` or `TIMEOUT`, the orchestrator retries once at the stronger tier before the existing intervention path; coder retries are skipped after file writes to avoid compounding partial mutations.

Each decision emits `model_routing_decision` with selected tier/model, risk level, sensitive areas, rationale, failure count, and escalation metadata.

The V2 cost-efficiency roadmap lives in `docs/qmd/model-cost-efficiency-v2.md`. V2 keeps adaptive routing behind runtime decomposition, stable prompt-prefix/cache discipline, and durable `agent_runtime_telemetry` evidence. Runtime cache KPI reporting is exposed through `GET /api/metrics/:projectId/runtime-cache-kpis` and is based on the compact event payloads rather than raw telemetry arrays.

## Runtime Tools

`createRuntimeToolRegistry()` registers:

- `read_file`
- `write_file`
- `exec`
- `read_tool_artifact` (for shaped exec and QMD/MCP artifacts)
- `done`
- `lookup_skill` (when skill registry is provided)
- `load_skill` (when skill registry is provided)

## Configuration Touchpoints

- `EXECUTOR_DEFAULT`: `harness | mock`
- `ANTHROPIC_API_KEY`: required for `harness`
- `ANTHROPIC_MODEL`: default model for harness provider calls
- `MODEL_TIER_CHEAP` / `MODEL_TIER_STANDARD` / `MODEL_TIER_STRONG`: routed model tiers
- `QMD_MCP_URL`: forwarded as non-secret agent environment context
- `QMD_MCP_TOTAL_ALLOWANCE_SECONDS` / `QMD_MCP_CALL_TIMEOUT_SECONDS`: QMD MCP latency controls
- `PLANNER_FINAL_RESERVE_SECONDS` / `PLANNER_SPEC_MAX_QMD_CALLS` / `PLANNER_SPEC_MAX_TOOL_CALLS`: planner spec guardrails
- `MODEL_CALL_TIMEOUT_SECONDS`: optional per-provider-call timeout cap
- `HARNESS_CONTEXT_MAX_CHARS`: serialized history growth guardrail

## Integration Points

- `OrchestratorService` dispatches planner/coder/reviewer/doc/meta/reflector/diagnostician through the same executor interface.
- `PersonaRegistry` resolves persona content for `systemPrompt`.
- `SkillRegistry` resolves `skillFiles`.
- `DbClient` persists events/transcripts with executor provenance (`executor_used`).

## File Map

| File | Purpose |
|------|---------|
| `src/executors/interface.ts` | `AgentExecutor`, `AgentTask`, `AgentResult` contracts |
| `src/executors/factory.ts` | Builds harness or mock executor |
| `src/executors/mock.ts` | Deterministic executor for tests |
| `src/runtime/harness-executor.ts` | Production executor loop |
| `src/runtime/anthropic-provider.ts` | Anthropic model provider adapter |
| `src/runtime/model-provider.ts` | Provider abstraction |
| `src/runtime/tool-registry.ts` | Tool registry and execution context |
| `src/runtime/tools.ts` | Runtime tool implementations |
| `src/runtime/workspace.ts` | Workspace interface |
| `src/runtime/local-workspace.ts` | Local workspace implementation |
| `src/orchestrator/service.ts` | Dispatch lifecycle and runtime integration |
# Agent Execution

The Agent Execution domain uses a single production runtime path behind `AgentExecutor`: `HarnessExecutor` with `AnthropicProvider` and `RuntimeToolRegistry`. `createExecutors()` now configures either `harness` (real traffic) or `mock` (tests). The domain separates where tools run (`Workspace`), which model API is called (`ModelProvider`), and which persona/skills define the agent.

## Business Rules and Invariants

### All Agents Must Write `.autoforge-status.json`

The status file is the contract between an agent and the orchestrator. The executor enforces this requirement and falls back to `DONE_WITH_CONCERNS` if the file is absent.

```typescript
// src/runtime/harness-executor.ts (via the runtime `done` tool / post-run check)
if (!statusFile) {
  return {
    status: "DONE_WITH_CONCERNS",
    artifacts: [],
    concerns: "Agent did not write .autoforge-status.json",
    output: { raw: "(no status file)" },
    metrics: { elapsedSeconds }
  };
}
```

**Status file schema**:
```json
{
  "status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
  "artifacts": ["relative/path/to/file1"],
  "concerns": "(optional)",
  "blockReason": "(optional)"
}
```

**Implemented in**: `HarnessExecutor.execute()` (production) and `MockExecutor.execute()` (tests). The legacy `ClaudeCodeExecutor` and `AnthropicSdkExecutor` were removed in commit `645a376`.

### Budget Is Enforced by the Executor

`HarnessExecutor` checks the deadline before each provider call and before starting each tool call, and passes the remaining timeout context into tools. Long-running non-`exec` tools are still expected to return promptly; `exec` receives a concrete timeout that the runtime forwards into the workspace child process.

**Implemented in**: `HarnessExecutor.execute()` and `MockExecutor.execute()`.

### `Workspace` Is the File and Exec Boundary

`AgentTask` no longer exposes `workingDirectory` directly. Executors receive a `Workspace`, so local and future cloud sandboxes share the same read/write/exec contract.

```typescript
// src/runtime/workspace.ts
export type WorkspaceProvider = "local" | "mock" | "docker";

export interface Workspace {
  readonly id: string;
  readonly provider: WorkspaceProvider;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
  destroy(): Promise<void>;
}
```

`LocalWorkspace` constrains paths to its root, rejects symlink escapes, streams stdout/stderr/exit events from `child_process.spawn`, and sanitizes child process environment inheritance.

```typescript
// src/runtime/local-workspace.ts
async *exec(cmd: string, args: string[], opts: ExecOptions = {}): AsyncIterable<ExecEvent> {
  const cwd = opts.cwd ? this.resolveInsideRoot(opts.cwd) : this.rootPath;
  await this.assertRealPathInsideRoot(cwd, opts.cwd ?? ".");
  yield* spawnStreaming(cmd, args, {
    cwd,
    env: childProcessEnv(opts.env),
    timeoutSeconds: opts.timeoutSeconds
  });
}
```

All current executors (production `HarnessExecutor`, test `MockExecutor`) interact with the worktree exclusively through `Workspace.readFile`, `Workspace.writeFile`, and `Workspace.exec`. The previous local-only shims (`ClaudeCodeExecutor`, `AnthropicSdkExecutor`) and their `requireLocalWorkspaceRoot` escape hatch have been removed; the Workspace interface is the only file/exec boundary.

### `ModelProvider` Is the Message API Boundary

`ModelProvider` normalizes model calls so Anthropic, OpenAI, and Gemini can be swapped without rewriting workspace or persona logic.

```typescript
// src/runtime/model-provider.ts
export interface ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];
  message(args: {
    model: string;
    systemPrompt: string;
    history: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    timeoutSeconds?: number;
  }): Promise<ModelResponse>;
}
```

`AnthropicProvider` currently implements this interface. It owns the Anthropic client and API key in the orchestrator process, maps tool definitions to Anthropic tool schemas, preserves stop reasons such as `tool_use`, `pause_turn`, and `refusal`, and returns normalized token usage.

### `HarnessExecutor` Composes Provider, Workspace, and Tools

`HarnessExecutor` is the new model-agnostic loop. It receives a `ModelProvider`, a `ToolRegistry`, and an `AgentTask.workspace`; then it loops over model responses, executes tool calls against the workspace, and finalizes through the existing status-file convention.

```typescript
// src/runtime/harness-executor.ts
const response = await this.options.provider.message({
  model: task.model ?? this.options.defaultModel,
  systemPrompt,
  history: snapshotHistory(history),
  tools: this.options.tools.definitions(),
  maxTokens: DEFAULT_MAX_TOKENS,
  timeoutSeconds: remainingMs / 1000
});
```

Important harness rules:
- Provider history is deep-cloned before calls so providers cannot mutate transcript state.
- Tool exceptions become recoverable `tool_result` errors unless they are timeout-style errors.
- Tool stats increment only after a tool actually starts.
- `pause_turn`, `refusal`, `stop_sequence`, `max_tokens`, and `end_turn` are terminal provider stops.
- `load_skill` records loaded skill attribution only after the markdown content is successfully read.

### Single Runtime Routing

`createExecutors(env)` builds one primary executor. For production, that is `HarnessExecutor`; for tests, `MockExecutor`. `OrchestratorService.routeExecutor()` always returns the configured primary executor.

```typescript
// src/executors/factory.ts
export interface ExecutorSet {
  primary: AgentExecutor;
}

export function createExecutors(env: AppEnv): ExecutorSet {
  if (env.EXECUTOR_DEFAULT === "mock") return { primary: new MockExecutor() };
  return { primary: new HarnessExecutor(...) };
}
```

```typescript
// src/orchestrator/service.ts
private routeExecutor(tier: Tier, agentType: AgentType): AgentExecutor {
  return this.deps.executor;
}
```

**Implemented in**: `createExecutors()` and `OrchestratorService.routeExecutor()`.

### Each Agent Is Composed from a Persona and Skills

Every agent receives two distinct prompt inputs resolved by the orchestrator before dispatch:

- **Persona** (`PersonaRegistry.resolve(agentType)` / `resolveVariant(variantId, agentType)`) — defines who the agent is and how it approaches work. Loaded from `src/personas/<type>.md` by default; dispatch-selected DB variants in `skill_versions` override file content for live population traffic.
- **Skills** (`SkillRegistry.skillsForAgent(agentType)`) — technique reference files injected alongside the persona.

```typescript
// src/skills/registry.ts
const AGENT_SKILLS: Record<AgentType, string[]> = {
  planner:      ["writing-plans.md"],
  coder:        ["tdd.md", "systematic-debugging.md", "verification-before-completion.md"],
  reviewer:     ["two-stage-review.md"],
  doc:          ["documentation.md"],
  "doc-review": ["documentation.md", "verification-before-completion.md"],
  pr:           [],
  orchestrator: [],
  meta:         ["writing-skills.md"],
  reflector:    [],
  diagnostician: []
};
```

Both inputs are passed to `executor.execute()` as `systemPrompt` (persona) and `skillFiles` (skills). `AgentTask` now carries both fields:

```typescript
// src/executors/interface.ts
export interface AgentTask {
  id: string;
  type: AgentType;
  systemPrompt: string;   // persona content resolved by PersonaRegistry
  prompt: string;         // task-specific user message
  workspace: Workspace;   // read/write/exec boundary
  skillFiles: string[];   // paths resolved by SkillRegistry
  // ...
}
```

**Enforced in**: `src/personas/registry.ts`, `src/skills/registry.ts`, `src/orchestrator/service.ts`

### Agents Have No Access to Secrets

Agents run in isolated worktrees with no privileged credentials. `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` live only in the orchestrator process. `agentEnvironment()` forwards only non-secret runtime context: currently `QMD_MCP_URL` when configured. Planner, coder, reviewer, doc, and any doc-review style task that uses `agentEnvironment()` can query QMD; meta, reflector, and diagnostician utility calls use an empty environment.

```typescript
// src/orchestrator/service.ts
private agentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  if (this.deps.env.QMD_MCP_URL) {
    env.QMD_MCP_URL = this.deps.env.QMD_MCP_URL;
  }
  return env;
}
```

**Implemented in**: `OrchestratorService.agentEnvironment()`.

`LocalWorkspace.exec()` enforces the same invariant for shell commands: it builds a child process env from a small allowlist (`PATH`, `HOME`, `TMPDIR`, `SHELL`) plus explicit task environment. It does not spread `process.env`, so model-facing tools cannot print orchestrator API keys.

### Planner Must Return QMD Evidence When QMD Is Configured

Planner prompts receive `QMD_MCP_URL` through `agentEnvironment()` and the planner skill (`skills/writing-plans.md`) requires QMD-first context gathering. The orchestrator now enforces that planner outputs include `planningContext.qmdContext` evidence when `QMD_MCP_URL` is present.

If the planner output does not include usable QMD evidence (`status: "used"` with at least one query or retrieved document), orchestration pauses in `awaiting_intervention` with `failure_category=planner_missing_qmd_context`.

## Core Flows

### HarnessExecutor.execute Flow

`HarnessExecutor` is the single production runtime. It runs an agentic tool-use loop against `ModelProvider` (today `AnthropicProvider`) using the `RuntimeToolRegistry`.

1. **System prompt**: Persona (`task.systemPrompt`) + skills metadata + status-reporting instructions, sent via `ModelProvider.message`. The prefix is cached at the provider boundary so subsequent loop iterations hit the prompt cache.
2. **User message**: `task.prompt` — the task-specific content.
3. **MCP wiring** (optional): When `QMD_MCP_URL` is set in `task.environment`, the harness opens a Streamable HTTP MCP client to QMD, lists its tools, and merges them with the local tool registry. The MCP client lifetime is scoped to the `execute()` call: opened up front, closed in `finally` (even on early return).
4. **Tool loop**: `ModelProvider.message` is called repeatedly. Tool calls are dispatched against the registry (`read_file`, `write_file`, `exec`, `done`, `lookup_skill`, `load_skill`) or routed to MCP by name.
5. **Deadline check**: The deadline is enforced before each provider call and before each tool call. Long-running `exec` tools receive a concrete timeout.
6. **Status read**: `.autoforge-status.json` is read from the workspace; if absent → `DONE_WITH_CONCERNS`.
7. **Token tracking**: input + output tokens are accumulated across iterations and returned on `AgentResult.metrics`. Context-envelope hashes flow through the orchestrator's prompt-hash telemetry.
8. **Context compaction**: when projected input approaches the model's budget threshold, older tool-use/tool-result exchange groups are compacted into a structured memory block. Compaction preserves API pairing validity (drop/retain full exchange groups only), uses a pinned summarization model by default, and falls back to bounded extractive memory when summarization fails.

The harness uses **client-side MCP** (in-process `@modelcontextprotocol/sdk`) rather than Anthropic's remote MCP connector — the QMD server is not publicly reachable (it lives on the docker / k8s service network).

Available local tools (same set regardless of MCP) live in the **Harness Runtime Tools and Skill Loading** section below.

Compaction telemetry is stored in transcript turns (`kind: "compaction"`) with:
- `droppedTurns`
- `retainedRecentTurns`
- `triggerInputTokens`
- `summaryInputCharCount`
- `summaryOutputCharCount`
- `summaryModel` (or `null` on fallback)
- `usedFallback`

When `QMD_MCP_URL` is set in `AgentTask.environment`, that agent sees QMD's MCP tools (`query`, `get`, `multi_get`, `status`) alongside the local set; their names are reserved so they don't collide.

### Harness Runtime Tools and Skill Loading

`createRuntimeToolRegistry()` creates workspace-backed tools for the harness:

| Tool | Purpose |
|---|---|
| `read_file` | Read UTF-8 content from `Workspace.readFile()` |
| `write_file` | Write UTF-8 content through `Workspace.writeFile()` |
| `exec` | Collect streamed `Workspace.exec()` stdout/stderr/exit status, store raw output as an internal artifact, and return a summary/excerpt/full response by requested mode |
| `read_tool_artifact` | Read a prior exec artifact by reference; `full` mode requires a reason |
| `done` | Write `.autoforge-status.json` with runtime status validation |
| `lookup_skill` | Return `{ name, description }[]` from markdown skill files |
| `load_skill` | Return full skill markdown and record `loadedSkills` attribution |

```typescript
// src/runtime/tools.ts
execute: async (input, _workspace, context) => {
  const name = requireString(input.name, "name");
  const skill = (await listSkillSummaries(options.skillRegistry!)).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  const content = await readFile(skill.path, "utf8");
  context.recordLoadedSkill?.(name);
  return { name, content };
}
```

Loaded skills are recorded two ways: `AgentTranscript.loadedSkills` for structured metadata and a `loaded_skills` transcript turn. Today, normal transcript persistence is planner-focused, so the JSONL turn is persisted when a harness-backed planner transcript is inserted; for other harness-backed agents the attribution is available on `AgentResult.transcript` until broader transcript persistence is added.

### Utility Agent Flow (`reflector` and `diagnostician`)

Spec D adds two utility personas to the shared `AgentExecutor` contract. They are valid `AgentType` values and run through the same executor interface, status-file convention, budget handling, and transcript/metric plumbing as task-facing agents, but they are not population members that receive live feature-task traffic.

```typescript
// src/types/core.ts
export type AgentType =
  | "planner" | "coder" | "reviewer" | "doc" | "doc-review"
  | "pr" | "orchestrator" | "meta"
  | "reflector" | "diagnostician";
```

- `reflector` runs after terminal task states. `OrchestratorService.reflectOnTask()` calls the exported `reflectOnTask()` helper in `src/orchestrator/reflection.ts`, which supplies recent task evidence and active lineage lessons, then persists generalized corrections into `lessons` via `lesson_inserted` events. It is a utility persona for extracting reusable memory, not a dispatch competitor selected by `createDispatcher()`.
- `diagnostician` runs from `runPopulationDiagnostic()` and `POST /api/diagnostic/run`. It receives recent task histories for one live agent type, identifies under-served niches, writes `fork_proposals`, and emits `diagnostic_run_completed` / `diagnostic_cluster_detected` events. It proposes population changes but does not itself receive normal task traffic.

## Data Entities

```typescript
// src/executors/interface.ts
export interface AgentTask {
  id: string;
  type: AgentType;
  systemPrompt: string;              // persona resolved by PersonaRegistry
  prompt: string;
  workspace: Workspace;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolStats {
  readCount: number;
  writeCount: number;
  bashCount: number;
  searchCount: number;
  iterations: number;
}

export interface AgentResult {
  status: SubtaskReportStatus | "FAILED" | "TIMEOUT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  output?: unknown;
  metrics: {
    elapsedSeconds: number;
    tokenInput?: number;
    tokenOutput?: number;
    estimatedCost?: number;
    toolStats?: ToolStats;
  };
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}
```

## Integration Points

- **Task Orchestration**: `OrchestratorService` calls `executor.execute()` for planner, coder, reviewer, doc, meta, reflector, and diagnostician agents. The executor instance is injected as a dependency.
- **Persona Registry**: `PersonaRegistry.resolve(agentType)` provides `systemPrompt`. DB-first resolution allows the meta-loop to activate improved personas without file changes.
- **Skills Registry**: `SkillRegistry.skillsForAgent(agentType)` resolves skill file paths; passed as `AgentTask.skillFiles`.
- **Configuration**: `EXECUTOR_DEFAULT` chooses between `harness` and `mock`; `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` configure the harness provider; `QMD_MCP_URL` enables QMD access for task-facing agents that receive `agentEnvironment()`.

## File Map

| File | Purpose |
|------|---------|
| `src/executors/interface.ts` | `AgentExecutor`, `AgentTask`, `AgentResult` interfaces |
| `src/executors/factory.ts` | `createExecutors(env)` — builds the harness or mock executor |
| `src/executors/mock.ts` | `MockExecutor` — deterministic responses for tests |
| `src/runtime/workspace.ts` | `Workspace` interface shared by local and future cloud sandboxes |
| `src/runtime/local-workspace.ts` | `LocalWorkspace` — root-constrained files and streaming subprocess execution |
| `src/runtime/model-provider.ts` | `ModelProvider` interface and normalized message types |
| `src/runtime/anthropic-provider.ts` | `AnthropicProvider` — Anthropic SDK adapter |
| `src/runtime/harness-executor.ts` | `HarnessExecutor` — provider/workspace/tool loop |
| `src/runtime/tool-registry.ts` | `ToolRegistry` and tool execution context |
| `src/runtime/tools.ts` | Runtime tools: read/write/exec/done/lookup_skill/load_skill |
| `src/personas/registry.ts` | `PersonaRegistry` — resolves persona per agent type (DB-first, then file) |
| `src/personas/*.md` | Persona seed files (planner, coder, reviewer, doc, meta, reflector, diagnostician) |
| `src/skills/registry.ts` | `SkillRegistry` — maps agent types to skill file paths; snapshots to `skill_versions` |
| `skills/*.md` | Skill content files (tdd, systematic-debugging, two-stage-review, etc.) |
