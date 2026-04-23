import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiffStats, computeIterationDiff } from "../../src/orchestrator/diff-stats";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-stats-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  execSync("git commit --allow-empty -q -m init", { cwd: dir });
  return dir;
}

describe("computeDiffStats", () => {
  test("counts added lines and added files correctly", () => {
    const dir = initRepo();
    const baseRef = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "src", "b.test.ts"), "test\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m change", { cwd: dir });

    const stats = computeDiffStats(dir, baseRef);
    expect(stats).not.toBeNull();
    expect(stats!.files_changed).toBe(2);
    expect(stats!.files_added).toBe(2);
    expect(stats!.files_modified).toBe(0);
    expect(stats!.files_deleted).toBe(0);
    expect(stats!.lines_added).toBe(4);
    expect(stats!.lines_deleted).toBe(0);
    expect(stats!.test_files_changed).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when git invocation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "diff-stats-no-git-"));
    const stats = computeDiffStats(dir, "HEAD");
    expect(stats).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("counts modifications and deletions", () => {
    const dir = initRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\n");
    writeFileSync(join(dir, "src", "to-delete.ts"), "bye\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m setup", { cwd: dir });
    const baseRef = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    writeFileSync(join(dir, "src", "a.ts"), "line1-CHANGED\nline2\nline3\n");
    execSync('git rm -q "src/to-delete.ts"', { cwd: dir });
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m modify", { cwd: dir });

    const stats = computeDiffStats(dir, baseRef);
    expect(stats).not.toBeNull();
    expect(stats!.files_changed).toBe(2);
    expect(stats!.files_added).toBe(0);
    expect(stats!.files_modified).toBe(1);
    expect(stats!.files_deleted).toBe(1);
    expect(stats!.lines_added).toBe(2);
    expect(stats!.lines_deleted).toBe(2);
    expect(stats!.test_files_changed).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("computeIterationDiff", () => {
  test("returns the per-iteration delta between two commit refs", () => {
    const dir = initRepo();
    writeFileSync(join(dir, "iter0.ts"), "a\nb\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m iter0", { cwd: dir });
    const iter0Ref = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    writeFileSync(join(dir, "iter1.ts"), "x\ny\nz\n");
    execSync("git add -A", { cwd: dir });
    execSync("git commit -q -m iter1", { cwd: dir });
    const iter1Ref = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    const delta = computeIterationDiff(dir, iter0Ref, iter1Ref);
    expect(delta).not.toBeNull();
    expect(delta!.files_changed).toBe(1);
    expect(delta!.lines_added).toBe(3);

    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when refs are invalid", () => {
    const dir = initRepo();
    const delta = computeIterationDiff(dir, "bogus1", "bogus2");
    expect(delta).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
