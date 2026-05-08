import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../../src/runtime/local-workspace";
import type { ExecEvent } from "../../src/runtime/workspace";

async function collectExec(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const collected: ExecEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("LocalWorkspace", () => {
  test("reads and writes files relative to the workspace root", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });

    await workspace.writeFile("nested/example.txt", "hello workspace");

    expect(await workspace.readFile("nested/example.txt")).toBe("hello workspace");
    expect(await readFile(join(rootPath, "nested/example.txt"), "utf8")).toBe("hello workspace");

    await rm(rootPath, { recursive: true, force: true });
  });

  test("rejects path traversal outside the workspace root", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });

    await expect(workspace.readFile("../outside.txt")).rejects.toThrow("outside workspace root");
    await expect(workspace.writeFile("../outside.txt", "nope")).rejects.toThrow("outside workspace root");

    await rm(rootPath, { recursive: true, force: true });
  });

  test("rejects reads and writes that escape through symlinks", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "autoforge-outside-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });
    await writeFile(join(outsidePath, "secret.txt"), "outside");
    await symlink(outsidePath, join(rootPath, "linked-outside"));

    await expect(workspace.readFile("linked-outside/secret.txt")).rejects.toThrow("outside workspace root");
    await expect(workspace.writeFile("linked-outside/new.txt", "nope")).rejects.toThrow("outside workspace root");

    await expect(readFile(join(outsidePath, "new.txt"), "utf8")).rejects.toThrow();

    await rm(rootPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  });

  test("exec streams stdout, stderr, and exit events from the workspace root", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });
    await workspace.writeFile("marker.txt", "from file");

    const events = await collectExec(workspace.exec("sh", ["-c", "pwd; cat marker.txt; echo err >&2"]));

    expect(events.some((event) => event.kind === "stdout" && event.chunk.includes(rootPath))).toBe(true);
    expect(events.some((event) => event.kind === "stdout" && event.chunk.includes("from file"))).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.chunk.includes("err"))).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "exit", exitCode: 0 });

    await rm(rootPath, { recursive: true, force: true });
  });

  test("exec does not inherit orchestrator secrets from process.env", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });
    const previousSecret = process.env.AUTOFORGE_TEST_SECRET;
    process.env.AUTOFORGE_TEST_SECRET = "super-secret";

    try {
      const events = await collectExec(workspace.exec("sh", ["-c", "printf ${AUTOFORGE_TEST_SECRET:-missing}"]));

      expect(events.some((event) => event.kind === "stdout" && event.chunk === "missing")).toBe(true);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.AUTOFORGE_TEST_SECRET;
      } else {
        process.env.AUTOFORGE_TEST_SECRET = previousSecret;
      }
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("exec rejects cwd values that escape through symlinks", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "autoforge-outside-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });
    await symlink(outsidePath, join(rootPath, "linked-outside"));

    await expect(collectExec(workspace.exec("pwd", [], { cwd: "linked-outside" }))).rejects.toThrow(
      "outside workspace root"
    );

    await rm(rootPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  });

  test("exec reports one non-zero exit event when spawn fails", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });

    const events = await collectExec(workspace.exec("autoforge-missing-command", []));
    const exits = events.filter((event) => event.kind === "exit");

    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ kind: "exit", exitCode: 127 });

    await rm(rootPath, { recursive: true, force: true });
  });

  test("exec reports a signal and non-zero exit code when timeout kills a process", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });

    const events = await collectExec(workspace.exec("sh", ["-c", "sleep 2"], { timeoutSeconds: 0.05 }));

    expect(events.at(-1)).toEqual({ kind: "exit", exitCode: 124, signal: "SIGTERM" });

    await rm(rootPath, { recursive: true, force: true });
  });

  test("destroy is idempotent and does not remove the local worktree", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-local-workspace-"));
    const workspace = new LocalWorkspace({ rootPath, taskId: "task-1", dispatchId: "dispatch-1" });
    await workspace.writeFile("kept.txt", "still here");

    await workspace.destroy();
    await workspace.destroy();

    expect(await workspace.readFile("kept.txt")).toBe("still here");

    await rm(rootPath, { recursive: true, force: true });
  });
});
