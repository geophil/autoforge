import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  discoverLifecycleHookScripts,
  runLifecycleHooks,
  type LifecycleHookPhase
} from "../../src/orchestrator/lifecycle-hooks";
import { LocalWorkspace } from "../../src/runtime/local-workspace";

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function createRepoWithScripts(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-hooks-test-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "lifecycle-hooks-test",
      private: true,
      scripts
    }, null, 2)
  );
  writeFileSync(join(dir, "README.md"), "seed\n");
  runCommand("git", ["init"], dir);
  runCommand("git", ["add", "-A"], dir);
  runCommand("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "seed"], dir);
  return dir;
}

async function runPhase(phase: LifecycleHookPhase, dir: string) {
  // Use a LocalWorkspace pointing at the test worktree — same shape as the
  // per-task workspace the orchestrator passes in production.
  const workspace = new LocalWorkspace({ rootPath: dir, taskId: "lifecycle-hook-test", dispatchId: "task" });
  return runLifecycleHooks({
    phase,
    workingDirectory: dir,
    workspace,
    timeoutSeconds: 30
  });
}

describe("lifecycle hooks", () => {
  test("discovers all allowlisted scripts for each phase in allowlist order", () => {
    const dir = createRepoWithScripts({
      format: "echo format",
      "lint:fix": "echo lint-fix",
      lint: "echo lint",
      test: "echo test",
      build: "echo build"
    });
    try {
      const post = discoverLifecycleHookScripts("post_coder_pre_review", dir);
      const pre = discoverLifecycleHookScripts("pre_pr_gate", dir);
      expect(post.skipReason).toBeNull();
      expect(post.scripts).toEqual(["format", "lint:fix", "lint", "test"]);
      expect(pre.skipReason).toBeNull();
      expect(pre.scripts).toEqual(["lint", "test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovery skips entries not present in package.json", () => {
    const dir = createRepoWithScripts({ lint: "echo lint" });
    try {
      const pre = discoverLifecycleHookScripts("pre_pr_gate", dir);
      expect(pre.skipReason).toBeNull();
      expect(pre.scripts).toEqual(["lint"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs every discovered script in allowlist order until one fails", async () => {
    const dir = createRepoWithScripts({
      lint: "echo lint-ok",
      test: "node -e \"process.exit(2)\""
    });
    try {
      const result = await runPhase("pre_pr_gate", dir);
      expect(result.runs).toHaveLength(2);
      expect(result.runs[0].script).toBe("lint");
      expect(result.runs[0].result).toBe("completed");
      expect(result.runs[1].script).toBe("test");
      expect(result.runs[1].result).toBe("failed");
      expect(result.failedRun?.script).toBe("test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("post_coder_pre_review commits hook mutations with hook identity", async () => {
    const dir = createRepoWithScripts({
      format: "node -e \"require('node:fs').appendFileSync('README.md', '\\nformatted')\""
    });
    try {
      const result = await runPhase("post_coder_pre_review", dir);
      expect(result.failedRun).toBeNull();
      expect(result.runs).toHaveLength(1);
      const run = result.runs[0];
      expect(run.result).toBe("completed");
      expect(run.committed).toBe(true);
      expect(run.changedFileCount).toBeGreaterThan(0);
      expect(run.commitSha).not.toBeNull();

      const commitSubject = runCommand("git", ["show", "-s", "--format=%s", "HEAD"], dir);
      expect(commitSubject).toBe("autoforge: lifecycle hook post_coder_pre_review (format)");
      const commitAuthor = runCommand("git", ["show", "-s", "--format=%an <%ae>", "HEAD"], dir);
      expect(commitAuthor).toBe("Autoforge Hook <hooks@autoforge.local>");
      const porcelain = runCommand("git", ["status", "--porcelain"], dir);
      expect(porcelain).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pre_pr_gate fails when allowlisted script mutates files", async () => {
    const dir = createRepoWithScripts({
      lint: "node -e \"require('node:fs').appendFileSync('README.md', '\\nmutated')\""
    });
    try {
      const result = await runPhase("pre_pr_gate", dir);
      expect(result.failedRun).not.toBeNull();
      const failed = result.failedRun!;
      expect(failed.result).toBe("failed");
      expect(failed.failureReason).toBe("mutated_files_in_readonly_phase");
      expect(failed.committed).toBe(false);
      expect(failed.changedFileCount).toBeGreaterThan(0);

      const commitSubject = runCommand("git", ["show", "-s", "--format=%s", "HEAD"], dir);
      expect(commitSubject).toBe("seed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records skipped completion when package.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-hooks-skip-"));
    try {
      const result = await runPhase("post_coder_pre_review", dir);
      expect(result.failedRun).toBeNull();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].skipped).toBe(true);
      expect(result.runs[0].skipReason).toBe("package_json_missing_or_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
