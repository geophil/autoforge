import { describe, expect, test } from "bun:test";
import {
  buildDockerCreateArgs,
  dockerContainerName,
  DockerCliContainerRunner
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
});
