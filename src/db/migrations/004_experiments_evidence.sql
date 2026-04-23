-- 004: operation + evidence columns on experiments.

ALTER TABLE experiments ADD COLUMN operation TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE experiments ADD COLUMN evidence TEXT;

-- Existing rows are backfilled to operation='edit' by the DEFAULT clause when the
-- column is added. No separate UPDATE needed.
