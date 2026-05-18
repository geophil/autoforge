import { describe, expect, test } from "bun:test";
import {
  extractBlockingQuestion,
  isPlannerFallbackOutput,
  parsePlannerStructuredOutput
} from "../../src/orchestrator/planner-output";
import type { PlannerSpecArtifacts } from "../../src/types/core";

const validSpec: PlannerSpecArtifacts = {
  discovery: {
    intent: "Provide widget totals",
    constraints: [],
    assumptions: [],
    decisions: [],
    nonGoals: [],
    openQuestions: ["What retention?"]
  },
  spec: {
    problem: "No view of totals",
    desiredBehavior: ["Returns totals"],
    acceptanceCriteria: ["p95 <100ms"],
    verification: ["Load test"],
    risks: []
  }
};

const validSubtask = {
  id: "t1-subtask-1",
  sequence: 1,
  description: "Wire endpoint",
  filesInScope: ["src/api/totals.ts"],
  dependencies: [],
  testCriteria: ["Endpoint returns 200"]
};

describe("parsePlannerStructuredOutput — phase classification", () => {
  test("spec-only output (discovery + spec present, no subtasks) classified as 'spec'", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      { discovery: validSpec.discovery, spec: validSpec.spec, blockingQuestion: null },
      "spec"
    );
    expect(parsed.phase).toBe("spec");
    if (parsed.phase === "spec") {
      expect(parsed.specArtifacts.spec.problem).toBe("No view of totals");
      expect(parsed.planSubtasks).toEqual([]);
      expect(parsed.blockingQuestion).toBeNull();
    }
  });

  test("spec-only with blockingQuestion preserves the question", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      {
        discovery: validSpec.discovery,
        spec: validSpec.spec,
        blockingQuestion: "Which datastore?"
      },
      "spec"
    );
    expect(parsed.phase).toBe("spec");
    if (parsed.phase === "spec") {
      expect(parsed.blockingQuestion).toBe("Which datastore?");
    }
  });

  test("subtasks-only output with requestedPhase classified as 'execution_plan'", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      { subtasks: [validSubtask] },
      "execution_plan"
    );
    expect(parsed.phase).toBe("execution_plan");
    expect(parsed.planSubtasks).toHaveLength(1);
    expect(parsed.planSubtasks[0].description).toBe("Wire endpoint");
    expect(parsed.planSubtasks[0].contractProvided).toEqual({
      behavior: false,
      filesInScope: true,
      verificationCommands: false,
      testCriteria: true,
      completionEvidence: false
    });
    expect(parsed.planningContext.specRevision).toBe(0);
    expect(parsed.planningContext.planRevision).toBe(0);
    expect(parsed.planningContext.qmdContext).toBeNull();
  });

  test("subtasks-only output with no requestedPhase falls into 'legacy_subtasks' bucket", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      { subtasks: [validSubtask] },
      undefined
    );
    expect(parsed.phase).toBe("legacy_subtasks");
    expect(parsed.planSubtasks).toHaveLength(1);
  });

  test("combined output (spec + subtasks both present) classified as 'combined'", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      { ...validSpec, subtasks: [validSubtask] },
      "combined"
    );
    expect(parsed.phase).toBe("combined");
    if (parsed.phase === "combined") {
      expect(parsed.specArtifacts.spec.problem).toBe("No view of totals");
      expect(parsed.planSubtasks).toHaveLength(1);
    }
  });

  test("empty/missing output emits legacy fallback subtask (the last-resort case)", () => {
    const parsed = parsePlannerStructuredOutput("task-x", {}, "execution_plan");
    expect(parsed.phase).toBe("legacy_subtasks");
    expect(parsed.planSubtasks).toHaveLength(1);
    expect(isPlannerFallbackOutput(parsed.planSubtasks)).toBe(true);
  });

  test("plan §Task 1 anti-regression: a valid spec artifact MUST NOT fall back to a synthetic subtask", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      { discovery: validSpec.discovery, spec: validSpec.spec },
      "spec"
    );
    expect(parsed.phase).toBe("spec");
    expect(parsed.planSubtasks).toEqual([]);
    expect(isPlannerFallbackOutput(parsed.planSubtasks)).toBe(false);
  });

  test("spec body must be non-empty (intent or problem) — otherwise classified as legacy subtasks fallback", () => {
    // Empty discovery + spec — no intent, no problem. Should NOT be classified as spec.
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      {
        discovery: {
          intent: "",
          constraints: [],
          assumptions: [],
          decisions: [],
          nonGoals: [],
          openQuestions: []
        },
        spec: {
          problem: "",
          desiredBehavior: [],
          acceptanceCriteria: [],
          verification: [],
          risks: []
        }
      },
      "spec"
    );
    expect(parsed.phase).toBe("legacy_subtasks");
    expect(isPlannerFallbackOutput(parsed.planSubtasks)).toBe(true);
  });

  test("planningContext is parsed when present and defaults to zeros otherwise", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      {
        discovery: validSpec.discovery,
        spec: validSpec.spec,
        planningContext: {
          specRevision: 2,
          planRevision: 1,
          approvalMode: "manual",
          reviewedAt: "2026-05-11T10:00:00Z",
          qmdContext: {
            status: "used",
            phase: "spec",
            queries: ["architecture overview"],
            documents: ["docs/qmd/architecture-overview.md"],
            fallbackReason: null
          }
        }
      },
      "spec"
    );
    if (parsed.phase === "spec") {
      expect(parsed.planningContext.specRevision).toBe(2);
      expect(parsed.planningContext.approvalMode).toBe("manual");
      expect(parsed.planningContext.reviewedAt).toBe("2026-05-11T10:00:00Z");
      expect(parsed.planningContext.qmdContext).toEqual({
        status: "used",
        phase: "spec",
        queries: ["architecture overview"],
        documents: ["docs/qmd/architecture-overview.md"],
        fallbackReason: null
      });
    }

    const parsedNoCtx = parsePlannerStructuredOutput(
      "task-x",
      { discovery: validSpec.discovery, spec: validSpec.spec },
      "spec"
    );
    if (parsedNoCtx.phase === "spec") {
      expect(parsedNoCtx.planningContext.specRevision).toBe(0);
      expect(parsedNoCtx.planningContext.approvalMode).toBeNull();
      expect(parsedNoCtx.planningContext.qmdContext).toBeNull();
    }
  });

  test("planningContext.qmdContext is sanitized for malformed values", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      {
        discovery: validSpec.discovery,
        spec: validSpec.spec,
        planningContext: {
          qmdContext: {
            status: "invalid",
            phase: "execution_plan",
            queries: ["good", 42, null],
            documents: "not-an-array",
            fallbackReason: 100
          }
        }
      },
      "spec"
    );
    if (parsed.phase !== "spec") throw new Error("expected spec phase");
    expect(parsed.planningContext.qmdContext).toEqual({
      status: "fallback",
      phase: "execution_plan",
      queries: ["good"],
      documents: [],
      fallbackReason: null
    });
  });

  test("malformed string-array fields default to []; invalid decisions get scrubbed to defaults", () => {
    const parsed = parsePlannerStructuredOutput(
      "task-x",
      {
        discovery: {
          intent: "Yes",
          constraints: "not-an-array",
          decisions: [
            { decision: 42, reason: null, alternativesRejected: "x", consequence: undefined }
          ],
          openQuestions: [123, "real question", null]
        },
        spec: {
          problem: "Yes",
          desiredBehavior: ["valid", 99]
        }
      },
      "spec"
    );
    if (parsed.phase !== "spec") throw new Error("expected spec phase");
    expect(parsed.specArtifacts.discovery.constraints).toEqual([]);
    expect(parsed.specArtifacts.discovery.decisions).toEqual([
      { decision: "", reason: "", alternativesRejected: [], consequence: "" }
    ]);
    expect(parsed.specArtifacts.discovery.openQuestions).toEqual(["real question"]);
    expect(parsed.specArtifacts.spec.desiredBehavior).toEqual(["valid"]);
  });
});

describe("extractBlockingQuestion", () => {
  test("returns trimmed string for non-empty blockingQuestion", () => {
    expect(extractBlockingQuestion({ blockingQuestion: "  Do we need ETags?  " })).toBe(
      "Do we need ETags?"
    );
  });

  test("returns null for missing/empty/non-string values", () => {
    expect(extractBlockingQuestion({})).toBeNull();
    expect(extractBlockingQuestion({ blockingQuestion: "" })).toBeNull();
    expect(extractBlockingQuestion({ blockingQuestion: "   " })).toBeNull();
    expect(extractBlockingQuestion({ blockingQuestion: 42 })).toBeNull();
    expect(extractBlockingQuestion(null)).toBeNull();
  });
});

describe("isPlannerFallbackOutput", () => {
  test("detects the canonical fallback subtask", () => {
    expect(
      isPlannerFallbackOutput([
        {
          id: "x",
          sequence: 1,
          behavior: "Requested behavior is implemented and verified.",
          description: "Implement requested behavior with tests-first workflow.",
          filesInScope: [],
          dependencies: [],
          verificationCommands: [],
          completionEvidence: [],
          testCriteria: []
        }
      ])
    ).toBe(true);
  });

  test("does not flag non-fallback subtasks", () => {
    expect(
      isPlannerFallbackOutput([
        {
          id: "x",
          sequence: 1,
          behavior: "Wire endpoint",
          description: "Wire the endpoint",
          filesInScope: [],
          dependencies: [],
          verificationCommands: [],
          completionEvidence: [],
          testCriteria: []
        }
      ])
    ).toBe(false);
  });

  test("multiple subtasks are never the fallback shape", () => {
    expect(
      isPlannerFallbackOutput([
        {
          id: "a",
          sequence: 1,
          behavior: "Requested behavior is implemented and verified.",
          description: "Implement requested behavior with tests-first workflow.",
          filesInScope: [],
          dependencies: [],
          verificationCommands: [],
          completionEvidence: [],
          testCriteria: []
        },
        {
          id: "b",
          sequence: 2,
          behavior: "Requested behavior is implemented and verified.",
          description: "Implement requested behavior with tests-first workflow.",
          filesInScope: [],
          dependencies: [],
          verificationCommands: [],
          completionEvidence: [],
          testCriteria: []
        }
      ])
    ).toBe(false);
  });
});
