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

- **Type**: `"harness" | "mock"`
- **Default**: `"harness"`
- **Affects**: `domain-agent-execution.md` — selects the single runtime path used for real dispatches.
  - `harness`: runs `HarnessExecutor` with `AnthropicProvider` + `RuntimeToolRegistry`
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

### `SKILLS_DIR`

- **Type**: string (directory path)
- **Default**: `"./skills"`
- **Affects**: `domain-agent-execution.md` / `SkillRegistry` — root directory for skill markdown files. The registry resolves filenames relative to this path.

### `ANTHROPIC_API_KEY`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-agent-execution.md` / `AnthropicProvider` — required for `EXECUTOR_DEFAULT=harness` so the harness runtime can call Anthropic models. **Never passed to agent subprocess tools.**

### `ANTHROPIC_MODEL`

- **Type**: string
- **Default**: `"claude-sonnet-4-6"`
- **Affects**: `domain-agent-execution.md` / `HarnessExecutor` — default model ID for harness provider calls.

### `OPENAI_API_KEY`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-task-orchestration.md` / `src/orchestrator/embedding.ts` — required only when `EMBEDDING_PROVIDER=openai`. Used by the orchestrator to embed task descriptions and variant specialties for dispatch eligibility. **Never passed to agent executors.**

### `EMBEDDING_PROVIDER`

- **Type**: `"deterministic" | "openai"`
- **Default**: `"deterministic"`
- **Affects**: `domain-task-orchestration.md` — selects the specialty embedding backend used by `filterSpecialtyEligible()` and the `skill_versions.specialty_embedding` backfill path.

### `EMBEDDING_MODEL`

- **Type**: string
- **Default**: `"text-embedding-3-small"`
- **Affects**: `domain-task-orchestration.md` — OpenAI embedding model name used when `EMBEDDING_PROVIDER=openai`.

### `QMD_MCP_URL`

- **Type**: string (optional)
- **Default**: unset
- **Affects**: `domain-agent-execution.md` — when set, `OrchestratorService.agentEnvironment()` forwards this non-secret URL to task-facing planner/coder/reviewer/doc/doc-review runs. The harness `exec` tool can use it to reach QMD MCP-backed flows where configured. Set automatically to `http://qmd:8181/mcp` when running via Docker Compose.

### `WORKSPACE_PROVIDER`

- **Type**: `"local"` or `"docker"`
- **Default**: `"local"`
- **Affects**: Agent workspace isolation. `local` runs agent tools directly in the task worktree, matching legacy behavior. `docker` creates one local Docker container per agent dispatch and mounts the task worktree at `/workspace`.
- **Rollback**: Set `WORKSPACE_PROVIDER=local` and restart Autoforge.

### `WORKSPACE_DOCKER_IMAGE`

- **Type**: string
- **Default**: `"autoforge-agent:local"`
- **Affects**: Docker image used when `WORKSPACE_PROVIDER=docker`. The default tag is built by `bun run image:agent` from `docker/autoforge-agent/Dockerfile`. Custom images must contain `bun` and `git` on PATH and a user matching `WORKSPACE_DOCKER_UID` / `WORKSPACE_DOCKER_GID`.

### `WORKSPACE_DOCKER_NETWORK`

- **Type**: string
- **Default**: `"none"`
- **Affects**: Docker network mode for agent containers. Use `"none"` for maximum local isolation; use a named network only when agents must reach local services.

### `WORKSPACE_DOCKER_CPUS`

- **Type**: string
- **Default**: `"2"`
- **Affects**: Docker CPU limit passed to `docker create --cpus`.

### `WORKSPACE_DOCKER_MEMORY`

- **Type**: string
- **Default**: `"2g"`
- **Affects**: Docker memory limit passed to `docker create --memory`.

### `WORKSPACE_DOCKER_PRECHECK`

- **Type**: `"0"` or `"1"`
- **Default**: `"1"`
- **Affects**: Whether Autoforge verifies Docker daemon and image availability before creating the first Docker workspace.

### `WORKSPACE_DOCKER_UID`

- **Type**: integer (≥0)
- **Default**: `1000`
- **Affects**: The numeric uid passed to `docker create -u <uid>:<gid>`. Must exist as a user inside `WORKSPACE_DOCKER_IMAGE`. Defaults match the `agent` user baked into `docker/autoforge-agent/Dockerfile`. Override only when running a custom image whose user has a different uid (note: the host user's uid is intentionally NOT used — most images do not have a matching `/etc/passwd` entry, which breaks many tools).

### `WORKSPACE_DOCKER_GID`

- **Type**: integer (≥0)
- **Default**: `1000`
- **Affects**: The numeric gid passed alongside `WORKSPACE_DOCKER_UID`. Must exist as a group inside `WORKSPACE_DOCKER_IMAGE`.

### `AUTOFORGE_URL`

- **Type**: string (CLI environment variable, not validated by `loadEnv()`)
- **Default**: `"http://127.0.0.1:3000"`
- **Affects**: `src/cli/index.ts` — base URL used by CLI commands such as `autoforge experiments list-pending`, `autoforge experiments approve-fork`, and `autoforge experiments reject-fork`.

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
  EXECUTOR_DEFAULT:         z.enum(["harness", "mock"]).default("harness"),
  EXECUTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEST_PASS_THRESHOLD:      z.coerce.number().min(0).max(1).default(1),
  REVIEW_SCORE_THRESHOLD:   z.coerce.number().min(0).max(1).default(0.7),
  GITHUB_TOKEN:             z.string().optional(),
  SKILLS_DIR:               z.string().default("./skills"),
  ANTHROPIC_API_KEY:        z.string().optional(),
  ANTHROPIC_MODEL:          z.string().default("claude-sonnet-4-6"),
  OPENAI_API_KEY:           z.string().optional(),
  EMBEDDING_PROVIDER:       z.enum(["deterministic", "openai"]).default("deterministic"),
  EMBEDDING_MODEL:          z.string().default("text-embedding-3-small"),
  QMD_MCP_URL:              z.string().optional(),
  PLANNER_MODEL_COMPLEX:    z.string().default("claude-opus-4-7"),
  PLANNER_MODEL_EXPRESS:    z.string().default("claude-sonnet-4-6"),
  PLANNER_MAX_ITERATIONS:   z.coerce.number().int().min(0).max(10).default(3)
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
  - EXECUTOR_DEFAULT=harness
  - QMD_MCP_URL=http://qmd:8181/mcp
```

`autoforge` waits for `qmd` to pass its health check before starting, ensuring the knowledge base is indexed before task-facing agents query it.
