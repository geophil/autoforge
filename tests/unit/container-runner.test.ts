import { describe, expect, test } from "bun:test";
import {
  buildDockerCreateArgs,
  dockerContainerName,
  DockerCliContainerRunner,
  reapOrphanWorkspaceContainers
} from "../../src/runtime/container-runner";
import type { ExecEvent } from "../../src/runtime/workspace";

describe("container runner", () => {
  test("builds a stable docker container name", () => {
    expect(dockerContainerName("task/one", "coder:1")).toBe("autoforge-task-one-coder-1");
  });

  test("builds hardened docker create args", () => {
    const args = buildDockerCreateArgs({
      name: "autoforge-task-coder",
      image: "autoforge-agent:local",
      rootPath: "/tmp/worktree",
      network: "none",
      cpus: "2",
      memory: "2g",
      uid: 501,
      gid: 20
    });

    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--cpus");
    expect(args).toContain("2");
    expect(args).toContain("--memory");
    expect(args).toContain("2g");
    expect(args).toContain("-u");
    expect(args).toContain("501:20");
    expect(args).toContain("-v");
    expect(args).toContain("/tmp/worktree:/workspace");
    expect(args.slice(-3)).toEqual(["autoforge-agent:local", "sleep", "infinity"]);
  });

  test("destroy emits no error when docker rm reports missing container", async () => {
    const runner = new DockerCliContainerRunner({
      runDocker: async function* (_args: string[]): AsyncIterable<ExecEvent> {
        yield { kind: "stderr", chunk: "No such container" };
        yield { kind: "exit", exitCode: 1 };
      }
    });

    await expect(runner.destroy("missing-container")).resolves.toBeUndefined();
  });

  test("reapOrphanWorkspaceContainers removes every labeled container and counts successes", async () => {
    const calls: string[][] = [];
    const runDocker = async function* (args: string[]): AsyncIterable<ExecEvent> {
      calls.push(args);
      if (args[0] === "ps") {
        yield { kind: "stdout", chunk: "abc123\ndef456\nghi789\n" };
        yield { kind: "exit", exitCode: 0 };
        return;
      }
      // docker rm -f <id>
      yield { kind: "exit", exitCode: 0 };
    };

    const reaped = await reapOrphanWorkspaceContainers({ runDocker });

    expect(reaped).toBe(3);
    expect(calls[0]).toEqual(["ps", "-a", "--filter", "label=autoforge.workspace=true", "-q"]);
    expect(calls.slice(1)).toEqual([
      ["rm", "-f", "abc123"],
      ["rm", "-f", "def456"],
      ["rm", "-f", "ghi789"]
    ]);
  });

  test("reapOrphanWorkspaceContainers returns 0 when docker is unavailable", async () => {
    const runDocker = async function* (_args: string[]): AsyncIterable<ExecEvent> {
      yield { kind: "stderr", chunk: "Cannot connect to the Docker daemon" };
      yield { kind: "exit", exitCode: 1 };
    };

    expect(await reapOrphanWorkspaceContainers({ runDocker })).toBe(0);
  });

  test("reapOrphanWorkspaceContainers returns 0 cleanly when nothing matches the label", async () => {
    const runDocker = async function* (_args: string[]): AsyncIterable<ExecEvent> {
      yield { kind: "exit", exitCode: 0 };
    };

    expect(await reapOrphanWorkspaceContainers({ runDocker })).toBe(0);
  });
});
