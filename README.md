# Autoforge

Autonomous software engineering pipeline with self-improving agent personas and skills.

## Pipeline

- Submit task via web UI or API
- Lead agent (planner) decomposes into subtasks and assigns specialist types
- Specialist agents (coder, reviewer, doc) execute using composed personas + skills
- Review/rework loop with PR gate
- Human approval via web UI or API
- Meta agent loop: analyze outcomes, propose persona/skill improvements, measure, keep or revert

## Architecture

Every agent — planner, coder, reviewer, doc, meta — is composed the same way:
`persona(type) + skills(type) + task_context`, resolved through `PersonaRegistry` and `SkillRegistry`,
dispatched through `AgentExecutor`. Personas and skills are versioned in `skill_versions` and
improved autonomously through measured experimentation recorded in the `experiments` table.

## Run locally

```bash
bun install
bun test
bun run dev
```

With QMD knowledge base (recommended):

```bash
docker compose up
```

Open `http://127.0.0.1:3000` for the dashboard.

## API quickstart

Create task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge","description":"Add a hello world endpoint"}'
```

Approve task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/approve
```

Reject task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/reject \
  -H "Content-Type: application/json" \
  -d '{"reason":"Needs follow-up changes"}'
```

Retry paused task from a checkpoint:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/retry \
  -H "Content-Type: application/json" \
  -d '{"fromStage":"planning","checkpointId":"<CHECKPOINT_ID>","operatorNote":"Retry with narrower scope"}'
```

Queue steering for next attempt:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/steer \
  -H "Content-Type: application/json" \
  -d '{"message":"Prefer a minimal patch and keep API surface unchanged."}'
```

Trigger a meta agent improvement session:

```bash
curl -X POST http://127.0.0.1:3000/api/meta \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge","focus":"persona:coder"}'
```

Conclude an experiment after observing canary outcomes:

```bash
curl -X POST http://127.0.0.1:3000/api/meta/<EXPERIMENT_ID>/conclude \
  -H "Content-Type: application/json" \
  -d '{"metricAfter":0.8,"keep":true}'
```

## Observability

Query outcome data directly from SQLite:

```bash
# Which persona version performs best per agent type?
sqlite3 data/autoforge.sqlite "SELECT persona_name, agent_type, task_count, first_pass_rate, avg_iterations, avg_step_cost FROM agent_performance ORDER BY first_pass_rate DESC;"

# Per-task cost and quality summary
sqlite3 data/autoforge.sqlite "SELECT task_id, tier, iterations, total_cost, first_pass_success FROM task_outcomes ORDER BY created_at DESC LIMIT 20;"

# Experiment history
sqlite3 data/autoforge.sqlite "SELECT skill_modified, metric_before, metric_after, status, hypothesis FROM experiments ORDER BY created_at DESC;"
```

## Deferred improvements

The following are explicitly deferred until the core improvement loop proves itself in practice:

- **Doc freshness tracking** — correlate QMD doc staleness with task outcomes; prioritize doc updates by measurable pipeline impact
- **Context provenance** — capture which QMD docs the planner consulted per task and include in event payloads
- **QMD access for coder/meta agents** — currently only the planner receives `QMD_MCP_URL`; coder and meta agents would benefit from architecture context
- **Finding attribution by skill domain** — tag review findings with the skill domain responsible (tdd, debugging, verification) for finer-grained improvement signals
- **Routing calibration feedback** — write to the `routing_calibration` table after each task to detect systematic tier assignment bias
- **Autonomous multi-iteration improvement** — chain multiple meta agent sessions; currently each session runs once and requires human review of the scoreboard
- **Canary routing in SkillRegistry** — automatic A/B routing of tasks to different skill versions by experiment; currently managed manually via the `is_active` flag
