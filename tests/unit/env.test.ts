import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/config/env";

describe("env defaults for planner config", () => {
  test("PLANNER_MODEL_COMPLEX defaults to a non-empty string", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MODEL_COMPLEX.length).toBeGreaterThan(0);
  });

  test("PLANNER_MODEL_EXPRESS defaults to a non-empty string", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MODEL_EXPRESS.length).toBeGreaterThan(0);
  });

  test("PLANNER_MAX_ITERATIONS defaults to 3", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MAX_ITERATIONS).toBe(3);
  });

  test("PLANNER_MAX_ITERATIONS coerces from string", () => {
    const env = loadEnv({ NODE_ENV: "test", PLANNER_MAX_ITERATIONS: "5" });
    expect(env.PLANNER_MAX_ITERATIONS).toBe(5);
  });
});
