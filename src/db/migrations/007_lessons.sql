-- 007: Lessons table — per-lineage memory of corrective/reinforcing patterns.
-- Inserted by the reflector sub-agent after every terminal task state.
-- Retrieved at dispatch and injected into the selected variant's system prompt.

CREATE TABLE IF NOT EXISTS lessons (
  id                 TEXT PRIMARY KEY,
  agent_type         TEXT NOT NULL,
  lineage_root_id    TEXT NOT NULL REFERENCES skill_versions(id),
  source_task_id     TEXT NOT NULL REFERENCES tasks(id),
  source_variant_id  TEXT NOT NULL REFERENCES skill_versions(id),
  trigger_pattern    TEXT NOT NULL,
  failure_category   TEXT,
  finding_categories TEXT,               -- JSON array; nullable
  body               TEXT NOT NULL,      -- ≤ 200 words, TRIGGER/OBSERVATION/PRINCIPLE/EVIDENCE format
  outcome_kind       TEXT NOT NULL CHECK (outcome_kind IN ('corrective', 'reinforcing')),
  retrieval_keywords TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'retired')),
  superseded_by      TEXT REFERENCES lessons(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_lessons_lineage_active
  ON lessons(lineage_root_id, agent_type, status);

CREATE INDEX IF NOT EXISTS idx_lessons_keywords
  ON lessons(retrieval_keywords);
