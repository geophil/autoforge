# Event Sourcing and Recovery

The Event Sourcing domain provides Autoforge's durability foundation. Every state change the orchestrator makes is recorded as an immutable event appended to SQLite. NATS JetStream mirrors those events for streaming and recovery. The `tasks`, `subtasks`, and `review_findings` tables are materialized views — they can be dropped and rebuilt at any time by replaying the event log. If the process crashes mid-pipeline, the `RecoveryService` restores exact state on restart.

## Business Rules and Invariants

### Events Are Append-Only and Never Modified

The `events` table has no `UPDATE` or `DELETE` paths. All projection mutations use the payload from the event record.

```sql
-- src/db/schema.sql
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  agent       TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  status      TEXT NOT NULL,
  payload     TEXT NOT NULL,  -- JSON blob
  budget_seconds INTEGER NOT NULL,
  -- ... metrics columns
  resumable   INTEGER NOT NULL DEFAULT 1,
  executor_used TEXT,
  context_envelope_hash TEXT
);
```

### Every State Transition Is a `state.{stage}` Event

The orchestrator's `transition()` helper calls `assertTransition()` (guards invalid transitions) then `recordEvent()` with `type: "state.{to}"`. The current state is always derivable from the last `state.*` event.

```typescript
// src/orchestrator/service.ts
private transition(taskId, projectId, from, to, payload): void {
  assertTransition(from, to);  // throws on invalid transition
  this.recordEvent({
    type: `state.${to}`,
    status: to === "failed" ? "failed" : to === "completed" ? "done" : "in_progress",
    payload: { ...payload, state: to }
  });
}
```

### SQLite Write + NATS Publish Are Atomic from the Orchestrator's Perspective

The SQLite transaction is committed before the NATS publish is attempted. NATS failure is fire-and-forget (a warning is logged, not an error). SQLite is the source of truth.

```typescript
// src/orchestrator/service.ts
this.deps.db.transaction(() => {
  this.deps.db.appendEvent(message);
  this.deps.db.applyEvent(message);
});

// Publish to NATS JetStream asynchronously (fire-and-forget; SQLite is the source of truth).
this.deps.nats?.publishTaskEvent(message).catch((err) => {
  console.warn(`[orchestrator] NATS publish failed for ${message.type}: ${err}`);
});
```

**Enforced in**: `src/orchestrator/service.ts:353`

### NATS Connection Failure Degrades Gracefully

If NATS is unavailable at startup, the system runs in SQLite-only mode. No data is lost; events just don't stream.

```typescript
// src/nats/client.ts
async connect(): Promise<boolean> {
  try {
    this.connection = await connect({ servers: this.serverUrl, timeout: 3_000 });
    // ...
    return true;
  } catch (err) {
    console.warn(`[nats] Could not connect to ${this.serverUrl}: ... Events will be SQLite-only.`);
    return false;
  }
}
```

**Enforced in**: `src/nats/client.ts:16`

### Projections Can Be Rebuilt from Events at Any Time

`rebuildProjectionsFromEvents()` clears the `tasks`, `subtasks`, and `review_findings` tables and replays all events in timestamp order. This is used on startup if NATS replay yields 0 events.

```typescript
// src/db/client.ts
rebuildProjectionsFromEvents(): void {
  this.sqlite.exec("DELETE FROM review_findings; DELETE FROM subtasks; DELETE FROM tasks;");
  const events = this.sqlite.query(
    "SELECT * FROM events ORDER BY timestamp ASC"
  ).all();
  for (const event of events) {
    this.applyEvent(/* reconstructed message */);
  }
}
```

**Enforced in**: `src/db/client.ts:64`

## Core Flows

### Event Record Flow (Happy Path)

1. Orchestrator calls `recordEvent(input)`.
2. An `AutoforgeMessage` is constructed with a new UUID, current timestamp, and serialized payload.
3. `db.transaction()` wraps `appendEvent` (INSERT into `events`) and `applyEvent` (upsert into `tasks`/`subtasks`/`review_findings`).
4. NATS publishes asynchronously to `autoforge.task.{projectId}.{taskId}.{event.type}`.

### Recovery Flow on Startup

```typescript
// src/orchestrator/recovery.ts
async recover(): Promise<void> {
  if (this.nats?.isConnected) {
    const count = await this.nats.replayTaskEvents((message) => {
      this.db.transaction(() => {
        try { this.db.appendEvent(message); } catch { /* already present */ }
        this.db.applyEvent(message);
      });
    });
    if (count > 0) return;  // NATS replay succeeded
  }
  // Fallback: rebuild from SQLite
  this.db.rebuildProjectionsFromEvents();
}
```

NATS replay checks stream message count before fetching to avoid hanging on an empty stream.

### NATS JetStream Streams

Three streams are provisioned at startup:

```typescript
// src/nats/streams.ts
await ensureStream(jsm, "TASKS",  ["autoforge.task.>"],   RetentionPolicy.Limits, StorageType.File,   1_000);
await ensureStream(jsm, "META",   ["autoforge.meta.>"],   RetentionPolicy.Limits, StorageType.File);
await ensureStream(jsm, "SYSTEM", ["autoforge.system.>"], RetentionPolicy.Limits, StorageType.Memory, 100);
```

- **TASKS**: File-backed, persists task events (primary stream for replay).
- **META**: File-backed, reserved for meta-loop experiment events.
- **SYSTEM**: Memory-backed, limited to 100 messages — for ephemeral system signals.

Subject format: `autoforge.task.{projectId}.{taskId}.{event.type}`

### Event Projection Logic (`applyEventProjection`)

The projection function handles three cases:

1. **No existing task row**: `INSERT` with fields from the event payload.
2. **Existing task row**: `UPDATE` with `COALESCE(?, existing)` — only fields present in the payload overwrite; absent fields keep their current value.
3. **Finding in payload**: `INSERT OR REPLACE` into `review_findings`.
4. **`resolveAllFindings` flag**: Bulk `UPDATE review_findings SET resolved = 1` for the task.

```typescript
// src/db/projections.ts
if (existing === null) {
  sqlite.query(`INSERT INTO tasks (...) VALUES (...)`).run(...);
} else {
  sqlite.query(`UPDATE tasks SET state = COALESCE(?, state), ... WHERE id = ?`).run(...);
}
```

## Data Entities

```typescript
// src/nats/messages.ts
export type AutoforgeMessage<T = unknown> = {
  id: string;           // UUID
  taskId: string;
  projectId: string;
  timestamp: string;    // ISO 8601
  agent: AgentType;
  type: string;         // e.g. "state.executing", "review_finding", "created"
  status: TaskStatus;
  payload: T;
  budgetSeconds: number;
  elapsedSeconds?: number;
  tokenUsage?: { input: number; output: number; estimatedCost: number };
};
```

**NATS subject helper**:
```typescript
export function taskSubject(projectId, taskId, event): string {
  return `autoforge.task.${projectId}.${taskId}.${event}`;
}
```

## Integration Points

- **Task Orchestration**: Every `transition()` and `recordEvent()` call in `OrchestratorService` writes through this domain.
- **Web API**: `DbClient.listTasks()`, `getTask()`, `listFindings()`, `metricsForProject()` read the materialized views. See `domain-web-api.md`.
- **Recovery**: `RecoveryService` runs once at startup before the HTTP server opens.

## File Map

| File | Purpose |
|------|---------|
| `src/db/client.ts` | `DbClient` — SQLite wrapper, `appendEvent`, `applyEvent`, `rebuildProjectionsFromEvents` |
| `src/db/projections.ts` | `applyEventProjection` — upsert logic for tasks/subtasks/findings from event payloads |
| `src/db/schema.sql` | Full schema: events, tasks, subtasks, review_findings, experiments, skill_versions, routing_calibration |
| `src/nats/client.ts` | `NatsClient` — connect, `publishTaskEvent`, `replayTaskEvents` |
| `src/nats/streams.ts` | `ensureJetStreamStreams` — TASKS, META, SYSTEM stream provisioning |
| `src/nats/messages.ts` | `AutoforgeMessage` schema (Zod), `taskSubject` helper |
| `src/orchestrator/recovery.ts` | `RecoveryService` — NATS replay with SQLite fallback |
