import { describe, expect, test } from "bun:test";
import type { PlannerSpecArtifacts } from "../../src/types/core";
import {
  buildPlannerPrompt,
  estimatePromptTokens,
  retryPromptExceedsTokenCap
} from "../../src/orchestrator/planner-prompt";

const approvedSpec: PlannerSpecArtifacts = {
  discovery: {
    intent: "Build endpoint",
    constraints: ["must be fast"],
    assumptions: ["db available"],
    decisions: [{ decision: "Use SQL", reason: "existing stack", alternativesRejected: ["NoSQL"], consequence: "simple queries" }],
    nonGoals: ["new auth system"],
    openQuestions: []
  },
  spec: {
    problem: "No endpoint exists",
    desiredBehavior: ["returns data"],
    acceptanceCriteria: ["returns 200"],
    verification: ["unit tests"],
    risks: ["slow query"]
  }
};

describe("buildPlannerPrompt", () => {
  test("keeps prompt concise and includes required phase/task/QMD constraint", () => {
    const prompt = buildPlannerPrompt({
      description: "Implement endpoint",
      tier: "STANDARD",
      phase: "spec",
      transcriptAttemptIndex: 0,
      critique: null
    });
    expect(prompt).toContain("## Phase");
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("planningContext.qmdContext");
    expect(prompt).not.toContain("Complexity signals");
  });

  test("does not duplicate approved spec reference on execution-plan retries", () => {
    const prompt = buildPlannerPrompt({
      description: "Implement endpoint",
      tier: "STANDARD",
      phase: "execution_plan",
      transcriptAttemptIndex: 2,
      priorPlan: [{
        id: "t-subtask-1",
        sequence: 1,
        behavior: "Endpoint is implemented",
        description: "Implement",
        filesInScope: ["src/x.ts"],
        dependencies: [],
        verificationCommands: ["bun test"],
        completionEvidence: ["passing test output"],
        testCriteria: ["tests pass"]
      }],
      approvedSpec,
      critique: "Please narrow to one endpoint."
    });
    expect(prompt).toContain("## Approved Spec");
    expect(prompt).toContain("## Prior plan (attempt 1)");
    expect(prompt).not.toContain("## Approved Spec (reference)");
  });

  test("compacts oversized approved spec payloads", () => {
    const giantSpec: PlannerSpecArtifacts = {
      ...approvedSpec,
      spec: {
        ...approvedSpec.spec,
        desiredBehavior: ["x".repeat(6000)]
      }
    };
    const prompt = buildPlannerPrompt({
      description: "Implement endpoint",
      tier: "STANDARD",
      phase: "execution_plan",
      transcriptAttemptIndex: 1,
      approvedSpec: giantSpec,
      priorPlan: [{
        id: "t-subtask-1",
        sequence: 1,
        behavior: "Endpoint is implemented",
        description: "Implement",
        filesInScope: ["src/x.ts"],
        dependencies: [],
        verificationCommands: ["bun test"],
        completionEvidence: ["passing test output"],
        testCriteria: ["tests pass"]
      }],
      critique: "Keep only essential behavior."
    });
    expect(prompt).toContain("... (compacted");
  });
});

describe("retryPromptExceedsTokenCap", () => {
  test("estimates tokens and flags over-budget retries", () => {
    const tiny = "abcd";
    const huge = "x".repeat(20_000);
    expect(estimatePromptTokens(tiny)).toBe(1);
    expect(retryPromptExceedsTokenCap(huge, 1000)).toBe(true);
    expect(retryPromptExceedsTokenCap(tiny, 1000)).toBe(false);
  });
});
