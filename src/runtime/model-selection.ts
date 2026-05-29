export type ModelTier = "cheap" | "standard" | "strong";
export type ModelUseCase = "agent_dispatch" | "utility";
export type UtilityModelPurpose = "compaction" | "summarization" | "classification" | "extraction";

export interface ModelSelectionConfig {
  ANTHROPIC_MODEL: string;
  MODEL_TIER_CHEAP?: string;
  MODEL_TIER_STANDARD?: string;
  MODEL_TIER_STRONG?: string;
  PLANNER_MODEL_EXPRESS?: string;
  PLANNER_MODEL_COMPLEX?: string;
  HARNESS_COMPACTION_MODEL?: string;
  HARNESS_SUMMARIZATION_MODEL?: string;
  HARNESS_CLASSIFICATION_MODEL?: string;
  HARNESS_EXTRACTION_MODEL?: string;
  HARNESS_COMPACTION_TIMEOUT_SECONDS?: number;
  HARNESS_SUMMARIZATION_TIMEOUT_SECONDS?: number;
  HARNESS_CLASSIFICATION_TIMEOUT_SECONDS?: number;
  HARNESS_EXTRACTION_TIMEOUT_SECONDS?: number;
  HARNESS_COMPACTION_MAX_TOKENS?: number;
  HARNESS_SUMMARIZATION_MAX_TOKENS?: number;
  HARNESS_CLASSIFICATION_MAX_TOKENS?: number;
  HARNESS_EXTRACTION_MAX_TOKENS?: number;
}

export interface ModelSelectionDecision {
  model: string;
  tier: ModelTier;
  useCase: ModelUseCase;
  purpose?: UtilityModelPurpose;
  rationale: string;
  timeoutSeconds?: number;
  maxTokens?: number;
}

export const DEFAULT_CHEAP_MODEL = "claude-3-haiku-20240307";

export function modelForTier(config: ModelSelectionConfig, tier: ModelTier): string {
  if (tier === "cheap") return config.MODEL_TIER_CHEAP ?? config.PLANNER_MODEL_EXPRESS ?? config.ANTHROPIC_MODEL;
  if (tier === "standard") return config.MODEL_TIER_STANDARD ?? config.ANTHROPIC_MODEL;
  return config.MODEL_TIER_STRONG ?? config.PLANNER_MODEL_COMPLEX ?? config.ANTHROPIC_MODEL;
}

export function selectUtilityModel(
  config: ModelSelectionConfig,
  purpose: UtilityModelPurpose
): ModelSelectionDecision {
  const override = utilityModelOverride(config, purpose);
  return {
    model: override ?? config.MODEL_TIER_CHEAP ?? DEFAULT_CHEAP_MODEL,
    tier: "cheap",
    useCase: "utility",
    purpose,
    rationale: override
      ? `purpose_override_for_${purpose}`
      : config.MODEL_TIER_CHEAP
        ? "cheap_tier_for_bounded_utility_work"
        : "default_cheap_model_for_bounded_utility_work",
    timeoutSeconds: utilityTimeout(config, purpose),
    maxTokens: utilityMaxTokens(config, purpose)
  };
}

function utilityModelOverride(config: ModelSelectionConfig, purpose: UtilityModelPurpose): string | undefined {
  if (purpose === "compaction") return config.HARNESS_COMPACTION_MODEL;
  if (purpose === "summarization") return config.HARNESS_SUMMARIZATION_MODEL;
  if (purpose === "classification") return config.HARNESS_CLASSIFICATION_MODEL;
  return config.HARNESS_EXTRACTION_MODEL;
}

function utilityTimeout(config: ModelSelectionConfig, purpose: UtilityModelPurpose): number {
  if (purpose === "compaction") return config.HARNESS_COMPACTION_TIMEOUT_SECONDS ?? 30;
  if (purpose === "summarization") return config.HARNESS_SUMMARIZATION_TIMEOUT_SECONDS ?? 30;
  if (purpose === "classification") return config.HARNESS_CLASSIFICATION_TIMEOUT_SECONDS ?? 15;
  return config.HARNESS_EXTRACTION_TIMEOUT_SECONDS ?? 20;
}

function utilityMaxTokens(config: ModelSelectionConfig, purpose: UtilityModelPurpose): number {
  if (purpose === "compaction") return config.HARNESS_COMPACTION_MAX_TOKENS ?? 1200;
  if (purpose === "summarization") return config.HARNESS_SUMMARIZATION_MAX_TOKENS ?? 1200;
  if (purpose === "classification") return config.HARNESS_CLASSIFICATION_MAX_TOKENS ?? 400;
  return config.HARNESS_EXTRACTION_MAX_TOKENS ?? 800;
}
