# Agent Execution

The Agent Execution domain abstracts over different AI runtimes (Claude Code CLI, Anthropic API, mock) behind a single `AgentExecutor` interface. It also manages the skill system — markdown files that encode behavioral guidelines injected into every agent prompt. The orchestrator dispatches all agent work through this domain and reads back structured results without knowing which runtime is active.

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

**Enforced in**: `src/executors/claude-code.ts:48`, `src/executors/anthropic-sdk.ts:197`

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

**Enforced in**: `src/executors/claude-code.ts:169`, `src/executors/anthropic-sdk.ts:129`

### Executor Is Selected at Startup, Not Per-Task

`createExecutor(env)` returns a single `AgentExecutor` instance for the process lifetime. The choice is made by the `EXECUTOR_DEFAULT` env var.

```typescript
// src/executors/factory.ts
export function createExecutor(env: AppEnv): AgentExecutor {
  if (env.EXECUTOR_DEFAULT === "mock")          return new MockExecutor();
  if (env.EXECUTOR_DEFAULT === "anthropic-sdk") return new AnthropicSdkExecutor(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL);
  return new ClaudeCodeExecutor(); // default: "claude-code"
}
```

**Enforced in**: `src/executors/factory.ts:7`

### Each Agent Is Composed from a Persona and Skills

Every agent receives two distinct prompt inputs resolved by the orchestrator before dispatch:

- **Persona** (`PersonaRegistry.resolve(agentType)`) — defines who the agent is and how it approaches work. Loaded from `src/personas/<type>.md` by default; can be overridden by a DB row in `skill_versions` where `skill_name = 'persona:<type>'` and `is_active = 1`. The DB-first resolution is how the meta-loop activates improved versions without touching files.
- **Skills** (`SkillRegistry.skillsForAgent(agentType)`) — technique reference files injected alongside the persona.

```typescript
// src/skills/registry.ts
const AGENT_SKILLS: Record<AgentType, string[]> = {
  planner:     ["writing-plans.md"],
  coder:       ["tdd.md", "systematic-debugging.md", "verification-before-completion.md"],
  reviewer:    ["two-stage-review.md"],
  doc:         ["documentation.md"],
  pr:          [],
  orchestrator:[],
  meta:        ["writing-skills.md"]
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

Agents run in isolated worktrees with no credentials. `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` live only in the orchestrator process. The per-task `environment` is empty (`{}`) for all agents except the planner, which receives `QMD_MCP_URL` when configured so it can query the knowledge base via MCP.

```typescript
// src/orchestrator/service.ts — planner dispatch
environment: this.deps.env.QMD_MCP_URL ? { QMD_MCP_URL: this.deps.env.QMD_MCP_URL } : {},

// all other agents
environment: {},
```

**Enforced in**: `src/orchestrator/service.ts`

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

1. **System prompt**: Persona (`task.systemPrompt`) + skills + status-reporting instructions, sent as the API `system` field.
2. **User message**: `task.prompt` — the task-specific content.
3. **Tool loop** (max 50 iterations): Calls `client.messages.create()` with `TOOLS` (read_file, write_file, list_directory, bash). Executes tool calls locally, appends results.
4. **Deadline check**: If `Date.now() >= deadlineMs` at loop start → TIMEOUT.
5. **Status read**: Same `.autoforge-status.json` convention as ClaudeCodeExecutor.
6. **Token tracking**: `totalInputTokens` and `totalOutputTokens` accumulated across all loop iterations and returned in `AgentResult.metrics`.

Note: `AnthropicSdkExecutor` does not currently support MCP — it has no HTTP MCP client. Agents needing QMD access (currently only the planner) must use `ClaudeCodeExecutor`.

Available tools for `AnthropicSdkExecutor`:
- `read_file` — read a file relative to working directory
- `write_file` — write a file, creating parent directories
- `list_directory` — list directory contents
- `bash` — run a shell command (60s timeout)

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
  };
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}
```

## Integration Points

- **Task Orchestration**: `OrchestratorService` calls `executor.execute()` for planner, coder, reviewer, doc, and meta agents. The executor instance is injected as a dependency.
- **Persona Registry**: `PersonaRegistry.resolve(agentType)` provides `systemPrompt`. DB-first resolution allows the meta-loop to activate improved personas without file changes.
- **Skills Registry**: `SkillRegistry.skillsForAgent(agentType)` resolves skill file paths; passed as `AgentTask.skillFiles`.
- **Configuration**: Executor type selected via `EXECUTOR_DEFAULT`; `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` configure the SDK executor; `CLAUDE_COMMAND` overrides the Claude binary path; `QMD_MCP_URL` enables knowledge base access for the planner.

## File Map

| File | Purpose |
|------|---------|
| `src/executors/interface.ts` | `AgentExecutor`, `AgentTask`, `AgentResult` interfaces |
| `src/executors/factory.ts` | `createExecutor(env)` — selects implementation from env |
| `src/executors/claude-code.ts` | `ClaudeCodeExecutor` — spawns Claude CLI subprocess; supports MCP |
| `src/executors/anthropic-sdk.ts` | `AnthropicSdkExecutor` — Anthropic Messages API tool-use loop |
| `src/executors/mock.ts` | `MockExecutor` — deterministic responses for tests |
| `src/personas/registry.ts` | `PersonaRegistry` — resolves persona per agent type (DB-first, then file) |
| `src/personas/*.md` | Persona seed files (planner, coder, reviewer, doc, meta) |
| `src/skills/registry.ts` | `SkillRegistry` — maps agent types to skill file paths; snapshots to `skill_versions` |
| `skills/*.md` | Skill content files (tdd, systematic-debugging, two-stage-review, etc.) |
