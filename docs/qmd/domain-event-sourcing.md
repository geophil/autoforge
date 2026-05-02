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

### Spec D Population Events

Population operations are still ordinary append-only `events` rows. The important event types are:

| Event type | Emitted by | Purpose |
|------------|------------|---------|
| `variant_selected` | `OrchestratorService.emitVariantSelected()` | Records selected variant, `selection_rationale`, eligible IDs, shadow candidate IDs, specialty, and injected lesson IDs for one live dispatch. |
| `shadow_run_completed` | `src/orchestrator/shadow.ts` | Records paired candidate-vs-baseline shadow execution, score components, injected lesson counts, and errors without affecting live task outcome. |
| `traffic_allocated` | `adjustVariantAllocation()` and fork approval | Records every variant `status` or `traffic_share` allocation change, including graduation, promotion, demotion, retirement, fork approval, merge, and baseline swaps. |
| `diagnostic_run_completed` | `runDiagnostic()` | Records diagnostics trigger, tasks analyzed, clusters proposed, elapsed time, and any diagnostic error. |
| `diagnostic_cluster_detected` | `runDiagnostic()` | Records one diagnostician-discovered niche cluster and links it to a `fork_proposals` row. |
| `fork_approved` | `OrchestratorService.approveFork()` | Records human approval of a proposed fork and the created candidate variant ID. |
| `fork_rejected` | `OrchestratorService.rejectFork()` | Records human rejection of a proposed fork experiment with reviewer and reason metadata. |
| `variants_merged` | `handleMerge()` | Records merge operation metadata, survivor/retired IDs, and specialty/content consolidation. |

### Harness Control Events (No Schema Migration Required)

The following control events use the existing type-agnostic `events` table and do not require new projection tables:

| Event type | Emitted by | Purpose |
|------------|------------|---------|
| `checkpoint_created` | `OrchestratorService.recordCheckpoint()` | Durable rollback anchor with `checkpoint_id`, `stage`, `iteration`, and `git_sha`. |
| `rollback_applied` | `OrchestratorService.retryFromIntervention()` | Records rollback target checkpoint and before/after iteration/head metadata. |
| `steering_message` | `OrchestratorService.addSteeringMessage()` | Queues operator steering to be injected at next safe dispatch boundary. |
| `steering_consumed` | `OrchestratorService.recordSteeringConsumed()` | Marks queued steering as consumed by a specific dispatch. |
| `lifecycle_hook_completed` | `OrchestratorService.runLifecyclePhase()` | Records lifecycle hook execution details (or skip reason) per phase/script. |
| `lifecycle_hook_failed` | `OrchestratorService.runLifecyclePhase()` | Records hook failure forensics before pausing task in `awaiting_intervention`. |

NATS impact: `recordEvent()` publishes all six event types on the same `autoforge.task.{projectId}.{taskId}.{event.type}` contract, so downstream consumers should decide whether to render, aggregate, or filter these control-plane events.

### `fork_proposals` Table

The diagnostician writes proposed population niches into `fork_proposals`. Rows start as `open`; approval connects the proposal to an experiment and marks it acted on, while stale/dismissed rows remain searchable for operator review.

```sql
-- src/db/migrations/009_fork_proposals.sql
CREATE TABLE IF NOT EXISTS fork_proposals (
  id                      TEXT PRIMARY KEY,
  agent_type              TEXT NOT NULL,
  generator               TEXT NOT NULL DEFAULT 'diagnostician',
  label                   TEXT NOT NULL,
  keywords                TEXT NOT NULL,
  suggested_specialty     TEXT NOT NULL,
  representative_task_ids TEXT NOT NULL,
  baseline_score_mean     REAL NOT NULL,
  population_score_mean   REAL NOT NULL,
  score_gap               REAL NOT NULL,
  recommendation_strength TEXT NOT NULL CHECK (recommendation_strength IN ('weak', 'moderate', 'strong')),
  status                  TEXT NOT NULL DEFAULT 'open'
);
```

### `skill_versions.specialty_embedding` Column

Specialist eligibility uses an opaque serialized vector on each variant. `filterSpecialtyEligible()` compares task-description embeddings to `skill_versions.specialty_embedding`; if no comparable embedding exists, it falls back to keyword matching against `specialty`.

```sql
-- src/db/migrations/010_specialty_embedding.sql
ALTER TABLE skill_versions ADD COLUMN specialty_embedding BLOB;
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
| `src/db/schema.sql` | Base schema: events, tasks, subtasks, review_findings, experiments, skill_versions, routing_calibration |
| `src/db/migrations/009_fork_proposals.sql` | `fork_proposals` table for diagnostician-generated fork niches |
| `src/db/migrations/010_specialty_embedding.sql` | `skill_versions.specialty_embedding` BLOB for specialty classifier eligibility |
| `src/nats/client.ts` | `NatsClient` — connect, `publishTaskEvent`, `replayTaskEvents` |
| `src/nats/streams.ts` | `ensureJetStreamStreams` — TASKS, META, SYSTEM stream provisioning |
| `src/nats/messages.ts` | `AutoforgeMessage` schema (Zod), `taskSubject` helper |
| `src/orchestrator/recovery.ts` | `RecoveryService` — NATS replay with SQLite fallback |
