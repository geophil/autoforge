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
- Transcript includes assistant and tool_result turns plus loaded skill attribution.

## Runtime Tools

`createRuntimeToolRegistry()` registers:

- `read_file`
- `write_file`
- `exec`
- `done`
- `lookup_skill` (when skill registry is provided)
- `load_skill` (when skill registry is provided)

## Configuration Touchpoints

- `EXECUTOR_DEFAULT`: `harness | mock`
- `ANTHROPIC_API_KEY`: required for `harness`
- `ANTHROPIC_MODEL`: default model for harness provider calls
- `QMD_MCP_URL`: forwarded as non-secret agent environment context

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

The status file is the contract between an agent and the orchestrator. Both executor implementations enforce this requirement and fall back to `DONE_WITH_CONCERNS` if the file is absent.

```typescript
// src/executors/claude-code.ts (same pattern in anthropic-sdk.ts)
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

**Implemented in**: `ClaudeCodeExecutor.execute()`, `AnthropicSdkExecutor.execute()`, and `HarnessExecutor.execute()`.

### Budget Is Enforced by the Executor

For ClaudeCodeExecutor, a `setTimeout` sends SIGTERM at `budgetSeconds`, then SIGKILL after a 10-second grace period.

```typescript
// src/executors/claude-code.ts
const budgetTimer = setTimeout(() => {
  onTimeout();
  child.kill("SIGTERM");
  sigkillTimer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 10_000);
}, timeoutSeconds * 1000);
```

For `AnthropicSdkExecutor`, a deadline timestamp is checked at the start of each tool iteration loop. `HarnessExecutor` checks the deadline before each provider call and before starting each tool call, and it passes remaining timeout context into tools. Long-running non-`exec` tools are still expected to return promptly; `exec` receives a concrete timeout.

**Implemented in**: `ClaudeCodeExecutor.execute()`, `AnthropicSdkExecutor.execute()`, and `HarnessExecutor.execute()`.

### `Workspace` Is the File and Exec Boundary

`AgentTask` no longer exposes `workingDirectory` directly. Executors receive a `Workspace`, so local and future cloud sandboxes share the same read/write/exec contract.

```typescript
// src/runtime/workspace.ts
export interface Workspace {
  readonly id: string;
  readonly provider: "local" | "mock" | "e2b" | "aws" | string;
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

`ClaudeCodeExecutor` and the current `AnthropicSdkExecutor` are transitional local-only shims: they call `requireLocalWorkspaceRoot(task.workspace)` to get a subprocess `cwd`. A non-local workspace will fail fast for these executors instead of silently running in the wrong place.

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

### ClaudeCodeExecutor.execute Flow

The Claude Code CLI is the legacy local runtime. It still runs in non-interactive mode and remains available for filesystem-heavy work while the harness reaches feature parity.

1. **Prompt assembly**: Persona (`systemPrompt`) + skills content + task prompt + status-reporting instructions are concatenated into a single stdin string.
2. **MCP config** (optional): If `QMD_MCP_URL` is set in `task.environment`, a temporary `--mcp-config` JSON is written pointing at the QMD server so the agent can call `query`/`get`/`multi_get` tools.
3. **Spawn**: `claude --print --dangerously-skip-permissions --output-format text --input-format text [--mcp-config <path>]` is spawned; the full prompt is piped to stdin.
4. **Budget timer**: SIGTERM sent at deadline, SIGKILL after 10s grace.
5. **Status read**: `.autoforge-status.json` is read from the worktree; if absent → `DONE_WITH_CONCERNS`.
6. **Return**: `AgentResult` with status, artifacts, elapsed time, and the full status file as `output`.

```typescript
// claude invocation (src/executors/claude-code.ts)
spawn(command, [
  "--print",
  "--dangerously-skip-permissions",
  "--output-format", "text",
  "--input-format", "text",
  ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [])
], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
```

### AnthropicSdkExecutor.execute Flow

Used when `EXECUTOR_DEFAULT=anthropic-sdk`. Runs a tool-use agentic loop against the Anthropic Messages API.

1. **System prompt**: Persona (`task.systemPrompt`) + skills + status-reporting instructions, sent as the API `system` field as a single text block with an ephemeral `cache_control` breakpoint. This caches the `tools + system` prefix on the first call and reads at 0.1× cost on every subsequent iteration within the 5-minute TTL — typically ~80% reduction in prefix input cost per planner run.
2. **User message**: `task.prompt` — the task-specific content.
3. **MCP wiring** (optional): If `QMD_MCP_URL` is set in `task.environment`, opens a Streamable HTTP MCP client to the QMD server, lists its tools, and merges them into the API `tools` array alongside the local tools. The client lifetime is scoped to the `execute()` call: opened at the top, closed in `finally` (even on early return). Tool calls naming an MCP tool are dispatched to `mcpClient.callTool()`; their text content is returned as the `tool_result` payload.
4. **Tool loop** (max 50 iterations): Calls `client.messages.create()` with the merged tools. Executes tool calls locally (or via MCP), appends results.
5. **Deadline check**: If `Date.now() >= deadlineMs` at loop start → TIMEOUT.
6. **Status read**: Same `.autoforge-status.json` convention as ClaudeCodeExecutor.
7. **Token tracking**: `totalInputTokens` and `totalOutputTokens` accumulated across all loop iterations and returned in `AgentResult.metrics`.
8. **SDK-only context compaction**: when projected input reaches a model-budget threshold, old tool-use/tool-result exchange groups are compacted into a structured memory block. Compaction preserves API pairing validity (drop/retain full exchange groups only), uses a pinned summarization model by default (`claude-haiku-4`), and falls back to bounded extractive memory when summarization fails.

Both executors now use **client-side MCP**: `ClaudeCodeExecutor` writes a `--mcp-config` file the Claude CLI consumes; `AnthropicSdkExecutor` runs the MCP client in-process via `@modelcontextprotocol/sdk`. Anthropic's remote MCP connector (`mcp_servers` API param) is intentionally not used — it would require the QMD server to be publicly reachable, which it isn't (QMD lives on the docker / k8s service network).

### ClaudeCodeExecutor Deprecation Timeline

`ClaudeCodeExecutor` is marked `@deprecated`, but it is not removed in this plan. The deprecation is a direction-of-travel marker: new execution features should target `HarnessExecutor`, `Workspace`, `ModelProvider`, and `ToolRegistry`.

| Phase | Routing behavior | Action |
|---|---|---|
| Now | Claude Code remains available and is still returned for meta plus STANDARD/THOROUGH filesystem-heavy work. | Keep behavior unchanged. Use the `LocalWorkspace` adapter shim. |
| Next plan | Harness reaches feature parity for planner/coder/reviewer/doc flows that currently need Claude Code. | Run a bake-off period with both runtimes available. |
| Following plan | `routeExecutor()` stops returning Claude Code by default. | Keep module as an emergency fallback. |
| Later | Harness is stable for all supported agent types. | Delete `src/executors/claude-code.ts` and related tests. |

The main compatibility rule is that Claude Code only accepts `LocalWorkspace`. If a future cloud workspace is routed to this executor, `requireLocalWorkspaceRoot()` fails fast instead of silently running tools in the orchestrator working directory.

Available local tools for `AnthropicSdkExecutor` (same set regardless of MCP):
- `read_file` — read a file relative to working directory
- `write_file` — write a file, creating parent directories
- `list_directory` — list directory contents
- `search_files` — grep over working directory
- `read_multiple_files` — batch read
- `bash` — run a shell command (60s timeout)

Compaction telemetry is stored in transcript turns (`kind: "compaction"`) with:
- `droppedTurns`
- `retainedRecentTurns`
- `triggerInputTokens`
- `summaryInputCharCount`
- `summaryOutputCharCount`
- `summaryModel` (or `null` on fallback)
- `usedFallback`

When `QMD_MCP_URL` is set in `AgentTask.environment`, that agent sees QMD's MCP tools (`query`, `get`, `multi_get`, `status`) — names that don't collide with the local set.

### Harness Runtime Tools and Skill Loading

`createRuntimeToolRegistry()` creates workspace-backed tools for the harness:

| Tool | Purpose |
|---|---|
| `read_file` | Read UTF-8 content from `Workspace.readFile()` |
| `write_file` | Write UTF-8 content through `Workspace.writeFile()` |
| `exec` | Collect streamed `Workspace.exec()` stdout/stderr/exit status |
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
