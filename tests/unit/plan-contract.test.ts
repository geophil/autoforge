import { describe, expect, test } from "bun:test";
import {
  buildExecutionContract,
  buildPlanContract,
  repairPlanSubtasks
} from "../../src/orchestrator/plan-contract";
import type { PlanSubtask } from "../../src/types/core";
import { fullPlanSubtask } from "../helpers/plan-subtask";

function subtask(overrides: Partial<PlanSubtask> = {}): PlanSubtask {
  return fullPlanSubtask({
    id: "subtask-1",
    description: "Wire task status badges",
    filesInScope: ["src/web/public/dashboard.js"],
    ...overrides
  });
}

describe("plan contract validation", () => {
  test("explicit behavior is valid", () => {
    const contract = buildPlanContract([subtask()], "STANDARD");

    expect(contract.status).toBe("valid");
    expect(contract.invalidSubtasks).toEqual([]);
    expect(contract.repairs).toEqual([]);
  });

  test("missing behavior with non-empty description is repairable, not missing", () => {
    const plan = subtask({
      behavior: "Wire task status badges",
      contractProvided: {
        behavior: false,
        filesInScope: true,
        verificationCommands: true,
        testCriteria: true,
        completionEvidence: true
      }
    });
    const contract = buildExecutionContract([plan], "STANDARD");

    expect(contract.status).toBe("repaired");
    expect(contract.valid).toBe(false);
    expect(contract.invalidSubtasks).toEqual([]);
    expect(contract.repairs).toEqual([
      {
        subtaskId: "subtask-1",
        field: "behavior",
        source: "description",
        status: "available",
        value: "Wire task status badges"
      }
    ]);
  });

  test("safe alias repair marks behavior as explicitly provided by repair provenance", () => {
    const plan = subtask({
      behavior: "Wire task status badges",
      contractProvided: {
        behavior: false,
        filesInScope: true,
        verificationCommands: true,
        testCriteria: true,
        completionEvidence: true
      }
    });

    const repair = repairPlanSubtasks([plan], "STANDARD");

    expect(repair.repairs).toHaveLength(1);
    expect(repair.after.status).toBe("repaired");
    expect(repair.after.invalidSubtasks).toEqual([]);
    expect(repair.after.repairs[0]).toMatchObject({
      field: "behavior",
      source: "description",
      status: "applied"
    });
    expect(repair.repairedSubtasks[0].behavior).toBe("Wire task status badges");
    expect(repair.repairedSubtasks[0].contractProvided?.behavior).toBe(true);
    expect(repair.repairedSubtasks[0].contractRepairs).toEqual([
      { field: "behavior", source: "description" }
    ]);
  });

  test("missing verification and evidence remain invalid", () => {
    const plan = subtask({
      verificationCommands: [],
      completionEvidence: [],
      contractProvided: {
        behavior: true,
        filesInScope: true,
        verificationCommands: false,
        testCriteria: true,
        completionEvidence: false
      }
    });

    const contract = buildPlanContract([plan], "STANDARD");

    expect(contract.status).toBe("invalid");
    expect(contract.invalidSubtasks).toEqual([
      {
        id: "subtask-1",
        missing: ["verificationCommands", "completionEvidence"]
      }
    ]);
  });

  test("QMD fallback is surfaced as degraded contract evidence", () => {
    const contract = buildPlanContract([subtask()], "THOROUGH", {
      specRevision: 1,
      planRevision: 1,
      approvalMode: "manual",
      reviewedAt: "2026-05-29T00:00:00.000Z",
      qmdContext: {
        status: "fallback",
        phase: "execution_plan",
        queries: ["domain task orchestration"],
        documents: ["docs/qmd/domain-task-orchestration.md"],
        fallbackReason: "QMD query timed out after one usable document"
      }
    });

    expect(contract.status).toBe("degraded");
    expect(contract.warnings).toContainEqual({
      level: "degraded",
      code: "qmd_degraded",
      message: "QMD query timed out after one usable document"
    });
  });
});
