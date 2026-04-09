import type { ComplexityAssessment, Tier } from "../types/core";

export function assessComplexity(description: string): ComplexityAssessment {
  const normalized = description.toLowerCase();
  const highRiskKeywords = ["security", "payment", "auth", "migration", "critical"];
  const mediumKeywords = ["dashboard", "workflow", "pipeline", "integration", "api"];
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  const risk = highRiskKeywords.some((key) => normalized.includes(key))
    ? "high"
    : mediumKeywords.some((key) => normalized.includes(key))
      ? "medium"
      : "low";

  const scope = wordCount > 40 ? "large" : wordCount > 12 ? "medium" : "small";
  const novelty = normalized.includes("new") ? "high" : "medium";
  const coupling = normalized.includes("across") || normalized.includes("multiple") ? "high" : "low";

  return {
    scope,
    novelty,
    risk,
    coupling,
    rationale: "Heuristic assessment from request keywords and size.",
    similarPastTasks: []
  };
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
