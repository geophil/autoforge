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
  sequence: number;       // 1-based ordering
  description: string;
  filesInScope: string[]; // paths the coder should touch
  dependencies: string[]; // IDs of subtasks this depends on
  testCriteria: string[]; // acceptance criteria strings
  agentType?: AgentType;  // which persona handles this subtask
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

export type AgentType = "planner" | "coder" | "reviewer" | "doc" | "pr" | "orchestrator" | "meta";
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

## Entity Relationship Summary

```
projects (1) ──< tasks (N)
tasks    (1) ──< subtasks (N)
tasks    (1) ──< review_findings (N)
tasks    (1) ──< events (N)
experiments (1) ──< skill_versions (N)
```

Tasks are the central entity. Every other table references `task_id`. Events are the authoritative record; `tasks`, `subtasks`, and `review_findings` are materialized projections rebuilt by replaying events.
