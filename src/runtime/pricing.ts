import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelCost {
  input: number; // cost per 1M tokens
  output: number; // cost per 1M tokens
  cached: number; // cost per 1M tokens
}

let pricingCache: Record<string, Record<string, ModelCost>> | null = null;

export function loadPricingConfig(): void {
  try {
    const filePath = join(__dirname, "pricing.json");
    const content = readFileSync(filePath, "utf-8");
    pricingCache = JSON.parse(content);
  } catch (error) {
    console.warn("[pricing] Failed to load pricing.json. Falling back to zero-costs.", error);
    pricingCache = {};
  }
}

export function getModelCost(provider: string, model: string): ModelCost {
  if (!pricingCache) loadPricingConfig();
  
  const providerData = pricingCache?.[provider];
  if (providerData && providerData[model]) {
    return providerData[model];
  }
  return { input: 0, output: 0, cached: 0 };
}
