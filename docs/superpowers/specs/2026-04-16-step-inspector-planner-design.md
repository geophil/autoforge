# Step Inspector — Planner Stage (v1)

**Status:** Design, approved for implementation planning
**Date:** 2026-04-16
**Scope:** Autoforge planner stage only. Other stages (coder, reviewer, doc, meta) are explicitly out of scope for v1.

---

## Problem

Today the planner runs as an opaque step inside `OrchestratorService.submitTask`. We capture a `planned` event with token counts and elapsed time, but we do not capture:

- The composed system prompt the planner received (persona + skills + status-reporting block).
- The user prompt (task description + complexity signals).
- The turn-by-turn transcript — model responses, tool calls, tool results — that produced the plan.
- Any structured view of the plan itself beyond a bare list of subtask descriptions.

As a result, when a plan looks wrong, there is no way to understand why it came out that way, and no way to influence it short of cancelling the task and rewording the original description.

## Goals

1. **Visibility** — For each planner run, persist and render the full I/O so a human can inspect what was sent and what came back.
2. **Interactive plan review** — Pause the pipeline after planning (for complex tiers by default), show the produced plan, and let a human approve or critique it.
3. **Natural-language critique loop** — Critique re-runs the planner with the original prompt plus the prior plan plus the human's feedback, up to a bounded number of rounds.

## Non-goals (v1)

- Transcript capture for coder, reviewer, doc, or meta stages.
- Direct editing of subtasks from the UI.
- Diff view between plan attempts.
- Transcript search or filter.
- Any changes to the Prompt Efficiency workstream (caching, batching, compaction tuning). Addressed in a separate spec.

---

## Key decisions

| Area | Decision |
|---|---|
| Scope | Planner stage only |
| Capture depth | Full turn-by-turn transcript where available (SDK); prompts + output only where opaque (Claude Code) |
| Interaction model | Human sees the produced plan; leaves natural-language critique; planner re-runs with original prompt + prior plan + critique |
| Pause policy | Tier-based (STANDARD/THOROUGH pause; EXPRESS does not) with per-task override on submission |
| Storage | New `agent_transcripts` table in SQLite, TEXT columns, JSONL for turn-by-turn |
| Executor | Planner routes to SDK executor always; QMD MCP is wired into the SDK executor; model is chosen per run: Opus for STANDARD/THOROUGH, Sonnet for EXPRESS |
| Iteration limit | Max 3 re-plan rounds per task (4 planner runs total) |
| Recovery | `awaiting_plan_approval` exempt from staleness sweeper, same as `awaiting_approval` |

---

## Design

### A. Data capture

New table, additive — no changes to existing tables.

```sql
CREATE TABLE IF NOT EXISTS agent_transcripts (
  id              TEXT PRIMARY KEY,                -- uuid
  task_id         TEXT NOT NULL,
  stage           TEXT NOT NULL,                   -- 'planner' in v1; reserved for other stages
  attempt         INTEGER NOT NULL,                -- 0 on first run, 1+ on re-plans
  created_at      TEXT NOT NULL,
  executor_used   TEXT NOT NULL,                   -- 'anthropic-sdk' | 'claude-code'
  model           TEXT,                            -- e.g. 'claude-opus-4-...'
  system_prompt   TEXT NOT NULL,                   -- composed persona + skills + status-reporting
  user_prompt     TEXT NOT NULL,                   -- task description, complexity signals, (on re-runs) prior plan + critique
  transcript      TEXT NOT NULL,                   -- JSONL: assistant turns, tool_use, tool_result, compaction markers
  output          TEXT,                            -- parsed .autoforge-status.json
  critique        TEXT,                            -- human critique that triggered THIS attempt (NULL for attempt 0)
  token_input     INTEGER,
  token_output    INTEGER,
  elapsed_seconds REAL,
  UNIQUE(task_id, stage, attempt)
);
CREATE INDEX idx_agent_transcripts_task ON agent_transcripts(task_id, stage, attempt);
```

**Transcript JSONL entries:**

```
{"kind":"assistant","content":[...raw anthropic content blocks...]}
{"kind":"tool_result","toolUseId":"toolu_abc","content":"..."}
{"kind":"compaction","droppedTurns":8}
```

`mcp_tool_use` blocks from QMD appear inside the `assistant` content array — we record them verbatim without running them locally.

**Write path:**

1. `AnthropicSdkExecutor.execute` returns an `AgentResult` with an optional `transcript` field (see section D.3).
2. `OrchestratorService` inserts the transcript row immediately after the planner call, before emitting the `planned` event.
3. The `planned` event payload gains a `transcript_id` pointer so the dashboard can lazy-load full transcript data.

**Size:** a typical planner run with ~20 tool calls reads in the 30–150 KB range. SQLite handles this fine; the operational rule is never to `SELECT *` from `agent_transcripts` in the task list path.

### B. Planner re-plan loop

#### New states

```
planning → awaiting_plan_approval                    (first planner run completes)
awaiting_plan_approval → executing                   (human approves)
awaiting_plan_approval → replanning                  (human critiques)
awaiting_plan_approval → failed                      (cancel)
replanning → awaiting_plan_approval                  (re-plan completes)
replanning → failed                                  (planner errored OR iteration limit exceeded)
```

#### New events

- `plan_approved` — human accepted the plan; orchestrator resumes execution.
- `plan_critiqued` — human submitted a critique; payload carries `critique_text` and the `transcript_id` of the plan that was critiqued.
- Existing `planned` event fires once per attempt (attempt 0, 1, 2, …) carrying the new `transcript_id`.

#### Re-plan prompt composition

On attempt `N ≥ 1`, the user prompt sent to the planner is:

```
## Task
<original description>

## Complexity signals
Tier: <tier> | Scope: <...> | Risk: <...> | Coupling: <...>

## Prior plan (attempt N-1)
<JSON serialization of prior subtasks>

## Human feedback on prior plan
<critique text>

## Instructions
Revise the plan to address the feedback. Prefer minimal changes — keep subtasks
that were not critiqued, unless the feedback implies they should change.
```

The system prompt is identical across attempts — only the user prompt changes.

#### Iteration limit

- Max **3 re-plan rounds**, configurable via `PLANNER_MAX_ITERATIONS` (default 3). The initial plan (attempt 0) plus 3 revisions (attempts 1, 2, 3) = up to 4 planner runs per task.
- The `attempt` column is 0-indexed internally. The UI displays it 1-indexed as "plan #1 of 4" through "plan #4 of 4" for human readability.
- A critique POSTed when `attempt === PLANNER_MAX_ITERATIONS` (already on the last allowed attempt) returns HTTP 409 with a message instructing the user to approve, cancel, or start a new task. No silent failure.
- Mirrors the existing rework iteration limit in `executeAndReview`.

#### Payload shapes

```
POST /api/tasks/:id/approve-plan
Body: {}

POST /api/tasks/:id/critique-plan
Body: { "critique": string }            // min 1, max ~4000 characters
```

### C. Orchestrator & API

#### `submitTask` returns earlier

Today `submitTask` blocks until `awaiting_approval` (end of pipeline). With plan review, it returns as soon as the first plan is ready and we are in `awaiting_plan_approval`. For EXPRESS tasks (or when the per-task override skips plan review), behavior is unchanged — it runs end-to-end.

The frontend dashboard is already SSE-driven and does not depend on the return point; it renders the task card from `task.updated` events.

#### Split orchestrator entry points

```ts
submitTask(projectId, description, opts?: { reviewPlan?: boolean }): Promise<PipelineTask>
  // assessment → worktree → planner run → write transcript → emit `planned`
  // if pausePolicy(tier, opts.reviewPlan) is true: transition to awaiting_plan_approval, return
  // otherwise continue into executeAndReview + tests + PR gate (existing behavior)

critiquePlan(taskId, critique): Promise<PipelineTask>
  // append `plan_critiqued` → transition to replanning → planner run (attempt N+1)
  //   → write transcript → emit `planned` → transition back to awaiting_plan_approval
  // enforces PLANNER_MAX_ITERATIONS

approvePlan(taskId): Promise<PipelineTask>
  // append `plan_approved` → transition to executing → call existing executeAndReview
  // then tests + PR gate + awaiting_approval (existing tail)
```

The end-of-pipeline `approveTask` and `rejectTask` are unchanged — they still gate PR merge.

#### New HTTP endpoints

```
POST /api/tasks
  Body: { projectId, description, reviewPlan?: boolean }
  Returns when the first plan is ready (STANDARD/THOROUGH + review on), or end-to-end (EXPRESS / review off)

POST /api/tasks/:id/approve-plan
  Body: {}

POST /api/tasks/:id/critique-plan
  Body: { critique: string }

GET  /api/tasks/:id/transcripts
  Returns [{ id, stage, attempt, createdAt, model, executor, tokenInput, tokenOutput, elapsedSeconds }]
  Lightweight metadata only — no blob columns.

GET  /api/transcripts/:id
  Returns full row including system_prompt, user_prompt, transcript, output, critique.
  Heavy; called only when the UI opens a drill-down.
```

#### Pause policy function

```ts
pausePolicy(tier: Tier, reviewPlanOverride?: boolean): boolean {
  if (reviewPlanOverride !== undefined) return reviewPlanOverride;
  return tier === "STANDARD" || tier === "THOROUGH";
}
```

#### Recovery & staleness

- `awaiting_plan_approval` is a "wait" state with no in-flight work. Orchestrator crash during this state is harmless — recovery just keeps it where it is.
- `awaiting_plan_approval` is **exempt** from the staleness sweeper, same as `awaiting_approval`. Add it to the non-terminal-but-not-stale list.
- `replanning` is a transient state (active planner call). Its staleness threshold matches the tier's planner budget (same treatment as `planning`).

### D. Executor changes

#### D.1 — Per-run model override

The SDK executor currently bakes `model` into the constructor. We keep the constructor default but let `AgentTask` override per run.

```ts
interface AgentTask {
  // ... existing fields ...
  model?: string;   // optional per-run override
}
```

In the executor:

```ts
model: task.model ?? this.defaultModel
```

Orchestrator chooses model for the planner:

```ts
private plannerModel(tier: Tier): string {
  if (tier === "EXPRESS") return this.deps.env.PLANNER_MODEL_EXPRESS; // default: sonnet
  return this.deps.env.PLANNER_MODEL_COMPLEX;                          // default: opus
}
```

New environment variables with sensible defaults:

- `PLANNER_MODEL_COMPLEX` — default Opus (exact model ID pinned during implementation based on the latest available release).
- `PLANNER_MODEL_EXPRESS` — default Sonnet (exact model ID pinned during implementation).

This keeps model selection auditable without a code change and avoids spinning up multiple executor instances.

#### D.2 — QMD MCP wired into the SDK executor

When `task.environment.QMD_MCP_URL` is set, include `mcp_servers` in the `messages.create` call:

```ts
const mcpServers = task.environment.QMD_MCP_URL
  ? [{ type: "url", url: task.environment.QMD_MCP_URL, name: "qmd" }]
  : undefined;

const response = await client.messages.create({
  model: task.model ?? this.defaultModel,
  max_tokens: 8192,
  system: systemPrompt,
  tools: TOOLS,
  mcp_servers: mcpServers,
  messages
}, { timeout: ..., signal: ... });
```

Anthropic executes the MCP tool calls server-side, so local `executeTool` is untouched. MCP tool uses appear as `mcp_tool_use` blocks inside `response.content`; we record them in the transcript but they do not contribute to local `toolStats`.

MCP call cost is included in the usage totals the API returns, which already flow into `token_input` / `token_output`.

#### D.3 — Transcript capture in SDK executor

```ts
interface AgentResult {
  // ... existing fields ...
  transcript?: {
    systemPrompt: string;
    userPrompt: string;
    turns: AgentTranscriptTurn[];
  };
}

type AgentTranscriptTurn =
  | { kind: "assistant";   content: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "compaction";  droppedTurns: number };
```

The SDK executor builds `turns` as it runs, mirroring its existing `messages` array. When the iteration-20 compaction runs, it emits a `compaction` marker. Claude Code executor returns `transcript: undefined` (or a stub) so the orchestrator's persistence path is uniform.

#### D.4 — Routing change

`routeExecutor` updates:

```ts
if (agentType === "planner") return set.sdk ?? set.claudeCode;
if (agentType === "meta")    return set.claudeCode;
if (tier === "EXPRESS" && set.sdk) return set.sdk;
return set.claudeCode;
```

The `?? set.claudeCode` fallback preserves local-dev setups without `ANTHROPIC_API_KEY`.

#### D.5 — Cost visibility

Opus on the planner, called up to 4 times per THOROUGH task with a full tool loop, is meaningfully more expensive than Sonnet. The existing `events.estimated_cost` column is written today for SDK runs and rendered in the dashboard event list; those paths cover this case without change. The Metrics view should continue to aggregate by task and show total cost — no additional telemetry required for v1, but this is a watch item.

### E. Dashboard UX

#### E.1 — Plan Review Panel

When `task.state === "awaiting_plan_approval"`, the task detail view renders a Plan Review Panel above the event log:

- Plan header shows `plan #(attempt+1) of (PLANNER_MAX_ITERATIONS+1)` (e.g. "plan #2 of 4") and a "View transcript →" link.
- Subtask list shows, for each subtask: sequence, agent type, description, `filesInScope`, and **`testCriteria`** (which are not shown today).
- If `attempt > 0`, the prior critique is rendered inline above the critique box so the human can see their own feedback from the last round.
- Critique textarea, plus buttons:
  - **Approve & Continue** — always enabled. POSTs `/approve-plan`.
  - **Revise Plan** — enabled only when the critique textarea is non-empty and `attempt < PLANNER_MAX_ITERATIONS`. POSTs `/critique-plan`.
  - **Cancel Task** — POSTs `/cancel` (existing).
- When `attempt === PLANNER_MAX_ITERATIONS` (the last allowed attempt), the Revise Plan button is disabled with tooltip `"Re-plan limit reached — approve or cancel."`

#### E.2 — Step drill-down (transcript viewer)

Two entry points:

1. "View transcript →" on the Plan Review Panel.
2. Clicking a `planned` event in the Pipeline Event Log.

Layout: single detail pane with four tabs:

- **System Prompt** — composed persona + skills + status-reporting block. Monospace, read-only.
- **User Prompt** — the first user message. On re-runs, includes the prior-plan JSON and the critique.
- **Transcript** — vertical turn-by-turn list:
  - Assistant text rendered plain.
  - `tool_use` blocks as collapsible cards: tool name + input args.
  - `tool_result` blocks collapsed by default (they can be large).
  - `mcp_tool_use` blocks distinguished with a `qmd` badge.
  - `compaction` markers render as a divider: `— history compacted (N turns dropped) —`.
- **Output** — pretty-printed `.autoforge-status.json` with subtasks highlighted.

Header shows: attempt number, model, executor, tokens in/out, elapsed, estimated cost.

#### E.3 — Task list & SSE

- Task list card: `awaiting_plan_approval` gets a distinct state badge (yellow-ish) from `awaiting_approval` (green-ish), and the card meta shows `plan #N` when `N > 1`.
- SSE: `task.updated` continues to fire on plan approve/critique. No new client event type.

#### E.4 — UX out of scope for v1

- No direct subtask editing in the UI.
- No side-by-side diff between plan attempts.
- No transcript search or filter.
- No drill-down for non-planner stages. Coder/reviewer/doc/meta events are unchanged in the timeline.

---

## Migration & rollout

- Schema change is additive (new table). Existing events table and projections are untouched.
- New env vars have defaults; no required configuration change for existing deployments.
- If `ANTHROPIC_API_KEY` is unset and SDK executor is unavailable, planner falls back to Claude Code and transcripts store prompts + output only. `awaiting_plan_approval` still works because the plan artifact (subtasks + test criteria) is populated from the status file either way.
- No backfill of historical tasks. Transcripts begin with the first task submitted after deploy.

## Testing strategy

- Unit: `pausePolicy`, `plannerModel`, re-plan prompt composition, iteration-limit enforcement, transcript JSONL serialization.
- Integration: end-to-end test with the mock executor covering: EXPRESS no-pause path, STANDARD pause + approve path, STANDARD pause + critique + approve path, STANDARD pause + 3-critique limit path.
- API: route tests for `/approve-plan`, `/critique-plan`, `/transcripts`, `/transcripts/:id`.
- SDK executor: mocked `messages.create` asserting `mcp_servers` wiring and `model` override; transcript turns captured in order; compaction marker emitted at iteration 20.

## Risks & open questions

- **Opus cost on rework-heavy tasks.** Mitigation: cost is surfaced in the existing events/metrics paths; re-plan cap of 3 bounds the blast radius; we can tune `PLANNER_MODEL_COMPLEX` via env without a deploy.
- **MCP server-side tool failures.** If QMD MCP is misconfigured the planner degrades to local filesystem search. Worth adding a warning in the transcript when an `mcp_tool_use` block has an error, so the human sees why the planner fell back.
- **Iteration counter vs. rework iteration.** The existing `iteration` field on `PipelineTask` counts PR-gate reworks, not plan revisions. Plan attempts are a separate counter derived from `COUNT(*)` in `agent_transcripts` for the task. This keeps the two concepts cleanly separated.
- **Legacy consumers of `POST /api/tasks`.** Any script expecting the old end-state response will now see `awaiting_plan_approval` for STANDARD/THOROUGH. The dashboard is fine. If CLI scripts exist, they must poll.

## Follow-ups (separate specs)

- Step Inspector for coder / reviewer / doc / meta — requires either parsing `claude --output-format stream-json` output or routing more stages to the SDK executor.
- Plan diff view between attempts.
- Direct subtask editing from the UI.
- Prompt Efficiency pass — `cache_control` on the system prompt, conversation-history compaction tuning, batching opportunities. Benefits from the transcript persistence added here.
