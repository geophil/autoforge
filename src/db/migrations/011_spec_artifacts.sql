-- Interactive planning: spec artifacts, planning context, review flag, transcript rollback scope.

ALTER TABLE tasks ADD COLUMN spec_artifacts TEXT;
ALTER TABLE tasks ADD COLUMN planning_context TEXT;
ALTER TABLE tasks ADD COLUMN current_blocking_question TEXT;
ALTER TABLE tasks ADD COLUMN review_plan INTEGER;

ALTER TABLE agent_transcripts ADD COLUMN rollback_event_id TEXT;

-- Legacy planner rows were always execution-plan-shaped (subtasks only).
UPDATE agent_transcripts SET stage = 'planner:execution_plan' WHERE stage = 'planner';
