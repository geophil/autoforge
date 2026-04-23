-- 002: task-level cumulative diff stats + per-iteration diff deltas.

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

CREATE INDEX IF NOT EXISTS idx_task_iteration_diffs_task
  ON task_iteration_diffs(task_id);
