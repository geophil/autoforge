import { describe, expect, test } from "bun:test";
import {
  artifactWithinScope,
  normalizeArtifactPath,
  runCheapPreReviewChecks,
  shouldSkipDebugScanPath
} from "../../src/orchestrator/pre-review-checks";
import type { PlanSubtask } from "../../src/types/core";

function subtask(filesInScope: string[]): PlanSubtask {
  return {
    id: "s1",
    sequence: 1,
    behavior: "Behavior",
    description: "Do work",
    filesInScope,
    dependencies: [],
    verificationCommands: ["bun test"],
    testCriteria: ["pass"],
    completionEvidence: ["output"],
    contractProvided: {
      behavior: true,
      filesInScope: true,
      verificationCommands: true,
      testCriteria: true,
      completionEvidence: true
    }
  };
}

describe("pre-review checks", () => {
  test("artifactWithinScope matches files and directories", () => {
    expect(artifactWithinScope("src/foo.ts", "src/foo.ts")).toBe(true);
    expect(artifactWithinScope("src/foo.ts", "src/")).toBe(true);
    expect(artifactWithinScope("src/foo.ts", "src")).toBe(true);
    expect(artifactWithinScope("lib/foo.ts", "src/")).toBe(false);
  });

  test("normalizeArtifactPath strips leading ./ segments", () => {
    expect(normalizeArtifactPath("./src/a.ts")).toBe("src/a.ts");
  });

  test("shouldSkipDebugScanPath ignores test and fixture paths", () => {
    expect(shouldSkipDebugScanPath("tests/unit/foo.test.ts")).toBe(true);
    expect(shouldSkipDebugScanPath("src/foo.ts")).toBe(false);
  });

  test("passes when scope and debug checks are unavailable", () => {
    const result = runCheapPreReviewChecks({
      worktreePath: "/tmp/worktree",
      planSubtasks: [subtask(["src/"])],
      reportedArtifacts: []
    });
    expect(result.passed).toBe(true);
    expect(result.scope_check.status).toBe("unavailable");
    expect(result.debug_code_scan.status).toBe("unavailable");
  });

  test("fails when reported artifact is outside declared scope", () => {
    const result = runCheapPreReviewChecks({
      worktreePath: "/tmp/worktree",
      planSubtasks: [subtask(["src/allowed.ts"])],
      reportedArtifacts: ["lib/outside.ts"]
    });
    expect(result.passed).toBe(false);
    expect(result.scope_check.status).toBe("failed");
    expect(result.scope_check.unexpected_artifacts).toEqual(["lib/outside.ts"]);
  });

  test("fails on debugger statements in production artifacts", () => {
    const result = runCheapPreReviewChecks({
      worktreePath: "/tmp/worktree",
      planSubtasks: [subtask(["src/"])],
      reportedArtifacts: ["src/bad.ts"],
      readFile: () => "export function x() { debugger; }",
      exists: () => true
    });
    expect(result.passed).toBe(false);
    expect(result.debug_code_scan.status).toBe("failed");
    expect(result.debug_code_scan.matches).toEqual([
      { path: "src/bad.ts", pattern: "debugger statement" }
    ]);
  });

  test("treats console.log as advisory without failing the check", () => {
    const result = runCheapPreReviewChecks({
      worktreePath: "/tmp/worktree",
      planSubtasks: [subtask(["src/"])],
      reportedArtifacts: ["src/log.ts"],
      readFile: () => "console.log('debug');",
      exists: () => true
    });
    expect(result.passed).toBe(true);
    expect(result.debug_code_scan.status).toBe("passed");
    expect(result.debug_code_scan.advisory_matches).toEqual([
      { path: "src/log.ts", pattern: "console.log" }
    ]);
  });

  test("skips debug scan for test files even when console.log is present", () => {
    const result = runCheapPreReviewChecks({
      worktreePath: "/tmp/worktree",
      planSubtasks: [subtask(["tests/"])],
      reportedArtifacts: ["tests/unit/example.test.ts"],
      readFile: () => "console.log('fixture'); debugger;",
      exists: () => true
    });
    expect(result.passed).toBe(true);
    expect(result.debug_code_scan.matches).toEqual([]);
    expect(result.debug_code_scan.advisory_matches).toEqual([]);
  });
});
