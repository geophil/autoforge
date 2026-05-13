import { describe, expect, test } from "bun:test";
import {
  buildDockerPreflightChecks,
  classifyContainerFailure
} from "../../src/runtime/container-diagnostics";

describe("container diagnostics", () => {
  test("builds preflight checks for daemon and image availability", () => {
    expect(buildDockerPreflightChecks("autoforge-agent:local")).toEqual([
      { category: "preflight", cmd: "docker", args: ["info"] },
      { category: "preflight", cmd: "docker", args: ["image", "inspect", "autoforge-agent:local"] }
    ]);
  });

  test("classifies daemon failures", () => {
    expect(classifyContainerFailure("preflight", "Cannot connect to the Docker daemon")).toEqual({
      category: "preflight",
      reason: "docker_daemon_unavailable"
    });
  });

  test("classifies missing image failures", () => {
    expect(classifyContainerFailure("preflight", "No such image: autoforge-agent:local")).toEqual({
      category: "preflight",
      reason: "docker_image_missing"
    });
  });

  test("preserves lifecycle category for unknown failures", () => {
    expect(classifyContainerFailure("exec", "permission denied")).toEqual({
      category: "exec",
      reason: "container_exec_failed"
    });
  });
});
