import type { PlanSubtask } from "../../src/types/core";

/** Planner-shaped subtask with all harness contract fields populated. */
export function fullPlanSubtask(
  overrides: Partial<PlanSubtask> & Pick<PlanSubtask, "id" | "description" | "filesInScope">
): PlanSubtask {
  const testCriteria = overrides.testCriteria ?? ["Tests pass"];
  const verificationCommands = overrides.verificationCommands ?? ["Run project test suite"];
  const completionEvidence =
    overrides.completionEvidence ?? ["Test output shows the project suite passing"];
  return {
    sequence: overrides.sequence ?? 1,
    id: overrides.id,
    description: overrides.description,
    filesInScope: overrides.filesInScope,
    dependencies: overrides.dependencies ?? [],
    behavior: overrides.behavior ?? overrides.description,
    agentType: overrides.agentType,
    testCriteria,
    verificationCommands,
    completionEvidence,
    contractProvided: {
      behavior: true,
      filesInScope: true,
      verificationCommands: true,
      testCriteria: true,
      completionEvidence: true,
      ...overrides.contractProvided
    }
  };
}
