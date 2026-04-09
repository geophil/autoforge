CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL,
  tier TEXT NOT NULL,
  assessment TEXT NOT NULL,
  plan TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  description TEXT NOT NULL,
  files_in_scope TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT,
  concerns TEXT,
  agent_type TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  budget_seconds INTEGER NOT NULL,
  elapsed_seconds REAL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  timestamp TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  budget_seconds INTEGER NOT NULL,
  elapsed_seconds REAL,
  token_input INTEGER,
  token_output INTEGER,
  estimated_cost REAL
);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  file_path TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_in_iteration INTEGER
);
