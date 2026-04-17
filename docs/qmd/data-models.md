# Data Models

Complete type and schema reference across all Autoforge domains.

## PipelineTask

**Owned by**: `domain-task-orchestration.md`
**Storage**: `tasks` table (SQLite), rebuilt from the event log

```typescript
// src/types/core.ts
export interface PipelineTask {
  id: string;          // UUID
  projectId: string;
  description: string; // original natural-language feature request
  state: TaskStage;
  tier: Tier;
  assessment: ComplexityAssessment;
  planSubtasks: PlanSubtask[];
  iteration: number;   // current rework cycle (0 = first attempt)
  prUrl?: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;
}

export type TaskStage =
  | "received" | "assessing" | "planning" | "executing"
  | "reviewing" | "reworking" | "pr_created" | "awaiting_approval"
  | "documenting" | "completed" | "failed";

export type Tier = "EXPRESS" | "STANDARD" | "THOROUGH";
```

```sql
-- src/db/schema.sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  description TEXT NOT NULL,
  state       TEXT NOT NULL,
  tier        TEXT NOT NULL,
  assessment  TEXT NOT NULL,  -- JSON ComplexityAssessment
  plan        TEXT NOT NULL,  -- JSON PlanSubtask[]
  iteration   INTEGER NOT NULL DEFAULT 0,
  pr_url      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

## PlanSubtask

**Owned by**: `domain-task-orchestration.md`
**Storage**: `subtasks` table + embedded JSON in `tasks.plan`

```typescript
// src/types/core.ts
export interface PlanSubtask {
  id: string;
  sequence: number;        // 1-based ordering
  description: string;
  filesInScope: string[];  // paths the coder should touch
  dependencies: string[];  // IDs of subtasks this depends on
  testCriteria: string[];  // acceptance criteria strings
  agentType?: AgentType;   // override the default agent for this subtask
}
```

```sql
CREATE TABLE IF NOT EXISTS subtasks (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  sequence          INTEGER NOT NULL,
  description       TEXT NOT NULL,
  files_in_scope    TEXT NOT NULL,  -- JSON string[]
  dependencies      TEXT NOT NULL,  -- JSON string[]
  state             TEXT NOT NULL DEFAULT 'pending',
  status            TEXT,
  concerns          TEXT,
  agent_type        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  budget_seconds    INTEGER NOT NULL,
  elapsed_seconds   REAL,
  token_input       INTEGER,
  token_output      INTEGER,
  estimated_cost    REAL
);
```

## ComplexityAssessment

**Owned by**: `domain-complexity-routing.md`
**Storage**: `tasks.assessment` (JSON column)

```typescript
// src/types/core.ts
export interface ComplexityAssessment {
  scope:    "small" | "medium" | "large";
  novelty:  "low"   | "medium" | "high";
  risk:     "low"   | "medium" | "high";
  coupling: "low"   | "medium" | "high";
  rationale: string;
  similarPastTasks: string[];  // reserved for meta-loop calibration
}
```

## ReviewFinding

**Owned by**: `domain-task-orchestration.md`, `domain-pr-gate.md`
**Storage**: `review_findings` table

```typescript
// src/types/core.ts
export interface ReviewFinding {
  id: string;
  taskId: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "NITPICK";
  category: string;
  description: string;
  filePath?: string;
  resolved: boolean;
  resolvedInIteration?: number;
}
```

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id),
  severity              TEXT NOT NULL,
  category              TEXT NOT NULL,
  description           TEXT NOT NULL,
  file_path             TEXT,
  resolved              INTEGER NOT NULL DEFAULT 0,
  resolved_in_iteration INTEGER
);
```

Severity decision points:
- **CRITICAL / MAJOR** → triggers rework loop
- **MINOR / NITPICK** → recorded but do not block PR creation

## SubtaskReportStatus

**Owned by**: `domain-task-orchestration.md`
**Storage**: `subtasks.status` column

```typescript
// src/types/core.ts
export type SubtaskReportStatus = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
```

Returned by implementer agents in `.autoforge-status.json`. The orchestrator uses `isSuccess()` to decide whether to advance the pipeline or halt.

## AutoforgeMessage (Event)

**Owned by**: `domain-event-sourcing.md`
**Storage**: `events` table (append-only)

```typescript
// src/nats/messages.ts
export type AutoforgeMessage<T = unknown> = {
  id: string;           // UUID
  taskId: string;
  projectId: string;
  timestamp: string;    // ISO 8601
  agent: AgentType;
  type: string;         // "created" | "state.{stage}" | "review_finding" | "planned" | etc.
  status: TaskStatus;
  payload: T;
  budgetSeconds: number;
  elapsedSeconds?: number;
  tokenUsage?: { input: number; output: number; estimatedCost: number };
};

export type AgentType = "planner" | "coder" | "reviewer" | "doc" | "doc-review" | "pr" | "orchestrator" | "meta";
export type TaskStatus = "pending" | "in_progress" | "done" | "done_with_concerns" | "blocked" | "needs_context" | "failed" | "timeout";
```

## ProjectConfig

**Owned by**: `domain-task-orchestration.md`
**Storage**: `projects` table + `src/config/projects.ts` hardcoded default

```typescript
// src/config/projects.ts
export interface ProjectConfig {
  id: string;
  name: string;
  repoUrl: string;
  docsPath: string;
  defaultTier: "EXPRESS" | "STANDARD" | "THOROUGH";
}
```

```sql
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_url      TEXT NOT NULL,
  docs_path     TEXT DEFAULT 'docs/',
  conventions   TEXT,
  default_tier  TEXT DEFAULT 'STANDARD',
  human_approval TEXT DEFAULT 'required',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## RejectionFeedback

**Owned by**: `domain-web-api.md`
**Storage**: passed directly to `OrchestratorService.rejectTask()`; not persisted as its own row

```typescript
// src/types/core.ts
export type RejectionCategory =
  | "stale_base"
  | "wrong_scope"
  | "incomplete"
  | "incorrect_output"
  | "quality_issues"
  | "other";

export interface RejectionFeedback {
  reason: string;
  guidance?: string;
  categories?: RejectionCategory[];
}
```

`reason` is required (non-empty). `guidance` is free-form operator advice forwarded to the restarted task. `categories` allows structured tagging of why the output was rejected.

## Experiment (Meta-Loop)

**Owned by**: (planned meta-loop domain)
**Storage**: `experiments` table

```sql
CREATE TABLE IF NOT EXISTS experiments (
  id                   TEXT PRIMARY KEY,
  hypothesis           TEXT NOT NULL,
  skill_modified       TEXT,
  agent_affected       TEXT,
  change_description   TEXT NOT NULL,
  metric_name          TEXT NOT NULL,
  metric_before        REAL NOT NULL,
  metric_after         REAL,
  constraint_violations TEXT,
  status               TEXT NOT NULL DEFAULT 'proposed',
  human_notes          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT
);
```

## SkillVersion

**Owned by**: (planned meta-loop domain)
**Storage**: `skill_versions` table

```sql
CREATE TABLE IF NOT EXISTS skill_versions (
  id            TEXT PRIMARY KEY,
  skill_name    TEXT NOT NULL,
  version       TEXT NOT NULL,
  content       TEXT NOT NULL,
  experiment_id TEXT REFERENCES experiments(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_active     INTEGER NOT NULL DEFAULT 0
);
```

## RoutingCalibration

**Owned by**: `domain-complexity-routing.md`
**Storage**: `routing_calibration` table

Hindsight assessment of whether the tier assigned to a task was appropriate. Written by the orchestrator after a task completes or fails.

```sql
CREATE TABLE IF NOT EXISTS routing_calibration (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  tier_assigned    TEXT NOT NULL,
  tier_appropriate TEXT,
  under_tiered     INTEGER,
  over_tiered      INTEGER,
  signals          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Materialized Views

Two read-only views aggregate event and task data for performance analysis. Both are queried by the development workflow (see `development-workflow.md`).

### task_outcomes

Per-task summary of token cost, timing, findings, and whether the task passed on the first attempt.

```sql
CREATE VIEW IF NOT EXISTS task_outcomes AS
SELECT
  t.id                  AS task_id,
  t.project_id,
  t.tier,
  t.state               AS final_state,
  t.iteration           AS iterations,
  SUM(e.token_input)    AS total_tokens_in,
  SUM(e.token_output)   AS total_tokens_out,
  SUM(e.estimated_cost) AS total_cost,
  SUM(e.elapsed_seconds) AS total_elapsed,
  (SELECT COUNT(*) FROM review_findings rf WHERE rf.task_id = t.id) AS finding_count,
  (SELECT COUNT(*) FROM review_findings rf WHERE rf.task_id = t.id AND rf.severity IN ('CRITICAL','MAJOR')) AS blocking_finding_count,
  CASE WHEN t.iteration = 0 AND t.state = 'completed' THEN 1 ELSE 0 END AS first_pass_success,
  t.created_at
FROM tasks t
LEFT JOIN events e ON e.task_id = t.id AND e.agent != 'orchestrator'
WHERE t.state IN ('completed', 'failed')
GROUP BY t.id;
```

### agent_performance

Performance breakdown by persona version and agent type. Answers: which persona version produces the best first-pass rate?

```sql
CREATE VIEW IF NOT EXISTS agent_performance AS
SELECT
  json_extract(e.payload, '$.persona_version_id') AS persona_version_id,
  sv.skill_name                                    AS persona_name,
  e.agent                                          AS agent_type,
  COUNT(DISTINCT t.id)                             AS task_count,
  AVG(CASE WHEN t.iteration = 0 AND t.state = 'completed' THEN 1.0 ELSE 0.0 END) AS first_pass_rate,
  AVG(t.iteration)                                 AS avg_iterations,
  AVG(e.estimated_cost)                            AS avg_step_cost
FROM events e
JOIN tasks t ON t.id = e.task_id
LEFT JOIN skill_versions sv ON sv.id = json_extract(e.payload, '$.persona_version_id')
WHERE e.agent IN ('planner', 'coder', 'reviewer', 'doc')
  AND t.state IN ('completed', 'failed')
  AND json_extract(e.payload, '$.persona_version_id') IS NOT NULL
GROUP BY json_extract(e.payload, '$.persona_version_id'), e.agent;
```

## Entity Relationship Summary

```
projects             (1) ──< tasks (N)
tasks                (1) ──< subtasks (N)
tasks                (1) ──< review_findings (N)
tasks                (1) ──< events (N)
tasks                (1) ──< routing_calibration (N)
experiments          (1) ──< skill_versions (N)
task_outcomes        — view over tasks + events + review_findings
agent_performance    — view over events + tasks + skill_versions
```

Tasks are the central entity. Every other table references `task_id`. Events are the authoritative record; `tasks`, `subtasks`, and `review_findings` are materialized projections rebuilt by replaying events.
