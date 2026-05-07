import { describe, expect, test } from "bun:test";
import { MockWorkspace } from "../../src/runtime/mock-workspace";
import type { ExecEvent } from "../../src/runtime/workspace";

async function collectExec(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const collected: ExecEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("MockWorkspace", () => {
  test("stores files in memory using workspace-relative paths", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });

    await workspace.writeFile("src/example.ts", "export const value = 1;");

    expect(await workspace.readFile("src/example.ts")).toBe("export const value = 1;");
  });

  test("rejects reads after destroy", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1", files: { "a.txt": "a" } });

    await workspace.destroy();

    await expect(workspace.readFile("a.txt")).rejects.toThrow("destroyed");
  });

  test("exec returns configured events and appends a successful exit when missing", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-1",
      commands: [
        {
          cmd: "bun",
          args: ["test"],
          events: [{ kind: "stdout", chunk: "ok" }]
        }
      ]
    });

    const events = await collectExec(workspace.exec("bun", ["test"]));

    expect(events).toEqual([
      { kind: "stdout", chunk: "ok" },
      { kind: "exit", exitCode: 0 }
    ]);
  });

  test("exec reports a failure for unconfigured commands", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });

    const events = await collectExec(workspace.exec("missing", []));

    expect(events).toEqual([
      { kind: "stderr", chunk: "No mock command configured for: missing" },
      { kind: "exit", exitCode: 127 }
    ]);
  });
});
