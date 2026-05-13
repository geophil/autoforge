import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace } from "../../src/runtime/container-workspace";
import type { ContainerRunner, DockerCreateArgsInput, DockerExecOptions } from "../../src/runtime/container-runner";
import type { ExecEvent } from "../../src/runtime/workspace";

class FakeRunner implements ContainerRunner {
  creates: DockerCreateArgsInput[] = [];
  starts: string[] = [];
  execs: Array<{ containerId: string; cmd: string; args: string[]; opts?: DockerExecOptions }> = [];
  destroys: string[] = [];

  async create(input: DockerCreateArgsInput): Promise<string> {
    this.creates.push(input);
    return input.name;
  }

  async start(containerId: string): Promise<void> {
    this.starts.push(containerId);
  }

  async *exec(containerId: string, cmd: string, args: string[], opts?: DockerExecOptions): AsyncIterable<ExecEvent> {
    this.execs.push({ containerId, cmd, args, opts });
    yield { kind: "stdout", chunk: "ok" };
    yield { kind: "exit", exitCode: 0 };
  }

  async destroy(containerId: string): Promise<void> {
    this.destroys.push(containerId);
  }
}

describe("ContainerWorkspace", () => {
  test("creates and starts one container for the workspace", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const runner = new FakeRunner();

    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: "task-1",
      dispatchId: "coder",
      image: "autoforge-agent:local",
      network: "none",
      cpus: "2",
      memory: "2g",
      runner
    });

    expect(workspace.provider).toBe("docker");
    expect(runner.creates).toHaveLength(1);
    expect(runner.starts).toEqual([workspace.containerId]);

    await workspace.destroy();
    await rm(rootPath, { recursive: true, force: true });
  });

  test("reads and writes through the mounted host worktree with path safety", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: "task-1",
      dispatchId: "coder",
      image: "autoforge-agent:local",
      network: "none",
      cpus: "2",
      memory: "2g",
      runner: new FakeRunner()
    });

    await workspace.writeFile("nested/example.txt", "hello");

    expect(await workspace.readFile("nested/example.txt")).toBe("hello");
    expect(await readFile(join(rootPath, "nested/example.txt"), "utf8")).toBe("hello");
    await expect(workspace.readFile("../outside.txt")).rejects.toThrow("outside workspace root");

    await workspace.destroy();
    await rm(rootPath, { recursive: true, force: true });
  });

  test("rejects symlink escapes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "autoforge-outside-workspace-"));
    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: "task-1",
      dispatchId: "coder",
      image: "autoforge-agent:local",
      network: "none",
      cpus: "2",
      memory: "2g",
      runner: new FakeRunner()
    });
    await writeFile(join(outsidePath, "secret.txt"), "outside");
    await symlink(outsidePath, join(rootPath, "linked-outside"));

    await expect(workspace.readFile("linked-outside/secret.txt")).rejects.toThrow("outside workspace root");
    await expect(workspace.writeFile("linked-outside/new.txt", "nope")).rejects.toThrow("outside workspace root");

    await workspace.destroy();
    await rm(rootPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  });

  test("exec maps cwd into /workspace", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const runner = new FakeRunner();
    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: "task-1",
      dispatchId: "coder",
      image: "autoforge-agent:local",
      network: "none",
      cpus: "2",
      memory: "2g",
      runner
    });

    for await (const _event of workspace.exec("pwd", [], { cwd: "nested", env: { A: "B" }, timeoutSeconds: 5 })) {
      // drain events
    }

    expect(runner.execs[0]).toMatchObject({
      containerId: workspace.containerId,
      cmd: "pwd",
      args: [],
      opts: { cwd: "/workspace/nested", env: { A: "B" }, timeoutSeconds: 5 }
    });

    await workspace.destroy();
    await rm(rootPath, { recursive: true, force: true });
  });

  test("destroy is idempotent", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const runner = new FakeRunner();
    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: "task-1",
      dispatchId: "coder",
      image: "autoforge-agent:local",
      network: "none",
      cpus: "2",
      memory: "2g",
      runner
    });

    await workspace.destroy();
    await workspace.destroy();

    expect(runner.destroys).toEqual([workspace.containerId]);
    await rm(rootPath, { recursive: true, force: true });
  });

  test("destroys the created container if start fails", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-workspace-"));
    const runner = new FakeRunner();
    runner.start = async (containerId: string): Promise<void> => {
      runner.starts.push(containerId);
      throw new Error("start_boom");
    };

    await expect(
      ContainerWorkspace.create({
        rootPath,
        taskId: "task-1",
        dispatchId: "coder",
        image: "autoforge-agent:local",
        network: "none",
        cpus: "2",
        memory: "2g",
        runner
      })
    ).rejects.toThrow("start_boom");

    expect(runner.creates).toHaveLength(1);
    expect(runner.starts).toHaveLength(1);
    expect(runner.destroys).toEqual([runner.creates[0].name]);

    await rm(rootPath, { recursive: true, force: true });
  });
});
