# Web API and Dashboard

The Web API domain exposes Autoforge's functionality over HTTP using the Hono framework. It provides REST endpoints for task submission, approval/rejection, and metrics, plus a Server-Sent Events (SSE) stream for real-time dashboard updates. The dashboard is a server-rendered HTML page with a live-updating task table.

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

### Rejection Requires a Reason

The reject endpoint has a Zod schema with a non-empty `reason` field, defaulting to `"Rejected by human reviewer."` if not provided.

```typescript
// src/web/routes/approvals.ts
const RejectSchema = z.object({
  reason: z.string().min(1).default("Rejected by human reviewer.")
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
| `GET`  | `/` | `server.ts` | HTML dashboard |
| `POST` | `/api/tasks` | `tasks.ts` | Submit a new task |
| `GET`  | `/api/tasks` | `tasks.ts` | List all tasks |
| `GET`  | `/api/tasks/:id` | `tasks.ts` | Get single task |
| `POST` | `/api/tasks/:id/approve` | `approvals.ts` | Approve awaiting task |
| `POST` | `/api/tasks/:id/reject` | `approvals.ts` | Reject awaiting task with reason |
| `GET`  | `/api/metrics/:projectId` | `metrics.ts` | Project metrics (total/completed tasks, unresolved findings) |
| `GET`  | `/api/metrics/:projectId/trends` | `metrics.ts` | Trend data (stub, returns empty points) |
| `GET`  | `/api/events` | `server.ts` | SSE stream for live updates |

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

The dashboard HTML at `GET /` polls `/api/tasks` on load, then subscribes to `/api/events` via `EventSource`. On receiving a `task.updated` event, it refreshes the task list.

```javascript
// embedded in dashboard HTML (src/web/server.ts)
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
- **Event Sourcing**: `DbClient.metricsForProject()` queries the materialized `tasks` and `review_findings` tables.
- **Live Events**: `LiveEventHub` is instantiated once in `createWebServer` and passed to both task and approval route factories.

## File Map

| File | Purpose |
|------|---------|
| `src/web/server.ts` | `createWebServer` — Hono app, dashboard HTML, SSE endpoint |
| `src/web/routes/tasks.ts` | `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id` |
| `src/web/routes/approvals.ts` | `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/reject` |
| `src/web/routes/metrics.ts` | `GET /api/metrics/:projectId` |
| `src/web/events.ts` | `LiveEventHub` — in-memory SSE fan-out |
