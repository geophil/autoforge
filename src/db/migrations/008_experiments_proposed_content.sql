-- 008: Persist the proposed persona content on fork/edit experiment rows.
-- Meta cleans up its worktree after every session, so the file referenced by
-- operation.proposed_content_file does not survive. Store the content in the DB
-- so downstream consumers (approval handler, cold-start evaluation) can read it.

ALTER TABLE experiments ADD COLUMN proposed_content TEXT;
