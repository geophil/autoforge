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

### Skills Are Injected Per Agent Type

Each `AgentType` has a fixed list of skill filenames. The `SkillRegistry` resolves them to absolute paths, and both executors prepend their content to the prompt.

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

**Enforced in**: `src/skills/registry.ts:9`

### Agents Have No Access to Secrets

Agents run in isolated worktrees with no credentials. The `ClaudeCodeExecutor` passes `process.env` merged with per-task `environment` (which is always `{}` in current usage). `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` live only in the orchestrator process.

```typescript
// src/executors/claude-code.ts — Claude is spawned with:
{
  cwd,
  env: { ...process.env, ...env }, // task.environment is always {} today
  stdio: ["pipe", "pipe", "pipe"]
}
```

**Enforced in**: `src/executors/claude-code.ts:155`

## Core Flows

### ClaudeCodeExecutor.execute Flow

The Claude Code CLI is the default runtime. It runs in non-interactive mode.

1. **Prompt assembly**: Skills content + task prompt + status-reporting instructions are concatenated.
2. **Spawn**: `claude --print --dangerously-skip-permissions --output-format text --input-format text` is spawned; the full prompt is piped to stdin.
3. **Budget timer**: SIGTERM sent at deadline, SIGKILL after 10s grace.
4. **Status read**: `.autoforge-status.json` is read from the worktree; if absent → `DONE_WITH_CONCERNS`.
5. **Return**: `AgentResult` with status, artifacts, and elapsed time.

```typescript
// claude invocation (src/executors/claude-code.ts)
spawn(command, [
  "--print",
  "--dangerously-skip-permissions",
  "--output-format", "text",
  "--input-format", "text"
], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
```

### AnthropicSdkExecutor.execute Flow

Used when `EXECUTOR_DEFAULT=anthropic-sdk`. Runs a tool-use agentic loop against the Anthropic Messages API.

1. **System prompt**: Skills + role description + status-reporting instructions.
2. **Tool loop** (max 50 iterations): Calls `client.messages.create()` with `TOOLS` (read_file, write_file, list_directory, bash). Executes tool calls locally, appends results.
3. **Deadline check**: If `Date.now() >= deadlineMs` at loop start → TIMEOUT.
4. **Status read**: Same `.autoforge-status.json` convention as ClaudeCodeExecutor.
5. **Token tracking**: `totalInputTokens` and `totalOutputTokens` accumulated across all loop iterations.

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

- **Task Orchestration**: `OrchestratorService` calls `executor.execute()` for planner, coder, reviewer, and doc agents. The executor instance is injected as a dependency.
- **Configuration**: Executor type selected via `EXECUTOR_DEFAULT`; `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` configure the SDK executor; `CLAUDE_COMMAND` overrides the Claude binary path.
- **Skills Registry**: `SkillRegistry.skillsForAgent(agentType)` resolves skill file paths; passed as `AgentTask.skillFiles`.

## File Map

| File | Purpose |
|------|---------|
| `src/executors/interface.ts` | `AgentExecutor`, `AgentTask`, `AgentResult` interfaces |
| `src/executors/factory.ts` | `createExecutor(env)` — selects implementation from env |
| `src/executors/claude-code.ts` | `ClaudeCodeExecutor` — spawns Claude CLI subprocess |
| `src/executors/anthropic-sdk.ts` | `AnthropicSdkExecutor` — Anthropic Messages API tool-use loop |
| `src/executors/mock.ts` | `MockExecutor` — deterministic responses for tests |
| `src/skills/registry.ts` | `SkillRegistry` — maps agent types to skill file paths |
| `skills/*.md` | Skill content files (tdd, systematic-debugging, two-stage-review, etc.) |
