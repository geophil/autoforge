export type TaskCheckpointStage =
  | "planning"
  | "executing"
  | "reviewing"
  | "reworking"
  | "awaiting_intervention";

export interface TaskCheckpointPayload {
  checkpoint_id: string;
  task_id: string;
  iteration: number;
  stage: TaskCheckpointStage;
  git_sha: string;
  label: string;
}

const STAGE_ORDER: Record<TaskCheckpointStage, number> = {
  planning: 0,
  executing: 1,
  reviewing: 2,
  reworking: 3,
  awaiting_intervention: 4
};

export function checkpointStageOrder(stage: TaskCheckpointStage): number {
  return STAGE_ORDER[stage];
}

export function parseCheckpointPayload(payload: unknown): TaskCheckpointPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.checkpoint_id !== "string" ||
    typeof record.task_id !== "string" ||
    typeof record.iteration !== "number" ||
    typeof record.stage !== "string" ||
    typeof record.git_sha !== "string" ||
    typeof record.label !== "string"
  ) {
    return null;
  }
  if (!isCheckpointStage(record.stage)) return null;
  return {
    checkpoint_id: record.checkpoint_id,
    task_id: record.task_id,
    iteration: record.iteration,
    stage: record.stage,
    git_sha: record.git_sha,
    label: record.label
  };
}

function isCheckpointStage(stage: string): stage is TaskCheckpointStage {
  return stage in STAGE_ORDER;
}
