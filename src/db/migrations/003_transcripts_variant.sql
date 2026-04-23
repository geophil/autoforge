-- 003: persona_version_id on agent_transcripts with one-time backfill from events.

ALTER TABLE agent_transcripts ADD COLUMN persona_version_id TEXT;

WITH transcript_windows AS (
  SELECT
    id,
    task_id,
    stage,
    created_at,
    LEAD(created_at) OVER (
      PARTITION BY task_id, stage
      ORDER BY attempt ASC, created_at ASC, id ASC
    ) AS next_created_at
  FROM agent_transcripts
)
UPDATE agent_transcripts
SET persona_version_id = (
  SELECT json_extract(e.payload, '$.persona_version_id')
  FROM transcript_windows tw
  JOIN events e
    ON e.task_id = tw.task_id
   AND e.agent = tw.stage
  WHERE tw.id = agent_transcripts.id
    AND e.timestamp >= tw.created_at
    AND (tw.next_created_at IS NULL OR e.timestamp < tw.next_created_at)
    AND json_extract(e.payload, '$.persona_version_id') IS NOT NULL
  ORDER BY e.timestamp ASC, e.id ASC
  LIMIT 1
);
