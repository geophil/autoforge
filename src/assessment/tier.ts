import type { ComplexityAssessment, Tier } from "../types/core";
import { deterministicTaskPolicy } from "../orchestrator/task-policy";

export function assessComplexity(description: string): ComplexityAssessment {
  return deterministicTaskPolicy({ description }).assessment;
}

export function routeTier(assessment: ComplexityAssessment): Tier {
  if (assessment.scope === "large" || assessment.novelty === "high" || assessment.risk === "high" || assessment.coupling === "high") {
    return "THOROUGH";
  }
  if (assessment.scope === "medium" || assessment.novelty === "medium" || assessment.risk === "medium" || assessment.coupling === "medium") {
    return "STANDARD";
  }
  return "EXPRESS";
}
