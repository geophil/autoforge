import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace } from "../../src/runtime/container-workspace";
import type { ExecEvent } from "../../src/runtime/workspace";

const dockerEnabled = process.env.AUTOFORGE_DOCKER_TESTS === "1";
const dockerImage = process.env.WORKSPACE_DOCKER_IMAGE ?? "autoforge-agent:local";

async function collect(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const collected: ExecEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe.skipIf(!dockerEnabled)("ContainerWorkspace Docker integration", () => {
  test("exec runs inside the mounted worktree and destroy removes the container", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "autoforge-container-docker-"));
    await writeFile(join(rootPath, "marker.txt"), "hello from host");

    const workspace = await ContainerWorkspace.create({
      rootPath,
      taskId: `docker-test-${Date.now()}`,
      dispatchId: "coder",
      image: dockerImage,
      network: "none",
      cpus: "1",
      memory: "512m"
    });

    try {
      const events = await collect(workspace.exec("sh", ["-c", "pwd; cat marker.txt; echo changed > out.txt"]));
      expect(events.some((event) => event.kind === "stdout" && event.chunk.includes("/workspace"))).toBe(true);
      expect(events.some((event) => event.kind === "stdout" && event.chunk.includes("hello from host"))).toBe(true);
      expect(events.at(-1)).toEqual({ kind: "exit", exitCode: 0 });
      expect(await readFile(join(rootPath, "out.txt"), "utf8")).toBe("changed\n");
    } finally {
      await workspace.destroy();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
