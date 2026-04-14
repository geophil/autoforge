# Development Workflow

## Prerequisites

- **Bun** ≥ 1.0 (runtime, package manager, test runner)
- **TypeScript** (installed via devDependencies, no global install needed)
- **Docker + Docker Compose** (optional, for NATS + QMD knowledge base)
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
# → QMD: not available (planner falls back to filesystem exploration)

# Start with NATS + QMD knowledge base via Docker Compose (recommended)
docker-compose up
# → QMD embeds docs/qmd/ on first boot, re-indexes every 3 hours
# → QMD_MCP_URL=http://qmd:8181/mcp passed to planner automatically
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

### Editing a Persona

Persona seed files live in `src/personas/<type>.md`. Edit the file and restart — the change takes effect immediately for all new tasks (no DB row exists yet, so the file is used).

Once the meta-loop has activated an improved version via the DB, the file on disk becomes the fallback only. To reset to the file version, deactivate the DB row:

```bash
sqlite3 data/autoforge.sqlite \
  "UPDATE skill_versions SET is_active = 0 WHERE skill_name = 'persona:coder' AND is_active = 1;"
```

### Triggering a Meta Improvement Session

```bash
# Analyze all agents and propose the highest-impact improvement
curl -X POST http://localhost:3000/api/meta \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge"}'

# Focus on a specific persona or skill
curl -X POST http://localhost:3000/api/meta \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge","focus":"persona:coder"}'
```

The meta agent returns an `experimentId`. Run a few real tasks, then conclude the experiment:

```bash
# Keep the improvement (first_pass_rate improved from 0.6 to 0.8)
curl -X POST http://localhost:3000/api/meta/<EXPERIMENT_ID>/conclude \
  -H "Content-Type: application/json" \
  -d '{"metricAfter":0.8,"keep":true}'

# Revert — performance did not improve
curl -X POST http://localhost:3000/api/meta/<EXPERIMENT_ID>/conclude \
  -H "Content-Type: application/json" \
  -d '{"metricAfter":0.55,"keep":false}'
```

### Querying Outcome Data

```bash
# Performance by persona version
sqlite3 data/autoforge.sqlite \
  "SELECT persona_name, agent_type, task_count, first_pass_rate, avg_step_cost FROM agent_performance ORDER BY first_pass_rate ASC;"

# Per-task outcome summary
sqlite3 data/autoforge.sqlite \
  "SELECT task_id, tier, iterations, total_cost, first_pass_success FROM task_outcomes ORDER BY created_at DESC LIMIT 10;"

# Experiment history
sqlite3 data/autoforge.sqlite \
  "SELECT skill_modified, metric_before, metric_after, status FROM experiments ORDER BY created_at DESC;"
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
