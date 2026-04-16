# Observability and Recovery Design

**Status**: In progress — Phase 4 of the SDK executor + failure recovery plan
**Last updated**: 2026-04-14

This document captures the assessment of autoforge's current feedback loop quality, the gaps we identified from the first self-improvement session, and the design for closing them. It is the reference for building failure analysis events, richer SQL views, and meta agent enrichment.

---

## Assessment: What we capture today

### Per-event telemetry (events table)

| Field | Captured | Notes |
|---|---|---|
| `task_id`, `agent`, `event_type`, `status` | Yes | Core event identity |
| `timestamp`, `elapsed_seconds` | Yes | Timing per step |
| `token_input`, `token_output`, `estimated_cost` | Yes | For SDK executor only; Claude Code doesn't report tokens |
| `payload` (JSON blob) | Yes | Includes `persona_version_id`, `skill_version_ids`, failure `reason` |
| `executor_used` | Yes | Column exists |
| `context_envelope_hash` | Yes (unused) | Reserved for future prompt hashing |
| Per-tool-call stats (reads, writes, iterations) | **No** | Not captured anywhere |
| Planner output quality (did it fall back?) | **No** | Always logs `planned/done` even on bad output |
| WHY the task failed (structured category) | **Partial** | `reason` string in payload, but not normalized or queryable through views |

### Materialized views

| View | What it answers | Gaps |
|---|---|---|
| `task_outcomes` | Task-level cost, timing, finding count, first-pass success | Only terminal tasks (`completed`/`failed`); no stalled tasks; no executor attribution |
| `agent_performance` | Per-persona-version first_pass_rate, avg_iterations, avg_step_cost | Excludes `executor_used`; skill version attribution missing; failure events not version-stamped; excludes stalled tasks |

### What the meta agent can see today

The meta agent queries `agent_performance` and `experiments`, then proposes a one-line change to the weakest persona. The signal it gets:

```sql
SELECT persona_name, agent_type, first_pass_rate, avg_iterations, avg_step_cost
FROM agent_performance ORDER BY first_pass_rate ASC LIMIT 10;
```

This tells it "the coder persona has 0.5 first_pass_rate" but cannot tell it:
- Was this an executor failure or a persona failure?
- Did the planner give the coder useful guidance or a generic fallback subtask?
- Did the coder read everything but never write?
- Was this a THOROUGH task that needed more budget, not a better prompt?

---

## Root cause of the feedback loop gap

**The system captures what happened but not why.** Every signal is coarsened to task-level pass/fail before the meta agent sees it. Step-level causes — executor timeouts, planner fallbacks, exploration loops, PR gate rejections — are buried in raw JSON payloads that the meta agent would have to manually SQL-extract.

The meta agent can currently improve a persona's wording. It cannot detect that the SDK executor is the problem, that the tier router is systematically over-tiering frontend tasks, or that the planner never produces structured output.

---

## What we need: failure_analysis events

Every time a task fails — for any reason — emit a structured `failure_analysis` event alongside the `state.failed` transition. This becomes the single queryable source of failure diagnostics.

### Schema

```json
{
  "stage_failed": "executing",
  "failure_reason": "stall",
  "failure_category": "executor_timeout | coder_failed | rework_limit | pr_gate | cancelled | planner_fallback",
  "executor_used": "anthropic-sdk | claude-code | mock",
  "persona_version_id": "b5b6074...",
  "skill_version_ids": ["c4d2e1..."],
  "tool_stats": {
    "read_count": 12,
    "write_count": 0,
    "bash_count": 3,
    "iterations": 23
  },
  "planner_fallback": true,
  "budget_seconds": 720,
  "elapsed_seconds": 960,
  "iteration": 0
}
```

### Failure categories

| Category | Trigger | Persona culpable? | Executor culpable? |
|---|---|---|---|
| `executor_timeout` | SDK/ClaudeCode exceeded budget | Maybe | Yes — indicates tool loop or slow API |
| `coder_failed` | Coder returned BLOCKED/NEEDS_CONTEXT | Likely | No |
| `rework_limit` | 3+ review loops, still CRITICAL findings | Likely | No |
| `pr_gate` | Tests failed or review score below threshold | Likely | No |
| `planner_fallback` | Planner output unparseable, used generic subtask | Yes (planner) | No |
| `cancelled` | Human manually cancelled | No | No |
| `stalled` | Process killed, no events past timeout | Indeterminate | Yes — likely executor |

### Tool stats attribution

For the SDK executor, track `readCount`, `writeCount`, `bashCount` across the tool loop and include in `AgentResult.metrics`. High `read_count` + zero `write_count` is the "exploration loop" signature. This is the single most diagnostic signal for SDK executor failures.

For Claude Code, tool stats are not available from the subprocess. Record `null` and note `executor_used: "claude-code"` so the absence is interpretable.

---

## Task staleness and recovery

### Current state

Tasks that stall (executor hangs, process killed) are left in intermediate states (`executing`, `planning`, `reviewing`) indefinitely. The recovery service replays events but never infers failure from age.

### Staleness sweeper design

On server startup, after `RecoveryService.recover()` completes:

1. Query all tasks in non-terminal states: `received`, `assessing`, `planning`, `executing`, `reviewing`, `reworking`
2. For each, calculate the expected max duration: `2 × budgetSeconds` for the current tier's dominant step
3. If `now - updated_at > max_duration`, emit a `failure_analysis` event with `failure_category: "stalled"` and transition to `failed`
4. Log a warning per stalled task

Stale threshold defaults:

| Tier | Max duration before stale |
|---|---|
| EXPRESS | 20 min |
| STANDARD | 40 min |
| THOROUGH | 60 min |

### cancelTask API

`OrchestratorService.cancelTask(taskId, reason)`:
- Accepts any non-terminal task
- Closes PR if one was created
- Emits `failure_analysis` with `failure_category: "cancelled"`, `failure_reason: reason`
- Transitions to `failed`
- Runs `cleanupWorktree`

Exposed as `POST /api/tasks/:id/cancel` with optional `{ "reason": "string" }` body.

---

## Richer SQL views (follow-on after SDK retest)

### failure_signals view

```sql
CREATE VIEW IF NOT EXISTS failure_signals AS
SELECT
  json_extract(e.payload, '$.failure_category') AS category,
  json_extract(e.payload, '$.executor_used')    AS executor,
  json_extract(e.payload, '$.stage_failed')     AS stage,
  json_extract(e.payload, '$.persona_version_id') AS persona_version_id,
  json_extract(e.payload, '$.planner_fallback') AS planner_fallback,
  json_extract(e.payload, '$.tool_stats')       AS tool_stats,
  t.tier,
  t.project_id,
  e.timestamp
FROM events e
JOIN tasks t ON t.id = e.task_id
WHERE e.event_type = 'failure_analysis';
```

### planner_quality view

```sql
CREATE VIEW IF NOT EXISTS planner_quality AS
SELECT
  json_extract(e.payload, '$.persona_version_id') AS persona_version_id,
  COUNT(*) AS total_plans,
  SUM(CASE WHEN json_extract(e.payload, '$.planner_fallback') = 1 THEN 1 ELSE 0 END) AS fallback_count,
  CAST(SUM(CASE WHEN json_extract(e.payload, '$.planner_fallback') = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS fallback_rate
FROM events e
WHERE e.event_type = 'failure_analysis'
  AND json_extract(e.payload, '$.persona_version_id') IS NOT NULL
GROUP BY json_extract(e.payload, '$.persona_version_id');
```

### Extend agent_performance with executor attribution

Add `executor_used` grouping so the meta agent can distinguish persona performance from executor performance:

```sql
-- Extended agent_performance with executor
SELECT
  json_extract(e.payload, '$.persona_version_id') AS persona_version_id,
  e.agent AS agent_type,
  e.executor_used,
  COUNT(DISTINCT t.id) AS task_count,
  AVG(CASE WHEN t.iteration = 0 AND t.state = 'completed' THEN 1.0 ELSE 0.0 END) AS first_pass_rate
FROM events e JOIN tasks t ON t.id = e.task_id
WHERE e.agent IN ('planner','coder','reviewer','doc')
  AND t.state IN ('completed','failed')
GROUP BY json_extract(e.payload, '$.persona_version_id'), e.agent, e.executor_used;
```

---

## Meta agent enrichment (follow-on)

Update the meta persona instructions to query failure signals in addition to agent_performance:

```bash
# Find executor-correlated failures
sqlite3 $DB "SELECT executor, category, COUNT(*) as n FROM failure_signals GROUP BY executor, category ORDER BY n DESC;"

# Find planner quality by version
sqlite3 $DB "SELECT persona_version_id, fallback_rate, total_plans FROM planner_quality ORDER BY fallback_rate DESC;"

# Distinguish persona vs executor failures
sqlite3 $DB "
  SELECT ap.persona_name, ap.first_pass_rate, 
    SUM(CASE WHEN fs.category = 'executor_timeout' THEN 1 ELSE 0 END) as executor_failures
  FROM agent_performance ap
  LEFT JOIN failure_signals fs ON fs.persona_version_id = ap.persona_version_id
  GROUP BY ap.persona_name;
"
```

The meta agent should be taught: **if executor failures outnumber coder/planner failures for a persona version, do not change the persona — flag the executor as the problem instead.**

---

## Dashboard improvements

- Show event `status` field in the timeline (green for `done`, red for `failed`, yellow for `done_with_concerns`)
- For `state.failed` and `failure_analysis` events, extract and show `failure_reason` and `failure_category` from payload
- Show cancel button for tasks in non-terminal states
- Add failure category badge to the task card in the list view

---

## Implementation sequence

1. Write this doc (done)
2. Clean up stale tasks manually in SQLite
3. Implement SDK executor fixes (Phases 1-3) — unblock first
4. Implement `cancelTask` + staleness sweeper + `failure_analysis` events (Phase 4)
5. Wire tool stats into `AgentResult` and failure events
6. Surface failure data in dashboard
7. Add `failure_signals` and `planner_quality` views to schema
8. Update meta persona to query new views
9. Retest SDK executor with improved observability
