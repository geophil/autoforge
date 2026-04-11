# Development Workflow

## Prerequisites

- **Bun** ≥ 1.0 (runtime, package manager, test runner)
- **TypeScript** (installed via devDependencies, no global install needed)
- **Docker + Docker Compose** (optional, for NATS)
- **Claude CLI** (`claude`) on PATH — required for `EXECUTOR_DEFAULT=claude-code` (default)
- **`gh` CLI** + `GITHUB_TOKEN` — required for real GitHub PR creation (optional for local dev)

## Setup

```bash
# Install dependencies
bun install

# Create the data directory (SQLite database goes here)
mkdir -p data
```

No `.env` file is required for local development — all env vars have sensible defaults (see `configuration.md`).

## Development

```bash
# Start the server (hot-reload not built in; restart manually)
bun run dev
# → Autoforge listening on http://127.0.0.1:3000
# → NATS: not connected (SQLite-only mode)  ← unless NATS is running

# Start with NATS via Docker Compose
docker-compose up
```

The dashboard is available at `http://localhost:3000`. Submit tasks via:

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge","description":"Add a health check endpoint"}'
```

## Testing

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/unit/state-machine.test.ts
bun test tests/integration/happy-path.test.ts

# Type-check without running (no emit)
bun run lint
```

Tests use `MockExecutor` and do not require a running Claude instance or NATS. SQLite is created in-memory per test suite via `tests/helpers/create-service.ts`.

## Building

```bash
bun build src/index.ts --outdir dist
```

Output is a single bundled JS file in `dist/`. Not required for development or Docker usage (Bun runs TypeScript directly).

## Common Tasks

### Changing the Executor

Set `EXECUTOR_DEFAULT` in your shell or a local `.env`:

```bash
# Use Anthropic API instead of Claude CLI
EXECUTOR_DEFAULT=anthropic-sdk ANTHROPIC_API_KEY=sk-ant-... bun run dev

# Use mock executor (no AI calls)
EXECUTOR_DEFAULT=mock bun run dev
```

### Adding a Skill File

Drop a `.md` file in `skills/` and register it in `src/skills/registry.ts`:

```typescript
// src/skills/registry.ts
const AGENT_SKILLS: Record<AgentType, string[]> = {
  coder: ["tdd.md", "systematic-debugging.md", "verification-before-completion.md", "your-new-skill.md"],
  // ...
};
```

### Inspecting the Event Log

```bash
# All events for a task
sqlite3 data/autoforge.sqlite \
  "SELECT timestamp, agent, event_type, status FROM events WHERE task_id = 'YOUR_TASK_ID' ORDER BY timestamp"

# All tasks and their current state
sqlite3 data/autoforge.sqlite "SELECT id, state, tier, description FROM tasks"
```

### Replaying Projections (after schema change)

```bash
curl -X POST http://localhost:3000/api/tasks/replay
# (or call OrchestratorService.replayFromEvents() directly in code)
```

### Resetting Local State

```bash
rm data/autoforge.sqlite
rm -rf .runtime-worktrees/
bun run dev  # fresh database on next start
```
