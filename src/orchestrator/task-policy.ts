import type { AppEnv } from "../config/env";
import type { ComplexityAssessment, Tier } from "../types/core";
import type { ModelProvider } from "../runtime/model-provider";
import { AnthropicProvider } from "../runtime/anthropic-provider";
import { selectUtilityModel, type ModelTier } from "../runtime/model-selection";
import { UtilityModelCaller } from "../runtime/utility-model-caller";
import { TelemetryLedger } from "../executors/telemetry";

export type TaskPolicyTaskType =
  | "bugfix"
  | "feature"
  | "refactor"
  | "migration"
  | "infrastructure"
  | "security"
  | "documentation"
  | "unknown";

export type TaskPolicyRiskLevel = "low" | "medium" | "high";

export type TaskPolicySensitiveArea =
  | "auth"
  | "payments"
  | "database"
  | "production_infra"
  | "secrets"
  | "permissions"
  | "customer_facing"
  | "orchestrator_runtime"
  | "security";

export type ToolBundle = "core_read" | "core_write" | "exec" | "artifact" | "skills" | "qmd" | "future_specialized";

export interface TaskPolicyDecision {
  taskType: TaskPolicyTaskType;
  riskLevel: TaskPolicyRiskLevel;
  sensitiveAreas: TaskPolicySensitiveArea[];
  confidence: number;
  signals: string[];
  budgetClass: "small" | "normal" | "high";
  tier: Tier;
  modelFloor: ModelTier;
  requiredGates: {
    planReview: boolean;
    modelReview: boolean;
    prGate: boolean;
  };
  toolPolicy: {
    allowedBundles: ToolBundle[];
    qmd: "none" | "planner" | "planner_and_doc";
    reasons: string[];
  };
  retryPolicy: {
    modelEscalationRetries: number;
    reworkIterations: number;
  };
  assessment: ComplexityAssessment;
  sources: {
    deterministic: DeterministicPolicyScan;
    llm: LlmPolicyOutcome;
    final: "deterministic" | "merged" | "tier_override";
    tierOverride?: Tier;
  };
}

export interface TaskPolicyInput {
  description: string;
  filesInScope?: string[];
}

export interface LlmPolicyClassification {
  taskType?: TaskPolicyTaskType;
  riskLevel?: TaskPolicyRiskLevel;
  sensitiveAreas?: TaskPolicySensitiveArea[];
  confidence?: number;
  rationale?: string;
  signals?: string[];
}

export interface LlmPolicyOutcome {
  status: "skipped" | "success" | "fallback";
  classification: LlmPolicyClassification | null;
  reason?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  latencyMs?: number;
}

export interface TaskPolicyLlmClassifier {
  classify(input: TaskPolicyInput, deterministic: DeterministicPolicyScan): Promise<LlmPolicyOutcome>;
}

export interface DeterministicPolicyScan {
  taskType: TaskPolicyTaskType;
  riskLevel: TaskPolicyRiskLevel;
  sensitiveAreas: TaskPolicySensitiveArea[];
  confidence: number;
  signals: string[];
  wordCount: number;
  scope: ComplexityAssessment["scope"];
  coupling: ComplexityAssessment["coupling"];
  hardHighRisk: boolean;
}

const SENSITIVE_AREA_PATTERNS: Array<{ area: TaskPolicySensitiveArea; patterns: RegExp[]; hardHighRisk?: boolean }> = [
  { area: "auth", patterns: [/\bauth\b/i, /login/i, /oauth/i, /\bjwt\b/i, /session/i], hardHighRisk: true },
  { area: "permissions", patterns: [/permission/i, /\brbac\b/i, /access control/i], hardHighRisk: true },
  { area: "security", patterns: [/security/i, /encryption/i, /csrf/i, /xss/i, /vulnerability/i, /exploit/i, /critical/i, /outage/i, /\bprod(?:uction)?\b/i], hardHighRisk: true },
  { area: "secrets", patterns: [/secret/i, /credential/i, /\btoken\b/i, /api key/i], hardHighRisk: true },
  { area: "payments", patterns: [/payment/i, /billing/i, /stripe/i, /invoice/i, /subscription/i], hardHighRisk: true },
  { area: "database", patterns: [/migration/i, /schema/i, /\bsql\b/i, /\bdb\b/i, /sqlite/i, /postgres/i], hardHighRisk: true },
  { area: "production_infra", patterns: [/deploy/i, /docker/i, /terraform/i, /\bk8s\b/i, /kubernetes/i, /\bci\b/i, /github-actions/i], hardHighRisk: true },
  { area: "orchestrator_runtime", patterns: [/orchestrator/i, /executor/i, /provider/i, /model routing/i, /tool registry/i, /workspace/i] },
  { area: "customer_facing", patterns: [/customer/i, /user-facing/i, /public api/i, /dashboard/i, /\bapi\b/i] }
];

const PATH_AREA_PATTERNS: Array<{ area: TaskPolicySensitiveArea; patterns: RegExp[]; hardHighRisk?: boolean }> = [
  { area: "database", patterns: [/^src\/db\//, /migration/i, /schema\.sql$/], hardHighRisk: true },
  { area: "production_infra", patterns: [/^docker\//, /^\.github\//, /docker-compose/i, /Dockerfile/i], hardHighRisk: true },
  { area: "orchestrator_runtime", patterns: [/^src\/orchestrator\//, /^src\/runtime\//, /^src\/executors\//, /^src\/privileged\//] },
  { area: "secrets", patterns: [/secret/i, /credential/i] },
  { area: "auth", patterns: [/auth/i] },
  { area: "permissions", patterns: [/permission/i] },
  { area: "payments", patterns: [/payment/i, /billing/i, /stripe/i] }
];

export async function decideTaskPolicy(
  input: TaskPolicyInput,
  options: { llmClassifier?: TaskPolicyLlmClassifier | null } = {}
): Promise<TaskPolicyDecision> {
  const deterministic = scanTaskPolicy(input);
  let llm: LlmPolicyOutcome = { status: "skipped", classification: null, reason: "no_classifier_configured" };
  if (options.llmClassifier) {
    try {
      llm = await options.llmClassifier.classify(input, deterministic);
    } catch (error) {
      llm = {
        status: "fallback",
        classification: null,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return buildPolicyDecision(input, deterministic, llm, "merged");
}

export function deterministicTaskPolicy(input: TaskPolicyInput): TaskPolicyDecision {
  const deterministic = scanTaskPolicy(input);
  return buildPolicyDecision(
    input,
    deterministic,
    { status: "skipped", classification: null, reason: "deterministic_only" },
    "deterministic"
  );
}

export function withTierOverride(policy: TaskPolicyDecision, tier: Tier): TaskPolicyDecision {
  return {
    ...policy,
    tier,
    requiredGates: gatesForTier(tier),
    assessment: {
      ...policy.assessment,
      rationale: `${policy.assessment.rationale} Tier overridden to ${tier}.`
    },
    sources: {
      ...policy.sources,
      final: "tier_override",
      tierOverride: tier
    }
  };
}

export function scanTaskPolicy(input: TaskPolicyInput): DeterministicPolicyScan {
  const normalized = input.description.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const scope: ComplexityAssessment["scope"] = wordCount > 40 ? "large" : wordCount > 12 ? "medium" : "small";
  const coupling: ComplexityAssessment["coupling"] =
    /\bacross\b/i.test(input.description) || /\bmultiple\b/i.test(input.description) ? "high" : "low";

  const signals: string[] = [];
  const areas = new Set<TaskPolicySensitiveArea>();
  let hardHighRisk = false;

  for (const row of SENSITIVE_AREA_PATTERNS) {
    if (row.patterns.some((pattern) => pattern.test(input.description))) {
      areas.add(row.area);
      signals.push(`description:${row.area}`);
      hardHighRisk = hardHighRisk || row.hardHighRisk === true;
    }
  }
  for (const file of input.filesInScope ?? []) {
    for (const row of PATH_AREA_PATTERNS) {
      if (row.patterns.some((pattern) => pattern.test(file))) {
        areas.add(row.area);
        signals.push(`file:${row.area}:${file}`);
        hardHighRisk = hardHighRisk || row.hardHighRisk === true;
      }
    }
  }

  const taskType = classifyTaskType(normalized, areas);
  if (taskType !== "unknown") signals.push(`task_type:${taskType}`);
  if (scope !== "small") signals.push(`scope:${scope}`);
  if (coupling === "high") signals.push("coupling:high");

  let riskLevel: TaskPolicyRiskLevel = "medium";
  let confidence = 0.45;
  if (hardHighRisk) {
    riskLevel = "high";
    confidence = 0.9;
  } else if (areas.size > 0 || scope === "large" || coupling === "high") {
    riskLevel = "medium";
    confidence = 0.7;
  } else if (isClearlyLowRisk(normalized, taskType, wordCount)) {
    riskLevel = "low";
    confidence = 0.72;
    signals.push("low_risk:bounded_text_or_docs");
  }

  return {
    taskType,
    riskLevel,
    sensitiveAreas: [...areas].sort(),
    confidence,
    signals: [...new Set(signals)].sort(),
    wordCount,
    scope,
    coupling,
    hardHighRisk
  };
}

export function createTaskPolicyLlmClassifier(env: AppEnv, provider?: ModelProvider): TaskPolicyLlmClassifier | null {
  if (env.EXECUTOR_DEFAULT === "mock") return null;
  const modelProvider = provider ?? (
    env.ANTHROPIC_API_KEY
      ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
      : null
  );
  if (!modelProvider) return null;

  return {
    async classify(input, deterministic) {
      const ledger = new TelemetryLedger();
      const caller = new UtilityModelCaller(modelProvider, ledger, "orchestrator");
      const selection = selectUtilityModel(env, "classification") as ReturnType<typeof selectUtilityModel> & { purpose: "classification" };
      const result = await caller.call({
        selection,
        prompt: buildLlmPolicyPrompt(input, deterministic)
      });
      const parsed = parseLlmClassification(result.text);
      if (!parsed) {
        return {
          status: "fallback",
          classification: null,
          reason: "invalid_json",
          model: selection.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCost: result.estimatedCost,
          latencyMs: result.latencyMs
        };
      }
      return {
        status: "success",
        classification: parsed,
        model: selection.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCost: result.estimatedCost,
        latencyMs: result.latencyMs
      };
    }
  };
}

function buildPolicyDecision(
  input: TaskPolicyInput,
  deterministic: DeterministicPolicyScan,
  llm: LlmPolicyOutcome,
  finalSource: TaskPolicyDecision["sources"]["final"]
): TaskPolicyDecision {
  const merged = mergeClassification(deterministic, llm.classification);
  const tier = tierForRisk(merged.riskLevel);
  const assessment = assessmentForPolicy(input, deterministic, merged, tier);
  const allowedBundles: ToolBundle[] = merged.riskLevel === "low"
    ? ["core_read", "core_write", "exec", "artifact"]
    : ["core_read", "core_write", "exec", "artifact", "skills"];
  const qmd = qmdPolicyFor(merged);

  return {
    taskType: merged.taskType,
    riskLevel: merged.riskLevel,
    sensitiveAreas: merged.sensitiveAreas,
    confidence: merged.confidence,
    signals: merged.signals,
    budgetClass: merged.riskLevel === "high" ? "high" : merged.riskLevel === "low" ? "small" : "normal",
    tier,
    modelFloor: merged.riskLevel === "high" ? "strong" : "standard",
    requiredGates: gatesForTier(tier),
    toolPolicy: {
      allowedBundles: qmd === "none" ? allowedBundles : [...allowedBundles, "qmd"],
      qmd,
      reasons: qmd === "none"
        ? []
        : qmd === "planner_and_doc"
        ? ["planner_grounding", "documentation_grounding"]
        : ["planner_grounding"]
    },
    retryPolicy: {
      modelEscalationRetries: 1,
      reworkIterations: merged.riskLevel === "high" ? 2 : 3
    },
    assessment,
    sources: {
      deterministic,
      llm,
      final: finalSource
    }
  };
}

function mergeClassification(
  deterministic: DeterministicPolicyScan,
  llm: LlmPolicyClassification | null
): {
  taskType: TaskPolicyTaskType;
  riskLevel: TaskPolicyRiskLevel;
  sensitiveAreas: TaskPolicySensitiveArea[];
  confidence: number;
  signals: string[];
} {
  const llmConfidence = clampConfidence(llm?.confidence);
  const llmRisk = llm?.riskLevel;
  const deterministicRank = riskRank(deterministic.riskLevel);
  const llmRank = llmRisk ? riskRank(llmRisk) : -1;
  let riskLevel = deterministic.riskLevel;

  if (deterministic.hardHighRisk) {
    riskLevel = "high";
  } else if (llmRisk && llmRank > deterministicRank) {
    riskLevel = llmRisk;
  } else if (
    deterministic.riskLevel === "medium" &&
    llmRisk === "low" &&
    deterministic.confidence < 0.55 &&
    llmConfidence >= 0.7 &&
    deterministic.sensitiveAreas.length === 0
  ) {
    riskLevel = "low";
  }
  if (riskLevel === "low" && Math.max(deterministic.confidence, llmConfidence) < 0.5) {
    riskLevel = "medium";
  }

  const sensitiveAreas = new Set<TaskPolicySensitiveArea>(deterministic.sensitiveAreas);
  for (const area of llm?.sensitiveAreas ?? []) sensitiveAreas.add(area);
  if (sensitiveAreas.size > 0 && riskLevel === "low") riskLevel = "medium";

  const taskType = llm?.taskType && llmConfidence >= 0.55 ? llm.taskType : deterministic.taskType;
  const confidence = Math.max(deterministic.confidence, llmConfidence || 0);
  const signals = [
    ...deterministic.signals,
    ...(llm?.signals ?? []).map((signal) => `llm:${signal}`),
    ...(llm?.rationale ? [`llm_rationale:${llm.rationale}`] : [])
  ];

  return {
    taskType,
    riskLevel,
    sensitiveAreas: [...sensitiveAreas].sort(),
    confidence,
    signals: [...new Set(signals)].sort()
  };
}

function assessmentForPolicy(
  input: TaskPolicyInput,
  deterministic: DeterministicPolicyScan,
  merged: {
    riskLevel: TaskPolicyRiskLevel;
    taskType: TaskPolicyTaskType;
    sensitiveAreas: TaskPolicySensitiveArea[];
    confidence: number;
    signals: string[];
  },
  tier: Tier
): ComplexityAssessment {
  const novelty: ComplexityAssessment["novelty"] =
    /\bnew\b/i.test(input.description) || merged.taskType === "feature"
      ? (merged.riskLevel === "low" ? "medium" : "high")
      : merged.riskLevel === "low"
        ? "low"
        : "medium";
  return {
    scope: deterministic.scope,
    novelty,
    risk: merged.riskLevel,
    coupling: deterministic.coupling,
    rationale: `Task policy classified ${merged.taskType} as ${merged.riskLevel} risk (${tier}) with confidence ${merged.confidence.toFixed(2)}.`,
    similarPastTasks: []
  };
}

function classifyTaskType(normalized: string, areas: Set<TaskPolicySensitiveArea>): TaskPolicyTaskType {
  if (areas.has("payments")) return "security";
  if (areas.has("auth") || areas.has("permissions") || areas.has("secrets") || areas.has("security")) return "security";
  if (areas.has("database") && /migration|schema/.test(normalized)) return "migration";
  if (areas.has("production_infra")) return "infrastructure";
  if (/docs?|documentation|readme|copy|typo|comment/.test(normalized)) return "documentation";
  if (/bug|fix|broken|error|failure|regression/.test(normalized)) return "bugfix";
  if (/refactor|simplify|cleanup|restructure/.test(normalized)) return "refactor";
  if (/add|implement|create|support|new/.test(normalized)) return "feature";
  return "unknown";
}

function isClearlyLowRisk(normalized: string, taskType: TaskPolicyTaskType, wordCount: number): boolean {
  if (wordCount > 16) return false;
  if (taskType === "documentation") return true;
  if (taskType === "bugfix" && /typo|copy|text|style|css|label|button/.test(normalized)) return true;
  return false;
}

function tierForRisk(risk: TaskPolicyRiskLevel): Tier {
  if (risk === "high") return "THOROUGH";
  if (risk === "medium") return "STANDARD";
  return "EXPRESS";
}

function gatesForTier(tier: Tier): TaskPolicyDecision["requiredGates"] {
  return {
    planReview: tier !== "EXPRESS",
    modelReview: tier !== "EXPRESS",
    prGate: true
  };
}

function qmdPolicyFor(merged: {
  riskLevel: TaskPolicyRiskLevel;
  taskType: TaskPolicyTaskType;
  sensitiveAreas: TaskPolicySensitiveArea[];
}): TaskPolicyDecision["toolPolicy"]["qmd"] {
  if (merged.sensitiveAreas.includes("orchestrator_runtime")) return "planner_and_doc";
  if (merged.taskType === "documentation" && merged.riskLevel !== "low") return "planner_and_doc";
  if (merged.riskLevel === "low") return "none";
  return "planner";
}

function riskRank(risk: TaskPolicyRiskLevel): number {
  if (risk === "high") return 2;
  if (risk === "medium") return 1;
  return 0;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function buildLlmPolicyPrompt(input: TaskPolicyInput, deterministic: DeterministicPolicyScan): string {
  return [
    "Classify this software-development task for cost/risk policy.",
    "Return JSON only. Do not include markdown.",
    "Schema:",
    JSON.stringify({
      taskType: "bugfix|feature|refactor|migration|infrastructure|security|documentation|unknown",
      riskLevel: "low|medium|high",
      sensitiveAreas: ["auth|payments|database|production_infra|secrets|permissions|customer_facing|orchestrator_runtime|security"],
      confidence: 0.0,
      rationale: "short reason",
      signals: ["short signal strings"]
    }),
    "",
    "Rules:",
    "- Use low only for tightly bounded non-sensitive work.",
    "- Use medium when uncertain.",
    "- Use high for auth, payments, secrets, database migrations/schema integrity, production infra, permissions, or security.",
    "",
    `Task: ${input.description}`,
    `Files in scope: ${(input.filesInScope ?? []).join(", ") || "(unknown)"}`,
    `Deterministic pre-scan: ${JSON.stringify(deterministic)}`
  ].join("\n");
}

function parseLlmClassification(text: string): LlmPolicyClassification | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const taskType = isTaskType(parsed.taskType) ? parsed.taskType : undefined;
    const riskLevel = isRiskLevel(parsed.riskLevel) ? parsed.riskLevel : undefined;
    const sensitiveAreas = Array.isArray(parsed.sensitiveAreas)
      ? parsed.sensitiveAreas.filter(isSensitiveArea)
      : undefined;
    return {
      taskType,
      riskLevel,
      sensitiveAreas,
      confidence: typeof parsed.confidence === "number" ? clampConfidence(parsed.confidence) : undefined,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 500) : undefined,
      signals: Array.isArray(parsed.signals)
        ? parsed.signals.filter((signal): signal is string => typeof signal === "string").slice(0, 12)
        : undefined
    };
  } catch {
    return null;
  }
}

function isTaskType(value: unknown): value is TaskPolicyTaskType {
  return value === "bugfix" ||
    value === "feature" ||
    value === "refactor" ||
    value === "migration" ||
    value === "infrastructure" ||
    value === "security" ||
    value === "documentation" ||
    value === "unknown";
}

function isRiskLevel(value: unknown): value is TaskPolicyRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isSensitiveArea(value: unknown): value is TaskPolicySensitiveArea {
  return value === "auth" ||
    value === "payments" ||
    value === "database" ||
    value === "production_infra" ||
    value === "secrets" ||
    value === "permissions" ||
    value === "customer_facing" ||
    value === "orchestrator_runtime" ||
    value === "security";
}
