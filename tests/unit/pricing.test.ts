import { describe, expect, test } from "bun:test";
import { getModelCost, loadPricingConfig } from "../../src/runtime/pricing";

describe("Pricing Configuration", () => {
  test("returns default costs if model is unlisted or json fails to load", () => {
    // Before load
    expect(getModelCost("unknown_provider", "unknown_model")).toEqual({ input: 0, output: 0, cached: 0 });
  });

  test("returns correct costs for a known model from config", () => {
    // Assuming we have a standard entry like Anthropic Claude 3.5 Sonnet
    const cost = getModelCost("anthropic", "claude-3-5-sonnet-20241022");
    // Ensure it's defined and has values
    expect(cost.input).toBeGreaterThan(0);
    expect(cost.output).toBeGreaterThan(0);
  });
});
