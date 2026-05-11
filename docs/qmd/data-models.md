# Data Models

Core type and schema reference across Autoforge domains. This document highlights the tables, views, and TypeScript types most often needed for QMD retrieval; consult `src/db/schema.sql` and `src/db/migrations/*.sql` for exhaustive DDL.

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
  archivedAt?: string;
}

export type TaskStage =
  | "received" | "assessing" | "planning" | "awaiting_plan_approval"
  | "replanning" | "executing" | "reviewing" | "reworking"
  | "pr_created" | "awaiting_approval" | "documenting"
  | "awaiting_intervention" | "completed" | "failed";

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
  updated_at  TEXT NOT NULL,
  archived_at TEXT
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

export type AgentType =
  | "planner" | "coder" | "reviewer" | "doc" | "doc-review"
  | "pr" | "orchestrator" | "meta"
  | "reflector" | "diagnostician";
export type TaskStatus = "pending" | "in_progress" | "done" | "done_with_concerns" | "blocked" | "needs_context" | "failed" | "timeout";
```

Spec D event types stored in `events.event_type` include `variant_selected`, `shadow_run_completed`, `traffic_allocated`, `diagnostic_run_completed`, `diagnostic_cluster_detected`, `fork_approved`, `fork_rejected`, and `variants_merged`. See `domain-event-sourcing.md` > Spec D Population Events.

Workspace lifecycle events are ordinary `AutoforgeMessage` rows too:

```typescript
// src/runtime/workspace-events.ts
export const WorkspaceCreatedPayloadSchema = WorkspaceLifecyclePayloadSchema.extend({
  root_path: z.string().optional()
});

export const WorkspaceDestroyedPayloadSchema = WorkspaceLifecyclePayloadSchema.extend({
  reason: z.string().optional()
});
```

`workspace_created` and `workspace_destroyed` do not project into a dedicated SQL table. Cleanup derives active workspace state by scanning event history.

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

**Owned by**: `domain-task-orchestration.md`, `domain-web-api.md`
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

-- src/db/migrations/004_experiments_evidence.sql
ALTER TABLE experiments ADD COLUMN operation TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE experiments ADD COLUMN evidence TEXT;

-- src/db/migrations/008_experiments_proposed_content.sql
ALTER TABLE experiments ADD COLUMN proposed_content TEXT;
```

`operation` records curator/meta operation kind (`edit`, `fork`, `merge`, `promote`, `demote`, `retire`). `evidence` stores JSON evidence plus `meta_task_id`; `proposed_content` stores proposed prompt content for approval workflows where a file artifact would not survive.

## AgentTranscript

**Owned by**: `domain-agent-execution.md`, `domain-web-api.md`
**Storage**: `agent_transcripts` table

```sql
-- src/db/schema.sql plus src/db/migrations/003_transcripts_variant.sql
CREATE TABLE IF NOT EXISTS agent_transcripts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  stage           TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  executor_used   TEXT NOT NULL,
  model           TEXT,
  system_prompt   TEXT NOT NULL,
  user_prompt     TEXT NOT NULL,
  transcript      TEXT NOT NULL,
  output          TEXT,
  critique        TEXT,
  token_input     INTEGER,
  token_output    INTEGER,
  elapsed_seconds REAL,
  persona_version_id TEXT
);
```

`persona_version_id` links planner attempts and other captured transcripts back to the selected population variant. `GET /api/transcripts/by-task/:taskId` lists rows, and `GET /api/transcripts/:id` fetches a single transcript.

Harness transcripts can also include dynamic skill loading attribution:

```typescript
// src/executors/interface.ts
export type AgentTranscriptTurn =
  | { kind: "assistant"; content: unknown[] }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "loaded_skills"; skills: string[] }
  | { kind: "compaction"; droppedTurns: number; /* ... */ }
  | { kind: "error"; name: string; message: string; stack?: string };
```

The `loaded_skills` turn is part of the existing transcript JSONL shape, so no schema migration is needed when a harness-backed transcript is persisted. Current orchestrator persistence is planner-focused; non-planner harness runs expose this attribution on `AgentResult.transcript` until broader transcript capture is added.

## Workspace and Runtime Provider Types

**Owned by**: `domain-agent-execution.md`
**Storage**: event payloads and transcript metadata; no dedicated table

```typescript
// src/runtime/workspace.ts
export interface Workspace {
  readonly id: string;
  readonly provider: "local" | "mock" | "e2b" | "aws" | string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
  destroy(): Promise<void>;
}
```

```typescript
// src/runtime/model-provider.ts
export interface ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];
  message(args: {
    model: string;
    systemPrompt: string;
    history: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    timeoutSeconds?: number;
  }): Promise<ModelResponse>;
}
```

These two interfaces are the cloud-runtime hinge: adding a new sandbox means implementing `Workspace`; adding a new model API means implementing `ModelProvider`.

## SkillVersion Population Variant

**Owned by**: `domain-agent-execution.md`, `domain-task-orchestration.md`
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

-- src/db/migrations/001_population_schema.sql
ALTER TABLE skill_versions ADD COLUMN parent_version_id TEXT;
ALTER TABLE skill_versions ADD COLUMN specialty TEXT;
ALTER TABLE skill_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE skill_versions ADD COLUMN traffic_share REAL NOT NULL DEFAULT 0.0;

-- src/db/migrations/010_specialty_embedding.sql
ALTER TABLE skill_versions ADD COLUMN specialty_embedding BLOB;
```

`skill_versions` is population-shaped. Each `skill_name` such as `persona:coder` has one `baseline`, may have live `active` variants receiving weighted traffic, may have `candidate` variants evaluated by `shadow_run_completed`, and may retain `demoted` or `retired` variants for history. `specialty` describes the niche; `specialty_embedding` stores serialized vector bytes used by `filterSpecialtyEligible()` before keyword fallback. `is_active` remains only for compatibility and is synced from `status IN ('baseline', 'active')`.

## ForkProposal

**Owned by**: `domain-event-sourcing.md`, `domain-web-api.md`
**Storage**: `fork_proposals` table

```sql
-- src/db/migrations/009_fork_proposals.sql
CREATE TABLE IF NOT EXISTS fork_proposals (
  id                      TEXT PRIMARY KEY,
  agent_type              TEXT NOT NULL,
  generated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  generator               TEXT NOT NULL DEFAULT 'diagnostician',
  label                   TEXT NOT NULL,
  keywords                TEXT NOT NULL,
  suggested_specialty     TEXT NOT NULL,
  representative_task_ids TEXT NOT NULL,
  baseline_score_mean     REAL NOT NULL,
  population_score_mean   REAL NOT NULL,
  score_gap               REAL NOT NULL,
  recommendation_strength TEXT NOT NULL CHECK (recommendation_strength IN ('weak', 'moderate', 'strong')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acted_on', 'stale', 'dismissed')),
  acted_on_experiment_id  TEXT REFERENCES experiments(id),
  closed_at               TEXT
);
```

`diagnostician` creates these rows from recent task histories. `GET /api/experiments?status=proposed&operation=fork` exposes matching fork experiments for approval, while `POST /api/experiments/:id/approve-fork` turns an approved first fork into a `candidate` variant.

## Lesson

**Owned by**: `domain-agent-execution.md`, `domain-task-orchestration.md`
**Storage**: `lessons` table

```sql
-- src/db/migrations/007_lessons.sql
CREATE TABLE IF NOT EXISTS lessons (
  id                 TEXT PRIMARY KEY,
  agent_type         TEXT NOT NULL,
  lineage_root_id    TEXT NOT NULL REFERENCES skill_versions(id),
  source_task_id     TEXT NOT NULL REFERENCES tasks(id),
  source_variant_id  TEXT NOT NULL REFERENCES skill_versions(id),
  trigger_pattern    TEXT NOT NULL,
  failure_category   TEXT,
  finding_categories TEXT,
  body               TEXT NOT NULL,
  outcome_kind       TEXT NOT NULL CHECK (outcome_kind IN ('corrective', 'reinforcing')),
  retrieval_keywords TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'retired')),
  superseded_by      TEXT REFERENCES lessons(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at         TEXT
);
```

`reflectOnTask()` inserts active lineage lessons after terminal task states. Dispatch retrieves active lessons for the selected variant lineage and injects them into the agent prompt.

## TaskDiffStats and TaskIterationDiffs

**Owned by**: `domain-task-orchestration.md`
**Storage**: `task_diff_stats`, `task_iteration_diffs`

```sql
-- src/db/migrations/002_task_diff_stats.sql
CREATE TABLE IF NOT EXISTS task_diff_stats (
  task_id            TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id),
  files_changed      INTEGER NOT NULL,
  files_added        INTEGER NOT NULL,
  files_modified     INTEGER NOT NULL,
  files_deleted      INTEGER NOT NULL,
  lines_added        INTEGER NOT NULL,
  lines_deleted      INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  captured_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_iteration_diffs (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  from_iteration     INTEGER NOT NULL,
  to_iteration       INTEGER NOT NULL,
  files_changed      INTEGER NOT NULL,
  lines_added        INTEGER NOT NULL,
  lines_deleted      INTEGER NOT NULL,
  test_files_changed INTEGER NOT NULL,
  diff_summary       TEXT,
  captured_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, from_iteration, to_iteration)
);
```

`task_diff_stats` captures cumulative task change size for reward scoring; `task_iteration_diffs` captures rework deltas.

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

Read-only views aggregate task outcomes, agent attribution, reward signals, and population health. They are queried by the dashboard, meta/diagnostic workflows, and development scripts.

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

### Reward Views

Spec D reward views are defined in `src/db/migrations/005_reward_views.sql` and refined by later migrations:

- `task_quality_score` — per-task reward components: `r_correctness`, `r_simplicity`, `r_alignment`, `r_fidelity`, `r_efficiency`.
- `variant_performance` — average reward components per selected `variant_id` and `agent_type` from `variant_selected` events.
- `niche_performance` — variant performance grouped by tier, project, and finding category dimensions.
- `population_health` — active/candidate/retired variant counts, allocated traffic share, and ensemble reward averages per agent type.

## Entity Relationship Summary

```
projects             (1) ──< tasks (N)
tasks                (1) ──< subtasks (N)
tasks                (1) ──< review_findings (N)
tasks                (1) ──< events (N)
tasks                (1) ──< routing_calibration (N)
tasks                (1) ──< agent_transcripts (N)
tasks                (1) ──< task_diff_stats (0/1)
tasks                (1) ──< task_iteration_diffs (N)
experiments          (1) ──< skill_versions (N)
experiments          (1) ──< fork_proposals (N, via acted_on_experiment_id)
skill_versions       (1) ──< skill_versions (N, via parent_version_id)
skill_versions       (1) ──< lessons (N, via lineage/source variant)
task_outcomes        — view over tasks + events + review_findings
agent_performance    — view over events + tasks + skill_versions
task_quality_score   — reward view over tasks + findings + diff stats
variant_performance  — reward view over variant_selected events
niche_performance    — reward view by tier/project/finding category
population_health    — reward view by agent population
```

Tasks are the central entity for feature delivery. Events are the authoritative record; `tasks`, `subtasks`, and `review_findings` are materialized projections rebuilt by replaying events. Population state lives in `skill_versions`, `experiments`, `lessons`, and `fork_proposals`, with reward views deriving selection and outcome quality from event payloads.
