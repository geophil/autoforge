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

  test("model tier overrides are optional and accepted", () => {
    const defaults = loadEnv({ NODE_ENV: "test" });
    expect(defaults.MODEL_TIER_CHEAP).toBeUndefined();
    const env = loadEnv({
      NODE_ENV: "test",
      MODEL_TIER_CHEAP: "cheap",
      MODEL_TIER_STANDARD: "standard",
      MODEL_TIER_STRONG: "strong"
    });
    expect(env.MODEL_TIER_CHEAP).toBe("cheap");
    expect(env.MODEL_TIER_STANDARD).toBe("standard");
    expect(env.MODEL_TIER_STRONG).toBe("strong");
  });

  test("runtime budget guardrail env values have conservative defaults and coerce overrides", () => {
    const defaults = loadEnv({ NODE_ENV: "test" });
    expect(defaults.QMD_MCP_TOTAL_ALLOWANCE_SECONDS).toBe(90);
    expect(defaults.QMD_MCP_CALL_TIMEOUT_SECONDS).toBe(60);
    expect(defaults.PLANNER_FINAL_RESERVE_SECONDS).toBe(75);
    expect(defaults.PLANNER_SPEC_MAX_QMD_CALLS).toBe(6);
    expect(defaults.PLANNER_SPEC_MAX_TOOL_CALLS).toBe(8);
    expect(defaults.MODEL_CALL_TIMEOUT_SECONDS).toBeUndefined();
    expect(defaults.HARNESS_CONTEXT_MAX_CHARS).toBe(120_000);
    expect(defaults.HARNESS_COMPACTION_TIMEOUT_SECONDS).toBe(30);
    expect(defaults.HARNESS_COMPACTION_MAX_TOKENS).toBe(1200);
    expect(defaults.HARNESS_CLASSIFICATION_TIMEOUT_SECONDS).toBe(15);
    expect(defaults.HARNESS_CLASSIFICATION_MAX_TOKENS).toBe(400);

    const env = loadEnv({
      NODE_ENV: "test",
      QMD_MCP_TOTAL_ALLOWANCE_SECONDS: "45",
      QMD_MCP_CALL_TIMEOUT_SECONDS: "10",
      PLANNER_FINAL_RESERVE_SECONDS: "30",
      PLANNER_SPEC_MAX_QMD_CALLS: "2",
      PLANNER_SPEC_MAX_TOOL_CALLS: "4",
      MODEL_CALL_TIMEOUT_SECONDS: "15",
      HARNESS_CONTEXT_MAX_CHARS: "50000",
      HARNESS_COMPACTION_TIMEOUT_SECONDS: "11",
      HARNESS_COMPACTION_MAX_TOKENS: "900"
    });
    expect(env.QMD_MCP_TOTAL_ALLOWANCE_SECONDS).toBe(45);
    expect(env.QMD_MCP_CALL_TIMEOUT_SECONDS).toBe(10);
    expect(env.PLANNER_FINAL_RESERVE_SECONDS).toBe(30);
    expect(env.PLANNER_SPEC_MAX_QMD_CALLS).toBe(2);
    expect(env.PLANNER_SPEC_MAX_TOOL_CALLS).toBe(4);
    expect(env.MODEL_CALL_TIMEOUT_SECONDS).toBe(15);
    expect(env.HARNESS_CONTEXT_MAX_CHARS).toBe(50_000);
    expect(env.HARNESS_COMPACTION_TIMEOUT_SECONDS).toBe(11);
    expect(env.HARNESS_COMPACTION_MAX_TOKENS).toBe(900);
  });

  test("WORKSPACE_PROVIDER defaults to local", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.WORKSPACE_PROVIDER).toBe("local");
  });

  test("WORKSPACE_PROVIDER accepts docker", () => {
    const env = loadEnv({ NODE_ENV: "test", WORKSPACE_PROVIDER: "docker" });
    expect(env.WORKSPACE_PROVIDER).toBe("docker");
  });

  test("docker workspace env values have safe defaults", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.WORKSPACE_DOCKER_IMAGE).toBe("autoforge-agent:local");
    expect(env.WORKSPACE_DOCKER_NETWORK).toBe("none");
    expect(env.WORKSPACE_DOCKER_CPUS).toBe("2");
    expect(env.WORKSPACE_DOCKER_MEMORY).toBe("2g");
    expect(env.WORKSPACE_DOCKER_PRECHECK).toBe("1");
    expect(env.WORKSPACE_DOCKER_UID).toBe(1000);
    expect(env.WORKSPACE_DOCKER_GID).toBe(1000);
    expect(env.WORKSPACE_DOCKER_REAP_ON_START).toBe("0");
  });

  test("docker workspace env values can be overridden", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      WORKSPACE_DOCKER_IMAGE: "node:22-bookworm",
      WORKSPACE_DOCKER_NETWORK: "bridge",
      WORKSPACE_DOCKER_CPUS: "1",
      WORKSPACE_DOCKER_MEMORY: "1g",
      WORKSPACE_DOCKER_PRECHECK: "0",
      WORKSPACE_DOCKER_UID: "501",
      WORKSPACE_DOCKER_GID: "20",
      WORKSPACE_DOCKER_REAP_ON_START: "1"
    });

    expect(env.WORKSPACE_DOCKER_IMAGE).toBe("node:22-bookworm");
    expect(env.WORKSPACE_DOCKER_NETWORK).toBe("bridge");
    expect(env.WORKSPACE_DOCKER_CPUS).toBe("1");
    expect(env.WORKSPACE_DOCKER_MEMORY).toBe("1g");
    expect(env.WORKSPACE_DOCKER_PRECHECK).toBe("0");
    expect(env.WORKSPACE_DOCKER_UID).toBe(501);
    expect(env.WORKSPACE_DOCKER_GID).toBe(20);
    expect(env.WORKSPACE_DOCKER_REAP_ON_START).toBe("1");
  });
});
