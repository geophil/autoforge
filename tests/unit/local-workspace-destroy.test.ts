import { describe, expect, test } from "bun:test";
import { LocalWorkspace } from "../../src/runtime/local-workspace";

describe("LocalWorkspace.destroy", () => {
  test("invokes onDestroy callback exactly once", async () => {
    let calls = 0;
    const ws = new LocalWorkspace({
      rootPath: process.cwd(),
      taskId: "task-1",
      dispatchId: "task",
      onDestroy: () => {
        calls += 1;
      }
    });

    await ws.destroy();
    await ws.destroy();

    expect(calls).toBe(1);
  });

  test("waits for an async onDestroy to finish before resolving", async () => {
    const events: string[] = [];
    const ws = new LocalWorkspace({
      rootPath: process.cwd(),
      taskId: "task-2",
      dispatchId: "task",
      onDestroy: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("teardown-finished");
      }
    });

    await ws.destroy();
    events.push("destroy-returned");

    expect(events).toEqual(["teardown-finished", "destroy-returned"]);
  });

  test("destroy is a no-op when no onDestroy is wired (legacy behavior)", async () => {
    const ws = new LocalWorkspace({
      rootPath: process.cwd(),
      taskId: "task-3",
      dispatchId: "task"
    });
    await ws.destroy();
    await ws.destroy();
  });
});
