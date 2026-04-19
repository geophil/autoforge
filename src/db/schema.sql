-- Project configuration
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

-- Feature tasks (top-level)
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  description TEXT NOT NULL,
  state       TEXT NOT NULL,
  tier        TEXT NOT NULL,
  assessment  TEXT NOT NULL,
  plan        TEXT NOT NULL,
  iteration   INTEGER NOT NULL DEFAULT 0,
  pr_url      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Subtasks within a task
CREATE TABLE IF NOT EXISTS subtasks (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  sequence          INTEGER NOT NULL,
  description       TEXT NOT NULL,
  files_in_scope    TEXT NOT NULL,
  dependencies      TEXT NOT NULL,
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

-- Events log (append-only — never modified after insert)
CREATE TABLE IF NOT EXISTS events (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  subtask_id            TEXT,
  timestamp             TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  agent                 TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  status                TEXT NOT NULL,
  payload               TEXT NOT NULL,
  budget_seconds        INTEGER NOT NULL,
  elapsed_seconds       REAL,
  token_input           INTEGER,
  token_output          INTEGER,
  estimated_cost        REAL,
  resumable             INTEGER NOT NULL DEFAULT 1,
  executor_used         TEXT,
  context_envelope_hash TEXT
);

-- Review findings
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

-- Meta-loop experiments
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

-- Skill versions (immutable snapshots)
CREATE TABLE IF NOT EXISTS skill_versions (
  id            TEXT PRIMARY KEY,
  skill_name    TEXT NOT NULL,
  version       TEXT NOT NULL,
  content       TEXT NOT NULL,
  experiment_id TEXT REFERENCES experiments(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_active     INTEGER NOT NULL DEFAULT 0
);

-- Routing calibration (hindsight assessment per task)
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

-- Outcome summary per completed/failed task.
-- Aggregates token cost, timing, findings, and first-pass success from events + findings.
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

-- Performance by persona version and agent type.
-- Answers: which persona version produces the best outcomes for a given agent?
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

-- Agent transcripts (planner stage in v1; reserves room for other stages).
-- One row per planner attempt. Holds composed system prompt, user prompt,
-- turn-by-turn transcript JSONL, and parsed output.
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
  UNIQUE(task_id, stage, attempt)
);
CREATE INDEX IF NOT EXISTS idx_agent_transcripts_task ON agent_transcripts(task_id, stage, attempt);
