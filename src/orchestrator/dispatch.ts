import { defaultDispatchConfig, type DispatchConfig } from "../config/dispatch";
import type { DbClient, DispatchVariantRow } from "../db/client";
import type { AgentType, Tier } from "../types/core";
import { filterSpecialtyEligible } from "./classifier";
import { createDeterministicEmbeddingProvider, type EmbeddingProvider } from "./embedding";

export interface SelectionResult {
  variantId: string;
  agentType: AgentType;
  rationale: "only_eligible" | "baseline" | "exploitation" | "exploration" | "shadow_parallel";
  shadowVariantIds: string[];
  eligibleVariantIds: string[];
}

interface DispatcherOptions {
  random?: () => number;
  config?: Partial<DispatchConfig>;
  embeddingProvider?: EmbeddingProvider;
}

interface TaskContext {
  description: string;
  tier: Tier;
  projectId: string;
}

export function createDispatcher(
  db: DbClient,
  opts: DispatcherOptions = {}
): { selectVariant(agentType: AgentType, taskContext: TaskContext): Promise<SelectionResult> } {
  const random = opts.random ?? Math.random;
  const config = { ...defaultDispatchConfig, ...opts.config };
  const embeddingProvider = opts.embeddingProvider ?? createDeterministicEmbeddingProvider();

  return {
    async selectVariant(agentType: AgentType, taskContext: TaskContext): Promise<SelectionResult> {
      const population = db.loadDispatchPopulation(agentType);
      if (population.length === 1) {
        return {
          variantId: population[0].id,
          agentType,
          rationale: "only_eligible",
          shadowVariantIds: [],
          eligibleVariantIds: [population[0].id]
        };
      }

      const eligible = await filterSpecialtyEligible(population, taskContext.description, {
        provider: embeddingProvider,
        similarityThreshold: config.similarityThreshold
      });
      return chooseFromEligible(agentType, eligible, random, config);
    }
  };
}

export function chooseFromEligible(
  agentType: AgentType,
  eligible: DispatchVariantRow[],
  random: () => number,
  config: DispatchConfig
): SelectionResult {
  if (eligible.length === 0) {
    throw new Error(`No dispatch variants eligible for ${agentType}`);
  }

  const eligibleVariantIds = eligible.map((variant) => variant.id);
  const shadowVariantIds = selectShadowVariants(eligible, config.maxShadowVariantsPerAgentType);
  const baseline = eligible.find((variant) => variant.status === "baseline");
  if (!baseline) {
    throw new Error(`No baseline dispatch variant for ${agentType}`);
  }

  const active = eligible.filter((variant) => variant.status === "active");
  const competitors = active;
  const baselineBucket = Math.max(config.baselineMinTrafficShare, baseline.traffic_share);
  const explorationBucket = competitors.length > 0 ? config.epsilon : 0;
  const exploitationBucket = active.length > 0
    ? Math.max(0, 1 - baselineBucket - explorationBucket)
    : 0;
  const bucketRoll = random();

  if (bucketRoll < baselineBucket) {
    return selection(baseline, agentType, "baseline", shadowVariantIds, eligibleVariantIds);
  }

  if (bucketRoll < baselineBucket + explorationBucket && competitors.length > 0) {
    return selection(
      selectUniform(competitors, random()),
      agentType,
      "exploration",
      shadowVariantIds,
      eligibleVariantIds
    );
  }

  if (bucketRoll < baselineBucket + explorationBucket + exploitationBucket && active.length > 0) {
    return selection(
      selectWeighted(active, random()),
      agentType,
      "exploitation",
      shadowVariantIds,
      eligibleVariantIds
    );
  }

  return selection(baseline, agentType, "baseline", shadowVariantIds, eligibleVariantIds);
}

function selection(
  variant: DispatchVariantRow,
  agentType: AgentType,
  rationale: SelectionResult["rationale"],
  shadowVariantIds: string[],
  eligibleVariantIds: string[]
): SelectionResult {
  return {
    variantId: variant.id,
    agentType,
    rationale,
    shadowVariantIds,
    eligibleVariantIds
  };
}

function selectShadowVariants(eligible: DispatchVariantRow[], limit: number): string[] {
  return eligible
    .filter((variant) => variant.status === "candidate")
    .sort((a, b) => {
      const createdOrder = b.created_at.localeCompare(a.created_at);
      return createdOrder === 0 ? b.id.localeCompare(a.id) : createdOrder;
    })
    .slice(0, limit)
    .map((variant) => variant.id);
}

function selectUniform(variants: DispatchVariantRow[], roll: number): DispatchVariantRow {
  const index = Math.min(Math.floor(roll * variants.length), variants.length - 1);
  return variants[index];
}

function selectWeighted(variants: DispatchVariantRow[], roll: number): DispatchVariantRow {
  const totalWeight = variants.reduce((sum, variant) => sum + Math.max(0, variant.traffic_share), 0);
  if (totalWeight <= 0) {
    return selectUniform(variants, roll);
  }

  const target = roll * totalWeight;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += Math.max(0, variant.traffic_share);
    if (target < cumulative) {
      return variant;
    }
  }
  return variants[variants.length - 1];
}
