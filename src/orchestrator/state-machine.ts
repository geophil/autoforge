import type { TaskStage } from "../types/core";

const allowedTransitions: Record<TaskStage, TaskStage[]> = {
  received: ["assessing", "failed"],
  assessing: ["planning", "failed"],
  planning: ["executing", "failed"],
  executing: ["reviewing", "reworking", "failed"],
  reviewing: ["reworking", "pr_created", "failed"],
  reworking: ["executing", "failed"],
  pr_created: ["awaiting_approval", "reworking", "failed"],
  awaiting_approval: ["documenting", "reworking", "failed"],
  documenting: ["completed", "failed"],
  completed: [],
  failed: []
};

export function canTransition(from: TaskStage, to: TaskStage): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: TaskStage, to: TaskStage): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
