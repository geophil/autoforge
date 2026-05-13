import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../../src/config/env";
import { ContainerWorkspace } from "../../src/runtime/container-workspace";
import type { ContainerRunner, DockerCreateArgsInput, DockerExecOptions } from "../../src/runtime/container-runner";
import { LocalWorkspace } from "../../src/runtime/local-workspace";
import { WorkspaceFactory } from "../../src/runtime/workspace-provider";
import type { ExecEvent } from "../../src/runtime/workspace";

class FakeRunner implements ContainerRunner {
  async create(input: DockerCreateArgsInput): Promise<string> {
    return input.name;
  }
  async start(_containerId: string): Promise<void> {}
  async *exec(_containerId: string, _cmd: string, _args: string[], _opts?: DockerExecOptions): AsyncIterable<ExecEvent> {
    yield { kind: "exit", exitCode: 0 };
  }
  async destroy(_containerId: string): Promise<void> {}
}

describe("WorkspaceFactory", () => {
  test("creates LocalWorkspace when provider is local", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-workspace-provider-"));
    const factory = new WorkspaceFactory(loadEnv({ NODE_ENV: "test", WORKSPACE_PROVIDER: "local" }));

    const workspace = await factory.create({ rootPath, taskId: "task-1", dispatchId: "planner" });

    expect(workspace).toBeInstanceOf(LocalWorkspace);
    expect(workspace.provider).toBe("local");
    await rm(rootPath, { recursive: true, force: true });
  });

  test("creates ContainerWorkspace when provider is docker", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-workspace-provider-"));
    const factory = new WorkspaceFactory(
      loadEnv({ NODE_ENV: "test", WORKSPACE_PROVIDER: "docker", WORKSPACE_DOCKER_PRECHECK: "0" }),
      { runner: new FakeRunner() }
    );

    const workspace = await factory.create({ rootPath, taskId: "task-1", dispatchId: "planner" });

    expect(workspace).toBeInstanceOf(ContainerWorkspace);
    expect(workspace.provider).toBe("docker");
    await workspace.destroy();
    await rm(rootPath, { recursive: true, force: true });
  });
});
