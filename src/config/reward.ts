import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RewardTerm =
  | "correctness"
  | "simplicity"
  | "alignment"
  | "fidelity"
  | "efficiency";

export type RewardWeights = Record<RewardTerm, number>;

export interface RewardComponents {
  r_correctness: number;
  r_simplicity: number;
  r_alignment: number;
  r_fidelity: number;
  r_efficiency: number;
}

const ALL_TERMS: RewardTerm[] = [
  "correctness",
  "simplicity",
  "alignment",
  "fidelity",
  "efficiency"
];
const DEFAULT_REWARD_CONFIG_PATH = resolve(import.meta.dir, "./reward-weights.json");

let cached: RewardWeights | null = null;

export function getRewardWeights(configPath?: string): RewardWeights {
  if (cached && !configPath) {
    return { ...cached };
  }

  const path = configPath ?? DEFAULT_REWARD_CONFIG_PATH;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Reward config must be a JSON object with version and weights");
  }

  if (!("version" in parsed) || parsed.version !== 1) {
    throw new Error("Reward config version must be 1");
  }

  if (!("weights" in parsed) || !parsed.weights || typeof parsed.weights !== "object" || Array.isArray(parsed.weights)) {
    throw new Error("Reward config must include a top-level weights object");
  }

  validateRewardWeights(parsed.weights as RewardWeights);
  const resolvedWeights = Object.freeze({ ...(parsed.weights as RewardWeights) });

  if (!configPath) {
    cached = resolvedWeights;
  }

  return { ...resolvedWeights };
}

export function validateRewardWeights(weights: RewardWeights): void {
  for (const term of ALL_TERMS) {
    if (!(term in weights)) {
      throw new Error(`Reward weights missing key: ${term}`);
    }

    const value = weights[term];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Reward weight for ${term} must be a finite number`);
    }

    if (value < 0) {
      throw new Error(`Reward weight for ${term} is negative: ${value}`);
    }
  }

  const sum = ALL_TERMS.reduce((acc, term) => acc + weights[term], 0);
  if (Math.abs(sum - 1.0) > 1e-6) {
    throw new Error(`Reward weights sum to ${sum}, expected 1.0 (±1e-6)`);
  }
}

export function computeComposite(components: RewardComponents, weights?: RewardWeights): number {
  const resolvedWeights = weights ?? getRewardWeights();

  return (
    resolvedWeights.correctness * components.r_correctness +
    resolvedWeights.simplicity * components.r_simplicity +
    resolvedWeights.alignment * components.r_alignment +
    resolvedWeights.fidelity * components.r_fidelity +
    resolvedWeights.efficiency * components.r_efficiency
  );
}

export function resetRewardWeightsCache(): void {
  cached = null;
}
