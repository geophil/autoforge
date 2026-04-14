# Configuration

Environment variables that control Autoforge's runtime behavior. Validated at startup via Zod in `src/config/env.ts` — the process will exit with a clear error if a required variable is missing or a value fails validation.

## Environment Variables

### `NODE_ENV`

- **Type**: `"development" | "test" | "production"`
- **Default**: `"development"`
- **Affects**: General behavior flags (logging verbosity, etc.)

### `HOST`

- **Type**: string
- **Default**: `"127.0.0.1"`
- **Affects**: HTTP server bind address. Set to `"0.0.0.0"` in Docker Compose to accept external connections.

### `PORT`

- **Type**: integer
- **Default**: `3000`
- **Affects**: `domain-web-api.md` — HTTP server port.

### `NATS_URL`

- **Type**: string
- **Default**: `"nats://127.0.0.1:4222"`
- **Affects**: `domain-event-sourcing.md` — NATS JetStream connection. If NATS is unreachable, the system runs in SQLite-only mode (warning logged, no crash).

### `DATABASE_PATH`

- **Type**: string (file path)
- **Default**: `"./data/autoforge.sqlite"`
- **Affects**: `domain-event-sourcing.md` — SQLite database location. Parent directory is created automatically.

### `EXECUTOR_DEFAULT`

- **Type**: `"claude-code" | "anthropic-sdk" | "mock"`
- **Default**: `"claude-code"`
- **Affects**: `domain-agent-execution.md` — which `AgentExecutor` implementation is used.
  - `claude-code`: spawns the Claude CLI subprocess
  - `anthropic-sdk`: uses Anthropic Messages API with tool-use loop (requires `ANTHROPIC_API_KEY`)
  - `mock`: deterministic responses, used in tests

### `EXECUTOR_TIMEOUT_SECONDS`

- **Type**: integer
- **Default**: `300`
- **Affects**: `domain-agent-execution.md` — fallback global timeout. Per-agent budgets from `budgetForTier()` take precedence when dispatched.

### `TEST_PASS_THRESHOLD`

- **Type**: float (0–1)
- **Default**: `1.0`
- **Affects**: `domain-pr-gate.md` — loaded into env but the gate currently hardcodes `passRate < 1` as the rejection condition. Reserved for future configurable partial-pass tolerance.

### `REVIEW_SCORE_THRESHOLD`

- **Type**: float (0–1)
- **Default**: `0.7`
- **Affects**: `domain-pr-gate.md` — minimum review score to pass the PR gate. Review score is computed as `1.0` (no unresolved findings) or `0.5` (any unresolved findings). At the default threshold of 0.7, any unresolved finding blocks the PR.

### `GITHUB_TOKEN`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-pr-gate.md` — required for real GitHub PR creation, merge, and close via `gh` CLI. If unset, `createPullRequest` returns a placeholder URL and logs a warning. **Never passed to agent executors.**

### `CLAUDE_COMMAND`

- **Type**: string
- **Default**: `"claude"`
- **Affects**: `domain-agent-execution.md` / `ClaudeCodeExecutor` — override if the Claude binary is not on `PATH` (e.g. `/usr/local/bin/claude`).

### `SKILLS_DIR`

- **Type**: string (directory path)
- **Default**: `"./skills"`
- **Affects**: `domain-agent-execution.md` / `SkillRegistry` — root directory for skill markdown files. The registry resolves filenames relative to this path.

### `ANTHROPIC_API_KEY`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-agent-execution.md` / `AnthropicSdkExecutor` — required when `EXECUTOR_DEFAULT=anthropic-sdk`. **Never passed to Claude Code agent subprocess.**

### `ANTHROPIC_MODEL`

- **Type**: string
- **Default**: `"claude-sonnet-4-6"`
- **Affects**: `domain-agent-execution.md` / `AnthropicSdkExecutor` — model ID used for API calls.

### `QMD_MCP_URL`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-agent-execution.md` — when set, the planner agent receives this URL as an environment variable and `ClaudeCodeExecutor` writes a temporary `--mcp-config` file so the planner can call QMD MCP tools (`query`, `get`, `multi_get`, `status`) to retrieve architecture context before planning. Set automatically to `http://qmd:8181/mcp` when running via Docker Compose.

## Configuration File

All variables are parsed by `loadEnv()` in `src/config/env.ts`:

```typescript
// src/config/env.ts
const EnvSchema = z.object({
  NODE_ENV:                 z.enum(["development", "test", "production"]).default("development"),
  HOST:                     z.string().default("127.0.0.1"),
  PORT:                     z.coerce.number().int().positive().default(3000),
  NATS_URL:                 z.string().default("nats://127.0.0.1:4222"),
  DATABASE_PATH:            z.string().default("./data/autoforge.sqlite"),
  EXECUTOR_DEFAULT:         z.string().default("claude-code"),
  EXECUTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEST_PASS_THRESHOLD:      z.coerce.number().min(0).max(1).default(1),
  REVIEW_SCORE_THRESHOLD:   z.coerce.number().min(0).max(1).default(0.7),
  GITHUB_TOKEN:             z.string().optional(),
  CLAUDE_COMMAND:           z.string().default("claude"),
  SKILLS_DIR:               z.string().default("./skills"),
  ANTHROPIC_API_KEY:        z.string().optional(),
  ANTHROPIC_MODEL:          z.string().default("claude-sonnet-4-6"),
  QMD_MCP_URL:              z.string().optional()
});
```

## Docker Compose Defaults

The `docker-compose.yml` sets the following overrides for the `autoforge` service. Three services run: `nats` (JetStream), `qmd` (knowledge base MCP server on port 8181), and `autoforge`.

```yaml
environment:
  - NATS_URL=nats://nats:4222
  - DATABASE_PATH=/app/data/autoforge.sqlite
  - HOST=0.0.0.0
  - PORT=3000
  - EXECUTOR_DEFAULT=claude-code
  - QMD_MCP_URL=http://qmd:8181/mcp
```

`autoforge` waits for `qmd` to pass its health check before starting, ensuring the knowledge base is indexed before the first task is planned.
