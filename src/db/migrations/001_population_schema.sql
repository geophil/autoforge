-- 001: Population-shaped columns on skill_versions + is_active compatibility triggers.

ALTER TABLE skill_versions ADD COLUMN parent_version_id TEXT;
ALTER TABLE skill_versions ADD COLUMN specialty TEXT;
ALTER TABLE skill_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE skill_versions ADD COLUMN traffic_share REAL NOT NULL DEFAULT 0.0;

-- Backfill: for each skill_name, the most recent is_active=1 row becomes baseline.
-- All other rows (including older is_active=1 duplicates, if any) become demoted.
UPDATE skill_versions
   SET status = 'demoted', traffic_share = 0.0
 WHERE 1 = 1;

UPDATE skill_versions
   SET status = 'baseline', traffic_share = 1.0
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (PARTITION BY skill_name ORDER BY created_at DESC) AS rn
       FROM skill_versions
      WHERE is_active = 1
   ) ranked
   WHERE rn = 1
 );

-- Immediately sync legacy is_active for existing rows after backfill.
UPDATE skill_versions
   SET is_active = CASE WHEN status IN ('baseline', 'active') THEN 1 ELSE 0 END;

-- Keep is_active in sync with status for backward compatibility.
CREATE TRIGGER IF NOT EXISTS skill_versions_is_active_sync_update
AFTER UPDATE OF status ON skill_versions
FOR EACH ROW
BEGIN
  UPDATE skill_versions
     SET is_active = CASE WHEN NEW.status IN ('baseline', 'active') THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS skill_versions_is_active_sync_insert
AFTER INSERT ON skill_versions
FOR EACH ROW
BEGIN
  UPDATE skill_versions
     SET is_active = CASE WHEN NEW.status IN ('baseline', 'active') THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;
