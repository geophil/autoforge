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
| `POST` | `/api/tasks` | `tasks.ts` | Submit a new task |
| `GET`  | `/api/tasks` | `tasks.ts` | List all tasks |
| `GET`  | `/api/tasks/:id` | `tasks.ts` | Get single task |
| `GET`  | `/api/tasks/:id/events` | `tasks.ts` | Task event log (ordered by timestamp) |
| `POST` | `/api/tasks/:id/approve` | `approvals.ts` | Approve awaiting task |
| `POST` | `/api/tasks/:id/reject` | `approvals.ts` | Reject awaiting task with reason; response body is the **new restart task**, not the original |
| `POST` | `/api/tasks/:id/cancel` | `approvals.ts` | Cancel a task (operator action) |
| `POST` | `/api/meta` | `meta.ts` | Trigger meta-loop analysis; returns `experimentId` |
| `POST` | `/api/meta/:experimentId/conclude` | `meta.ts` | Conclude experiment (keep or revert) |
| `GET`  | `/api/metrics/:projectId` | `metrics.ts` | Project metrics (total/completed tasks, unresolved findings) |
| `GET`  | `/api/metrics/:projectId/trends` | `metrics.ts` | Trend data (stub, returns empty points) |
| `GET`  | `/api/events` | `server.ts` | SSE stream for live updates |
| `GET`  | `/static/*` | `server.ts` | Static asset serving (`src/web/public/`) |

## Core Flows

### Task Submission Flow

```
POST /api/tasks
  → Zod validation (projectId, description)
  → service.submitTask(projectId, description)
  → events.publish({ type: "task.updated", data: task })
  → 201 { task }
```

`submitTask` runs the full pipeline synchronously — the HTTP response is not returned until the task reaches `awaiting_approval` or fails.

### Approval Flow

```
POST /api/tasks/:id/approve
  → service.approveTask(id)   (runs doc agent, merges PR)
  → events.publish({ type: "task.updated", data: task })
  → 200 { task }
```

### SSE Dashboard Flow

The static dashboard at `GET /` polls `/api/tasks` on load, then subscribes to `/api/events` via `EventSource`. On receiving a `task.updated` event, it refreshes the task list.

```javascript
// src/web/public/dashboard.js
const stream = new EventSource('/api/events');
stream.addEventListener('task.updated', refresh);
```

## Data Entities

### Metrics Response

```typescript
// src/db/client.ts metricsForProject()
{
  totalTasks: number;
  completedTasks: number;
  unresolvedFindings: number;
}
```

## Integration Points

- **Task Orchestration**: All task routes delegate to `OrchestratorService` methods (`submitTask`, `approveTask`, `rejectTask`, `listTasks`, `getTask`).
- **Meta-Loop**: Meta routes delegate to `OrchestratorService.submitMetaTask()` and `concludeExperiment()`.
- **Event Log**: `GET /api/tasks/:id/events` delegates to `DbClient.listEvents(taskId)`.
- **Event Sourcing**: `DbClient.metricsForProject()` queries the materialized `tasks` and `review_findings` tables.
- **Live Events**: `LiveEventHub` is instantiated once in `createWebServer` and passed to both task and approval route factories.

## File Map

| File | Purpose |
|------|---------|
| `src/web/server.ts` | `createWebServer` — Hono app, static asset serving, SSE endpoint, health check |
| `src/web/public/index.html` | Static dashboard HTML |
| `src/web/public/dashboard.js` | Dashboard client JS — SSE subscription, task list rendering |
| `src/web/routes/tasks.ts` | `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/events` |
| `src/web/routes/approvals.ts` | `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/reject`, `POST /api/tasks/:id/cancel` |
| `src/web/routes/meta.ts` | `POST /api/meta`, `POST /api/meta/:experimentId/conclude` |
| `src/web/routes/metrics.ts` | `GET /api/metrics/:projectId`, `GET /api/metrics/:projectId/trends` |
| `src/web/events.ts` | `LiveEventHub` — in-memory SSE fan-out |
