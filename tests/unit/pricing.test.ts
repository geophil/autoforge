import { describe, expect, test } from "bun:test";
import { getModelCost } from "../../src/runtime/pricing";

describe("Pricing Configuration", () => {
  test("returns zero costs for an unknown provider or model", () => {
    expect(getModelCost("unknown_provider", "unknown_model")).toEqual({
      input: 0,
      output: 0,
      cached: 0
    });
    expect(getModelCost("anthropic", "unknown_model")).toEqual({
      input: 0,
      output: 0,
      cached: 0
    });
  });

  test("returns configured costs for known Anthropic models", () => {
    expect(getModelCost("anthropic", "claude-3-5-sonnet-20241022")).toEqual({
      input: 3,
      output: 15,
      cached: 0.3
    });
  });
});
