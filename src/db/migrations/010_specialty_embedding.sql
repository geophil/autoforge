-- 010: Opaque embedding bytes for variant specialties. Backfill is application-side.

ALTER TABLE skill_versions ADD COLUMN specialty_embedding BLOB;
