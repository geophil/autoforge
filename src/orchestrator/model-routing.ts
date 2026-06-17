import type { AppEnv } from "../config/env";
import { modelForTier, type ModelTier } from "../runtime/model-selection";
import type { AgentType, PlannerRequestedPhase, Tier } from "../types/core";
import type { TaskPolicyDecision } from "./task-policy";

export type ModelRiskLevel = "low" | "medium" | "high";

export interface ModelRoutingInput {
  agentType: AgentType;
  phase?: PlannerRequestedPhase | "implementation" | "review" | "documentation" | "summarization" | "diagnostic" | "meta";
  tier: Tier;
  description: string;
  filesInScope?: string[];
  failureCount?: number;
  escalation?: boolean;
  priorTier?: ModelTier;
  reason?: string;
  policy?: TaskPolicyDecision;
}

export interface ModelRoutingDecision {
  tier: ModelTier;
  model: string;
  riskLevel: ModelRiskLevel;
  sensitiveAreas: string[];
  rationale: string;
  escalated: boolean;
  escalationReason: string | null;
  candidateTiers: ModelTier[];
}

const AREA_PATTERNS: Array<{ area: string; patterns: RegExp[] }> = [
  { area: "auth", patterns: [/\bauth\b/i, /login/i, /oauth/i, /\bjwt\b/i, /session/i, /permission/i, /\brbac\b/i] },
  { area: "security", patterns: [/security/i, /secret/i, /credential/i, /\btoken\b/i, /encryption/i, /csrf/i, /xss/i] },
  { area: "payments", patterns: [/payment/i, /billing/i, /stripe/i, /invoice/i, /subscription/i] },
  { area: "database", patterns: [/migration/i, /schema/i, /\bsql\b/i, /\bdb\b/i, /sqlite/i, /postgres/i] },
  { area: "production_infra", patterns: [/deploy/i, /docker/i, /terraform/i, /\bk8s\b/i, /kubernetes/i, /\bci\b/i, /github-actions/i] },
  { area: "architecture", patterns: [/architecture/i, /\badr\b/i, /cross-cutting/i, /runtime boundary/i] },
  { area: "orchestrator_runtime", patterns: [/orchestrator/i, /executor/i, /provider/i, /model routing/i, /tool registry/i, /workspace/i] }
];

const PATH_AREA_PATTERNS: Array<{ area: string; patterns: RegExp[] }> = [
  { area: "database", patterns: [/^src\/db\//, /migration/i, /schema\.sql$/] },
  { area: "production_infra", patterns: [/^docker\//, /^\.github\//, /docker-compose/i, /Dockerfile/i] },
  { area: "orchestrator_runtime", patterns: [/^src\/orchestrator\//, /^src\/runtime\//, /^src\/executors\//, /^src\/privileged\//] },
  { area: "security", patterns: [/auth/i, /secret/i, /credential/i, /permission/i] },
  { area: "payments", patterns: [/payment/i, /billing/i, /stripe/i] }
];

const STRONG_MODEL_SENSITIVE_AREAS = new Set([
  "auth",
  "database",
  "orchestrator_runtime",
  "payments",
  "permissions",
  "production_infra",
  "secrets",
  "security"
]);

export function routeModel(env: AppEnv, input: ModelRoutingInput): ModelRoutingDecision {
  const sensitiveAreas = classifySensitiveAreas(input);
  const failureCount = input.failureCount ?? 0;
  const strongSensitiveAreas = sensitiveAreas.filter((area) => STRONG_MODEL_SENSITIVE_AREAS.has(area));
  const candidateTiers: ModelTier[] = ["cheap", "standard", "strong"];
  let selectedTier: ModelTier = input.policy?.modelFloor ?? "standard";
  let rationale = input.policy ? "policy_model_floor" : "standard_default_for_agent_dispatch";

  if (input.phase === "summarization" || input.agentType === "diagnostician") {
    selectedTier = "cheap";
    rationale = "cheap_for_bounded_non_mutating_work";
  }

  if (
    input.escalation ||
    failureCount >= 2 ||
    input.policy?.riskLevel === "high" ||
    strongSensitiveAreas.length > 0
  ) {
    selectedTier = "strong";
    rationale = input.escalation
      ? "strong_after_model_capability_escalation"
      : failureCount >= 2
        ? "strong_after_repeated_failures"
        : input.policy?.riskLevel === "high"
          ? "strong_for_high_risk_policy"
          : "strong_for_sensitive_area";
  }

  // V1 never routes mutating engineering agents to cheap models.
  if (isEngineeringAgent(input.agentType) && selectedTier === "cheap") {
    selectedTier = "standard";
    rationale = "standard_floor_for_engineering_agent";
  }

  return {
    tier: selectedTier,
    model: modelForTier(env, selectedTier),
    riskLevel: maxRiskLevel(input.policy?.riskLevel, riskLevelFor(sensitiveAreas, failureCount, input.tier)),
    sensitiveAreas,
    rationale,
    escalated: input.escalation === true,
    escalationReason: input.escalation ? input.reason ?? "model_capability_retry" : null,
    candidateTiers
  };
}

export function nextStrongerTier(tier: ModelTier): ModelTier | null {
  if (tier === "cheap") return "standard";
  if (tier === "standard") return "strong";
  return null;
}

function classifySensitiveAreas(input: ModelRoutingInput): string[] {
  const text = [input.description, input.phase, input.agentType, input.tier].filter(Boolean).join("\n");
  const areas = new Set<string>(input.policy?.sensitiveAreas ?? []);
  for (const row of AREA_PATTERNS) {
    if (row.patterns.some((pattern) => pattern.test(text))) areas.add(row.area);
  }
  for (const file of input.filesInScope ?? []) {
    for (const row of PATH_AREA_PATTERNS) {
      if (row.patterns.some((pattern) => pattern.test(file))) areas.add(row.area);
    }
  }
  return [...areas].sort();
}

function riskLevelFor(sensitiveAreas: string[], failureCount: number, tier: Tier): ModelRiskLevel {
  if (sensitiveAreas.some((area) => STRONG_MODEL_SENSITIVE_AREAS.has(area)) || failureCount >= 2) return "high";
  if (failureCount === 1 || tier === "STANDARD" || tier === "THOROUGH") return "medium";
  return "low";
}

function maxRiskLevel(policyRisk: ModelRiskLevel | undefined, runtimeRisk: ModelRiskLevel): ModelRiskLevel {
  if (policyRisk === "high" || runtimeRisk === "high") return "high";
  if (policyRisk === "medium" || runtimeRisk === "medium") return "medium";
  return "low";
}

function isEngineeringAgent(agentType: AgentType): boolean {
  return agentType === "planner" || agentType === "coder" || agentType === "reviewer" || agentType === "doc";
}
