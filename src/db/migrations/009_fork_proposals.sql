-- 009: Spec D fork proposals from heterogeneity diagnostics.

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

CREATE INDEX IF NOT EXISTS idx_fork_proposals_open
  ON fork_proposals(agent_type, status, generated_at);
