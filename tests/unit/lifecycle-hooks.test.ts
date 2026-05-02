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

function runPhase(phase: LifecycleHookPhase, dir: string) {
  return runLifecycleHooks({
    phase,
    workingDirectory: dir,
    timeoutSeconds: 30
  });
}

describe("lifecycle hooks", () => {
  test("discovers only allowlisted scripts for each phase", () => {
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
      expect(post.scripts).toEqual(["format"]);
      expect(pre.skipReason).toBeNull();
      expect(pre.scripts).toEqual(["lint"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("post_coder_pre_review commits hook mutations with hook identity", () => {
    const dir = createRepoWithScripts({
      format: "node -e \"require('node:fs').appendFileSync('README.md', '\\nformatted')\""
    });
    try {
      const result = runPhase("post_coder_pre_review", dir);
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

  test("pre_pr_gate fails when allowlisted script mutates files", () => {
    const dir = createRepoWithScripts({
      lint: "node -e \"require('node:fs').appendFileSync('README.md', '\\nmutated')\""
    });
    try {
      const result = runPhase("pre_pr_gate", dir);
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

  test("records skipped completion when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-hooks-skip-"));
    try {
      const result = runPhase("post_coder_pre_review", dir);
      expect(result.failedRun).toBeNull();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].skipped).toBe(true);
      expect(result.runs[0].skipReason).toBe("package_json_missing_or_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
