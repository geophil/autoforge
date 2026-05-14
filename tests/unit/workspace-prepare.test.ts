import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cp from "node:child_process";
import { prepareTaskWorkspace } from "../../src/runtime/workspace-prepare";

describe("prepareTaskWorkspace", () => {
  test("default install omits --ignore-scripts", () => {
    const prev = process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS;
    delete process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS;
    const dir = mkdtempSync(join(tmpdir(), "ws-prepare-"));
    writeFileSync(join(dir, "bun.lock"), "");
    const spy = spyOn(cp, "spawnSync").mockImplementation(() => ({ status: 0, stderr: "", stdout: "" }) as ReturnType<typeof cp.spawnSync>);
    try {
      prepareTaskWorkspace(dir);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toBe("bun");
      expect(spy.mock.calls[0][1]).toEqual(["install", "--frozen-lockfile"]);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true });
      if (prev === undefined) delete process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS;
      else process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS = prev;
    }
  });

  test("WORKSPACE_INSTALL_IGNORE_SCRIPTS=1 appends --ignore-scripts", () => {
    const prev = process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS;
    process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS = "1";
    const dir = mkdtempSync(join(tmpdir(), "ws-prepare-"));
    writeFileSync(join(dir, "package-lock.json"), "");
    const spy = spyOn(cp, "spawnSync").mockImplementation(() => ({ status: 0, stderr: "", stdout: "" }) as ReturnType<typeof cp.spawnSync>);
    try {
      prepareTaskWorkspace(dir);
      expect(spy.mock.calls[0][0]).toBe("npm");
      expect(spy.mock.calls[0][1]).toEqual(["ci", "--ignore-scripts"]);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true });
      if (prev === undefined) delete process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS;
      else process.env.WORKSPACE_INSTALL_IGNORE_SCRIPTS = prev;
    }
  });
});
