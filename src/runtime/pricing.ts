import pricing from "./pricing.json";

export interface ModelCost {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens. */
  cached: number;
}

type PricingConfig = Record<string, Record<string, ModelCost>>;

const pricingConfig = pricing as PricingConfig;
const ZERO_COST: ModelCost = { input: 0, output: 0, cached: 0 };

export function getModelCost(provider: string, model: string): ModelCost {
  return pricingConfig[provider]?.[model] ?? ZERO_COST;
}
