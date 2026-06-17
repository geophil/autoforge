import type { TaskStage } from "../types/core";

const allowedTransitions: Record<TaskStage, TaskStage[]> = {
  received: ["assessing", "failed", "awaiting_intervention"],
  assessing: ["planning", "failed", "awaiting_intervention"],
  planning: [
    "awaiting_spec_approval",
    "awaiting_plan_approval",
    "executing",
    "failed",
    "awaiting_intervention"
  ],
  awaiting_spec_approval: ["planning", "replanning", "failed"],
  awaiting_plan_approval: ["executing", "replanning", "failed"],
  replanning: ["awaiting_plan_approval", "awaiting_spec_approval", "failed", "awaiting_intervention"],
  executing: ["reviewing", "reworking", "failed", "awaiting_intervention"],
  reviewing: ["reworking", "pr_created", "failed", "awaiting_intervention"],
  reworking: ["executing", "failed", "awaiting_intervention"],
  pr_created: ["awaiting_approval", "reworking", "failed", "awaiting_intervention"],
  awaiting_approval: ["documenting", "reworking", "failed"],
  documenting: ["completed", "failed", "awaiting_intervention"],
  // From awaiting_intervention the operator can cancel (-> failed) or retry,
  // re-entering whichever stage was paused. Listing all re-entry targets keeps
  // retry logic in one place rather than special-casing each caller.
  awaiting_intervention: [
    "failed",
    "awaiting_plan_approval",
    "planning",
    "replanning",
    "executing",
    "reviewing",
    "reworking",
    "documenting"
  ],
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
