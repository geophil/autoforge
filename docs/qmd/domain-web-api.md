# Web API and Dashboard

The Web API domain exposes Autoforge's functionality over HTTP using the Hono framework. It provides REST endpoints for task submission, approval/rejection, meta-loop control, and metrics, plus a Server-Sent Events (SSE) stream for real-time dashboard updates. The dashboard is a static HTML page (`src/web/public/index.html`) with client-side JavaScript (`src/web/public/dashboard.js`) served as static assets under `/static/`.

## Business Rules and Invariants

### Task Submission Requires `projectId` and `description`

Both fields are validated via Zod at the route layer before reaching the orchestrator.

```typescript
// src/web/routes/tasks.ts
const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1)
});
```

**Enforced in**: `src/web/routes/tasks.ts:6`

### Rejection Requires a Reason and Supports Structured Feedback

The reject endpoint validates a non-empty `reason` string (required, no default) plus optional `guidance` text and structured `categories` for operator feedback.

```typescript
// src/web/routes/approvals.ts
const RejectionCategoryEnum = z.enum([
  "stale_base", "wrong_scope", "incomplete",
  "incorrect_output", "quality_issues", "other"
]);

const RejectSchema = z.object({
  reason: z.string().min(1),
  guidance: z.string().optional(),
  categories: z.array(RejectionCategoryEnum).optional()
});
```

**Enforced in**: `src/web/routes/approvals.ts:6`

### SSE Stream Stays Alive with 15-Second Heartbeats

To prevent proxy and browser connection timeouts, a `heartbeat` event is sent every 15 seconds.

```typescript
// src/web/server.ts
while (true) {
  await Bun.sleep(15_000);
  await stream.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
}
```

**Enforced in**: `src/web/server.ts:66`

### Live Events Are Fan-Out via In-Memory Hub

`LiveEventHub` maintains a `Set` of listeners. `publish()` serializes to SSE format and delivers to all connected clients synchronously. No persistence — clients joining after an event miss it.

```typescript
// src/web/events.ts
publish(event: { type: string; data: unknown }): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const listener of this.listeners) {
    listener(payload);
  }
}
```

**Enforced in**: `src/web/events.ts:11`

## API Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `GET`  | `/` | `server.ts` | Static HTML dashboard (`src/web/public/index.html`) |
| `GET`  | `/api/health` | `server.ts` | Health check — returns `{ status, uptime }` |
| `GET`  | `/api/config` | `server.ts` | Dashboard config: `{ plannerMaxIterations, plannerSpecMaxIterations }` |
| `GET`  | `/api/runtime` | `server.ts` | Runtime readiness for the dashboard: QMD MCP probe plus workspace/container mode |
| `POST` | `/api/tasks` | `tasks.ts` | Submit a new task; returns the task object directly |
| `GET`  | `/api/tasks` | `tasks.ts` | List tasks; supports `archived=true` and `includeArchived=true` |
| `GET`  | `/api/tasks/:id` | `tasks.ts` | Get single task |
| `GET`  | `/api/tasks/:id/events` | `tasks.ts` | Task event log (ordered by timestamp) |
| `POST` | `/api/tasks/:id/archive` | `tasks.ts` | Archive a terminal task; returns the task object directly |
| `POST` | `/api/tasks/:id/unarchive` | `tasks.ts` | Restore an archived task; returns the task object directly |
| `DELETE` | `/api/tasks/:id` | `tasks.ts` | Permanently delete an archived task |
| `POST` | `/api/tasks/:id/approve` | `approvals.ts` | Approve awaiting task; returns the task object directly |
| `POST` | `/api/tasks/:id/reject` | `approvals.ts` | Reject awaiting task with reason; returns the **new restart task** directly |
| `POST` | `/api/tasks/:id/cancel` | `approvals.ts` | Cancel a task; returns the task object directly |
| `POST` | `/api/tasks/:id/approve-spec` | `approvals.ts` | Approve discovery/spec for a task paused in `awaiting_spec_approval`; resumes planner in `execution_plan` phase |
| `POST` | `/api/tasks/:id/critique-spec` | `approvals.ts` | Submit critique (or answer to a blocking question) and rerun the spec-phase planner. Capped by `PLANNER_SPEC_MAX_ITERATIONS` |
| `POST` | `/api/tasks/:id/approve-plan` | `approvals.ts` | Approve a task paused in `awaiting_plan_approval` |
| `POST` | `/api/tasks/:id/critique-plan` | `approvals.ts` | Submit plan critique and rerun the execution-plan-phase planner. Capped by `PLANNER_MAX_ITERATIONS` |
| `POST` | `/api/tasks/:id/retry` | `approvals.ts` | Retry from `awaiting_intervention` with optional `fromStage`, `checkpointId`, `operatorNote`, `planningPhase`, and `force` |
| `POST` | `/api/tasks/:id/steer` | `approvals.ts` | Queue boundary-safe steering for the next attempt (`scope: next_attempt`) |
| `POST` | `/api/meta` | `meta.ts` | Trigger meta-loop analysis; returns `experimentId` |
| `POST` | `/api/meta/:experimentId/conclude` | `meta.ts` | Conclude experiment (keep or revert) |
| `GET`  | `/api/transcripts/by-task/:taskId` | `transcripts.ts` | List transcripts for a task |
| `GET`  | `/api/transcripts/:id` | `transcripts.ts` | Fetch a single transcript |
| `GET`  | `/api/experiments?status=proposed&operation=fork` | `experiments.ts` | List proposed fork experiments awaiting first-fork approval |
| `POST` | `/api/experiments/:id/approve-fork` | `experiments.ts` | Approve a proposed fork and create a `candidate` variant |
| `POST` | `/api/experiments/:id/reject-fork` | `experiments.ts` | Reject a proposed fork and emit `fork_rejected` |
| `GET`  | `/api/variants/:agentType` | `variants.ts` | List dispatch population variants by agent type |
| `GET`  | `/api/variants/:id/scores` | `variants.ts` | Recent selected-task scores for a variant |
| `GET`  | `/api/variants/:id/shadow` | `variants.ts` | Recent shadow runs for a candidate variant |
| `POST` | `/api/diagnostic/run` | `diagnostic.ts` | Manually run the diagnostician for an agent type |
| `GET`  | `/api/metrics/:projectId` | `metrics.ts` | Project metrics (total/completed tasks, unresolved findings) |
| `GET`  | `/api/metrics/:projectId/trends` | `metrics.ts` | Trend data (stub, returns empty points) |
| `GET`  | `/api/metrics/:projectId/token-kpis` | `metrics.ts` | Planner token KPI summary (median, share, retries) scoped to project/window |
| `GET`  | `/api/metrics/:projectId/envelope-reuse` | `metrics.ts` | Repeated `context_envelope_hash` rows with occurrence count + avg token input |
| `GET`  | `/api/events` | `server.ts` | SSE stream for live updates |
| `GET`  | `/static/*` | `server.ts` | Static asset serving (`src/web/public/`) |

## Core Flows

### Task Submission Flow

```
POST /api/tasks
  → Zod validation (projectId, description)
  → service.submitTask(projectId, description)
  → events.publish({ type: "task.updated", data: task })
  → 201 <task object>
```

`submitTask` runs the full pipeline synchronously — the HTTP response is not returned until the task reaches `awaiting_approval` or fails.

When QMD is configured (`QMD_MCP_URL` present), planner attempts return an assessed QMD evidence state. Usable `planningContext.qmdContext` proceeds normally. Auditable fallback evidence (`status: "fallback"` with queries/documents or observed QMD tool calls plus a fallback reason) proceeds with `done_with_concerns` and is surfaced in the task's computed `planContract`. Missing or ignored QMD evidence pauses the task in `awaiting_intervention` with `failure_category=planner_ignored_qmd` or `qmd_unavailable`.

Task API responses include a computed `planContract` summary for plan review and interventions. `POST /api/tasks/:id/repair-plan-contract` can repair deterministic contract aliases, such as `description` to `behavior`, without rerunning the planner when the task is paused for a planner contract intervention.

### Approval Flow

```
POST /api/tasks/:id/approve
  → service.approveTask(id)   (runs doc agent, merges PR)
  → events.publish({ type: "task.updated", data: task })
  → 200 <task object>
```

`POST /api/tasks/:id/reject` closes and fails the old task, spawns a fresh restart task with feedback appended, emits `restart_spawned`, and returns the new task object directly.

### Intervention Retry and Steering Flow

- `POST /api/tasks/:id/retry` accepts optional rollback inputs:
  - `checkpointId`: rewind worktree to a recorded checkpoint before retrying
  - `operatorNote`: attached to `rollback_applied` / `retry_requested` for forensics
  - `fromStage`: `planning` or `executing`
  - `planningPhase`: `spec` or `execution_plan` — explicit planner phase when retrying from planning. Omitted means inferred from the most recent planner transcript stage, except after a spec-checkpoint rollback (which always targets `spec`).
  - `force`: bypass the `cannot_rollback_to_approved_spec` guard. Required when the task already has an approved spec (`planningContext.reviewedAt` set) and the operator wants to redo the spec phase without rolling back to a spec-phase checkpoint. Returns HTTP 409 `cannot_rollback_to_approved_spec` otherwise.
- `POST /api/tasks/:id/steer` queues an operator message as `steering_message`; the next planner/coder/reviewer/doc dispatch injects it and emits `steering_consumed`.
- QMD-evidence planner failures use the same retry surface: operators fix context/prompting and retry from `planning`.

### SSE Dashboard Flow

The static dashboard at `GET /` polls `/api/runtime` and `/api/tasks` on load, then subscribes to `/api/events` via `EventSource`. On receiving a `task.updated` event, it refreshes the task list. The runtime panel surfaces whether `QMD_MCP_URL` is configured and reachable, and whether task workspaces are local worktrees or Docker containers.

```javascript
// src/web/public/dashboard.js
const stream = new EventSource('/api/events');
stream.addEventListener('task.updated', refresh);
```

### Fork Approval and Diagnostic Routes

Population operation endpoints are intentionally narrow and operator-facing:

```typescript
// src/web/routes/experiments.ts
app.get("/", (ctx) => {
  if (ctx.req.query("status") === "proposed" && ctx.req.query("operation") === "fork") {
    return ctx.json({ experiments: service.listPendingForkExperiments() });
  }
  return ctx.json({ experiments: [] });
});

app.post("/:id/approve-fork", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({})) as { approver?: unknown; notes?: unknown };
  const result = await service.approveFork(ctx.req.param("id"), {
    approver: typeof body.approver === "string" ? body.approver : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined
  });
  return ctx.json({ ok: true, variantId: result.variantId }, 200);
});

app.post("/:id/reject-fork", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({})) as { reviewer?: unknown; reason?: unknown };
  service.rejectFork(
    ctx.req.param("id"),
    typeof body.reviewer === "string" ? body.reviewer : undefined,
    typeof body.reason === "string" ? body.reason : undefined
  );
  return ctx.json({ ok: true }, 200);
});
```

```typescript
// src/web/routes/diagnostic.ts
app.post("/run", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({})) as { agentType?: unknown };
  const agentType = body.agentType ?? "coder";
  const result = await service.runPopulationDiagnostic(agentType, "manual");
  return ctx.json({ ok: true, agentType, clustersProposed: result.clustersProposed });
});
```

`POST /api/diagnostic/run` accepts `agentType` values `planner`, `coder`, `reviewer`, or `doc`; invalid values return 400. Approval emits `fork_approved` and `traffic_allocated` (`reason: "meta_fork_approved"`), while rejection emits `fork_rejected`.

## Data Entities

### Metrics Responses

```typescript
// src/db/client.ts metricsForProject()
{
  totalTasks: number;
  completedTasks: number;
  unresolvedFindings: number;
}
```

```typescript
// src/web/routes/metrics.ts GET /api/metrics/:projectId/token-kpis
{
  projectId: string;
  windowDays: number;
  plannerRows: number;
  summary: {
    plannerMedianInputTokens: number;
    totalInputTokens: number;
    plannerInputShare: number;
    plannerRetries: number;
  };
}
```

```typescript
// src/web/routes/metrics.ts GET /api/metrics/:projectId/envelope-reuse
{
  projectId: string;
  windowDays: number;
  limit: number;
  rows: Array<{
    contextEnvelopeHash: string;
    occurrences: number;
    avgTokenInput: number;
  }>;
}
```

## Integration Points

- **Task Orchestration**: Task routes delegate to `OrchestratorService` methods (`submitTask`, `approveTask`, `rejectTask`, `archiveTask`, `unarchiveTask`, `deleteTaskPermanently`, `approveSpec`, `critiqueSpec`, `approvePlan`, `critiquePlan`, `retryFromIntervention`, `listTasks`, `getTask`).
- **Meta-Loop**: Meta and experiment routes delegate to `OrchestratorService.submitMetaTask()`, `concludeExperiment()`, `listPendingForkExperiments()`, `approveFork()`, and `rejectFork()`.
- **Diagnostics**: `POST /api/diagnostic/run` delegates to `OrchestratorService.runPopulationDiagnostic()`.
- **Event Log**: `GET /api/tasks/:id/events` delegates to `DbClient.listEvents(taskId)`.
- **Event Sourcing**: `DbClient.metricsForProject()` queries the materialized `tasks` and `review_findings` tables.
- **Live Events**: `LiveEventHub` is instantiated once in `createWebServer` and passed to both task and approval route factories.

## Known Limitation (V1)

Approval-surface mutating routes (including retry/rollback and steering) currently have no built-in authentication middleware. Deploy behind a trusted network boundary or reverse proxy that enforces operator auth until route-level auth is added.

## File Map

| File | Purpose |
|------|---------|
| `src/web/server.ts` | `createWebServer` — Hono app, static asset serving, SSE endpoint, health check |
| `src/web/public/index.html` | Static dashboard HTML |
| `src/web/public/dashboard.js` | Dashboard client JS — SSE subscription, task list rendering |
| `src/web/routes/tasks.ts` | Task creation/list/get/events/archive/unarchive/permanent delete |
| `src/web/routes/approvals.ts` | Approve/reject/cancel/approve-spec/critique-spec/approve-plan/critique-plan/retry/steer task operations |
| `src/web/routes/meta.ts` | `POST /api/meta`, `POST /api/meta/:experimentId/conclude` |
| `src/web/routes/transcripts.ts` | `GET /api/transcripts/by-task/:taskId`, `GET /api/transcripts/:id` |
| `src/web/routes/experiments.ts` | `GET /api/experiments?status=proposed&operation=fork`, `POST /api/experiments/:id/approve-fork`, `POST /api/experiments/:id/reject-fork` |
| `src/web/routes/variants.ts` | `GET /api/variants/:agentType`, `GET /api/variants/:id/scores`, `GET /api/variants/:id/shadow` |
| `src/web/routes/diagnostic.ts` | `POST /api/diagnostic/run` |
| `src/web/routes/metrics.ts` | `GET /api/metrics/:projectId`, `GET /api/metrics/:projectId/trends`, `GET /api/metrics/:projectId/token-kpis`, `GET /api/metrics/:projectId/envelope-reuse` |
| `src/web/events.ts` | `LiveEventHub` — in-memory SSE fan-out |
