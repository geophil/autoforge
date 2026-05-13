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
  });

  test("docker workspace env values can be overridden", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      WORKSPACE_DOCKER_IMAGE: "node:22-bookworm",
      WORKSPACE_DOCKER_NETWORK: "bridge",
      WORKSPACE_DOCKER_CPUS: "1",
      WORKSPACE_DOCKER_MEMORY: "1g",
      WORKSPACE_DOCKER_PRECHECK: "0"
    });

    expect(env.WORKSPACE_DOCKER_IMAGE).toBe("node:22-bookworm");
    expect(env.WORKSPACE_DOCKER_NETWORK).toBe("bridge");
    expect(env.WORKSPACE_DOCKER_CPUS).toBe("1");
    expect(env.WORKSPACE_DOCKER_MEMORY).toBe("1g");
    expect(env.WORKSPACE_DOCKER_PRECHECK).toBe("0");
  });
});
