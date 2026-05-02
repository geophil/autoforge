# Agent Execution

The Agent Execution domain abstracts over different AI runtimes (Claude Code CLI, Anthropic API, mock) behind a single `AgentExecutor` interface. `createExecutors()` builds an `ExecutorSet`, and `OrchestratorService.routeExecutor()` chooses the runtime per tier and agent type. The domain also manages the skill system — markdown files injected into prompts — so the orchestrator can read structured results without coupling to a specific runtime.

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

**Implemented in**: `ClaudeCodeExecutor.execute()` and `AnthropicSdkExecutor.execute()`.

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

For `AnthropicSdkExecutor`, a deadline timestamp is checked at the start of each tool iteration loop.

**Implemented in**: `ClaudeCodeExecutor.execute()` and `AnthropicSdkExecutor.execute()`.

### ExecutorSet Routes Runtime Per Tier and Agent Type

`createExecutors(env)` builds a primary executor plus optional SDK and Claude Code executors. `EXECUTOR_DEFAULT` still chooses the primary fallback, but task execution is routed per dispatch through `OrchestratorService.routeExecutor()`.

```typescript
// src/executors/factory.ts
export interface ExecutorSet {
  primary: AgentExecutor;
  sdk: AnthropicSdkExecutor | null;
  claudeCode: ClaudeCodeExecutor;
}

export function createExecutors(env: AppEnv): ExecutorSet {
  const claudeCode = new ClaudeCodeExecutor();
  const sdk = env.ANTHROPIC_API_KEY
    ? new AnthropicSdkExecutor(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL)
    : null;
  // EXECUTOR_DEFAULT chooses primary; routeExecutor can still use sdk/claudeCode.
}
```

```typescript
// src/orchestrator/service.ts
private routeExecutor(tier: Tier, agentType: AgentType): AgentExecutor {
  const set = this.deps.executors;
  if (!set) return this.deps.executor;
  if (agentType === "planner") return set.sdk ?? set.claudeCode;
  if (agentType === "reflector") return set.sdk ?? set.claudeCode;
  if (agentType === "meta") return set.claudeCode;
  if (tier === "EXPRESS" && set.sdk) return set.sdk;
  return set.claudeCode;
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

## Core Flows

### ClaudeCodeExecutor.execute Flow

The Claude Code CLI is the default runtime. It runs in non-interactive mode.

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
  workingDirectory: string;
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
- **Configuration**: `EXECUTOR_DEFAULT` chooses the primary fallback executor, while `ExecutorSet` enables per-tier/per-agent routing; `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` configure the SDK executor; `CLAUDE_COMMAND` overrides the Claude binary path; `QMD_MCP_URL` enables QMD access for task-facing agents that receive `agentEnvironment()`.

## File Map

| File | Purpose |
|------|---------|
| `src/executors/interface.ts` | `AgentExecutor`, `AgentTask`, `AgentResult` interfaces |
| `src/executors/factory.ts` | `createExecutors(env)` — builds the primary/SDK/Claude Code executor set |
| `src/executors/claude-code.ts` | `ClaudeCodeExecutor` — spawns Claude CLI subprocess; supports MCP |
| `src/executors/anthropic-sdk.ts` | `AnthropicSdkExecutor` — Anthropic Messages API tool-use loop |
| `src/executors/mock.ts` | `MockExecutor` — deterministic responses for tests |
| `src/personas/registry.ts` | `PersonaRegistry` — resolves persona per agent type (DB-first, then file) |
| `src/personas/*.md` | Persona seed files (planner, coder, reviewer, doc, meta, reflector, diagnostician) |
| `src/skills/registry.ts` | `SkillRegistry` — maps agent types to skill file paths; snapshots to `skill_versions` |
| `skills/*.md` | Skill content files (tdd, systematic-debugging, two-stage-review, etc.) |
