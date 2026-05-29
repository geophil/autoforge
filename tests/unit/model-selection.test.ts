import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/config/env";
import { DEFAULT_CHEAP_MODEL, modelForTier, selectUtilityModel } from "../../src/runtime/model-selection";

describe("model selection", () => {
  test("selects tier models from shared config", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      EXECUTOR_DEFAULT: "mock",
      MODEL_TIER_CHEAP: "cheap-model",
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });

    expect(modelForTier(env, "cheap")).toBe("cheap-model");
    expect(modelForTier(env, "standard")).toBe("standard-model");
    expect(modelForTier(env, "strong")).toBe("strong-model");
  });

  test("uses purpose override for utility model selection", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      EXECUTOR_DEFAULT: "mock",
      MODEL_TIER_CHEAP: "cheap-model",
      HARNESS_COMPACTION_MODEL: "compaction-model",
      HARNESS_COMPACTION_TIMEOUT_SECONDS: "12",
      HARNESS_COMPACTION_MAX_TOKENS: "700"
    });

    expect(selectUtilityModel(env, "compaction")).toMatchObject({
      model: "compaction-model",
      tier: "cheap",
      useCase: "utility",
      purpose: "compaction",
      rationale: "purpose_override_for_compaction",
      timeoutSeconds: 12,
      maxTokens: 700
    });
  });

  test("falls back from cheap tier to default cheap model for utility work", () => {
    const cheapEnv = loadEnv({
      NODE_ENV: "test",
      EXECUTOR_DEFAULT: "mock",
      MODEL_TIER_CHEAP: "cheap-model"
    });
    expect(selectUtilityModel(cheapEnv, "summarization").model).toBe("cheap-model");

    const defaultEnv = loadEnv({ NODE_ENV: "test", EXECUTOR_DEFAULT: "mock" });
    expect(selectUtilityModel(defaultEnv, "extraction").model).toBe(DEFAULT_CHEAP_MODEL);
  });
});
