import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { StageFailedError } from "../../src/orchestrator/service";

describe("awaiting_intervention: planner failures surface with forensics", () => {
  test("planner FAILED pauses task in awaiting_intervention instead of silently falling back", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "synthetic model rejection (404)",
        metrics: {
          elapsedSeconds: 0.3,
          tokenInput: 0,
          tokenOutput: 0,
          toolStats: { readCount: 8, writeCount: 1, bashCount: 0, searchCount: 5, iterations: 11 }
        }
      })
    });

    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");

    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis");
    expect(failure).toBeDefined();
    expect(failure!.payload.failure_category).toBe("planner_failed");
    expect(failure!.payload.failure_reason).toBe("synthetic model rejection (404)");
    expect(failure!.payload.awaiting_intervention).toBe(true);
    expect(failure!.payload.stage_failed).toBe("planning");
    expect(failure!.payload.agent).toBe("planner");
    expect(failure!.payload.executor_used).toBeDefined();
    expect(failure!.payload.persona_version_id).toBeDefined();
    expect(failure!.payload.skill_version_ids).toBeDefined();
    expect(failure!.payload.planner_fallback).toBe(false);
    expect(failure!.payload.iteration).toBe(0);
    expect("tool_stats" in failure!.payload).toBe(true);
    expect(failure!.payload.tool_stats).toEqual({
      read_count: 8,
      write_count: 1,
      bash_count: 0,
      search_count: 5,
      iterations: 11
    });
    expect(failure!.payload.transcript_id).toBeDefined();
  });

  test("planner TIMEOUT is categorized as planner_timeout", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "TIMEOUT",
        artifacts: [],
        metrics: { elapsedSeconds: 180, tokenInput: 0, tokenOutput: 0 }
      })
    });

    const task = await service.submitTask("autoforge", "Add STANDARD feature");
    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis");
    expect(failure!.payload.failure_category).toBe("planner_timeout");
  });

  test("generic fallback subtask is NOT used when planner fails (no silent fallback)", async () => {
    const { service } = createTestService({
      planner: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "bad model alias",
        metrics: { elapsedSeconds: 0.1 }
      })
    });

    const task = await service.submitTask("autoforge", "Build a STANDARD feature");
    // The pre-change behavior synthesized a "Implement requested behavior with
    // tests-first workflow." fallback subtask. That must no longer happen.
    expect(task.planSubtasks).toEqual([]);
  });
});

describe("awaiting_intervention: coder failures surface with forensics", () => {
  test("coder TIMEOUT pauses task in awaiting_intervention with tool stats + elapsed", async () => {
    const { service, db } = createTestService({
      coder: async () => ({
        status: "TIMEOUT",
        artifacts: [],
        metrics: {
          elapsedSeconds: 720,
          tokenInput: 100000,
          tokenOutput: 2000,
          toolStats: { readCount: 12, writeCount: 0, bashCount: 1, searchCount: 3, iterations: 20 }
        }
      })
    });

    const task = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS" });

    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis" && e.payload.stage_failed === "executing");
    expect(failure).toBeDefined();
    expect(failure!.payload.failure_category).toBe("executor_timeout");
    expect(failure!.payload.awaiting_intervention).toBe(true);
    expect(failure!.payload.tool_stats).toEqual({
      read_count: 12,
      write_count: 0,
      bash_count: 1,
      search_count: 3,
      iterations: 20
    });
    expect(failure!.payload.elapsed_seconds).toBe(720);
    expect(failure!.payload.budget_seconds).toBeDefined();
  });

  test("coder FAILED (non-timeout) also pauses and is categorized coder_failed", async () => {
    const { service, db } = createTestService({
      coder: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "claude exited with code 1: Invalid MCP configuration",
        metrics: { elapsedSeconds: 0.15 }
      })
    });

    const task = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis" && e.payload.stage_failed === "executing");
    expect(failure!.payload.failure_category).toBe("coder_failed");
    expect(failure!.payload.failure_reason).toContain("Invalid MCP configuration");
  });
});

describe("awaiting_intervention: reviewer failures surface with forensics", () => {
  test("reviewer TIMEOUT pauses task in awaiting_intervention with provenance and snake_case tool stats", async () => {
    const { service, db, cleanup } = createTestService({
      reviewer: async () => ({
        status: "TIMEOUT",
        artifacts: [],
        metrics: {
          elapsedSeconds: 180,
          tokenInput: 1500,
          tokenOutput: 40,
          toolStats: {
            readCount: 7,
            writeCount: 0,
            bashCount: 1,
            searchCount: 2,
            iterations: 4
          }
        }
      })
    });

    try {
      const task = await service.submitTask("autoforge", "STANDARD reviewer timeout task", { reviewPlan: false });
      expect(task.state).toBe("awaiting_intervention");

      const events = db.listEvents(task.id);
      const failure = events.find((e) => e.type === "failure_analysis" && e.payload.stage_failed === "reviewing");
      expect(failure).toBeDefined();
      expect(failure!.payload.failure_category).toBe("executor_timeout");
      expect(failure!.payload.executor_used).toBeDefined();
      expect(failure!.payload.persona_version_id).toBeDefined();
      expect(failure!.payload.skill_version_ids).toBeDefined();
      expect(failure!.payload.planner_fallback).toBe(false);
      expect(failure!.payload.iteration).toBe(0);
      expect(failure!.payload.tool_stats).toEqual({
        read_count: 7,
        write_count: 0,
        bash_count: 1,
        search_count: 2,
        iterations: 4
      });
    } finally {
      cleanup();
    }
  });

  test("reviewer FAILED pauses task in awaiting_intervention and is categorized reviewer_failed", async () => {
    const { service, db, cleanup } = createTestService({
      reviewer: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "review toolchain crashed",
        metrics: { elapsedSeconds: 0.4 }
      })
    });

    try {
      const task = await service.submitTask("autoforge", "STANDARD reviewer failed task", { reviewPlan: false });
      expect(task.state).toBe("awaiting_intervention");

      const events = db.listEvents(task.id);
      const failure = events.find((e) => e.type === "failure_analysis" && e.payload.stage_failed === "reviewing");
      expect(failure).toBeDefined();
      expect(failure!.payload.failure_category).toBe("reviewer_failed");
      expect(failure!.payload.failure_reason).toContain("review toolchain crashed");
    } finally {
      cleanup();
    }
  });

  test("rework_limit includes reviewer provenance and snake_case tool stats", async () => {
    let reviewerCalls = 0;
    const { service, db, cleanup } = createTestService({
      reviewer: async () => {
        reviewerCalls += 1;
        return {
          status: "DONE_WITH_CONCERNS",
          artifacts: [],
          output: {
            findings: [
              {
                id: `finding-${reviewerCalls}`,
                severity: "MAJOR",
                category: "correctness",
                description: "Needs another rework pass.",
                resolved: false
              }
            ]
          },
          metrics: {
            elapsedSeconds: 0.25,
            toolStats: {
              readCount: 9,
              writeCount: 0,
              bashCount: 2,
              searchCount: 4,
              iterations: 6
            }
          }
        };
      }
    });

    try {
      const task = await service.submitTask("autoforge", "STANDARD reviewer rework limit task", { reviewPlan: false });
      expect(task.state).toBe("awaiting_intervention");

      const events = db.listEvents(task.id);
      const failure = events.find((e) => e.type === "failure_analysis" && e.payload.failure_category === "rework_limit");
      expect(failure).toBeDefined();
      expect(failure!.payload.stage_failed).toBe("reviewing");
      expect(failure!.payload.executor_used).toBeDefined();
      expect(failure!.payload.persona_version_id).toBeDefined();
      expect(failure!.payload.skill_version_ids).toBeDefined();
      expect(failure!.payload.tool_stats).toEqual({
        read_count: 9,
        write_count: 0,
        bash_count: 2,
        search_count: 4,
        iterations: 6
      });
    } finally {
      cleanup();
    }
  });
});

describe("retryFromIntervention", () => {
  test("retry from planning re-runs the planner (fresh attempt #0)", async () => {
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async () => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return {
            status: "FAILED",
            artifacts: [],
            blockReason: "first call fails",
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        return {
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [{
              id: "sub-1", sequence: 1, description: "Do the thing",
              filesInScope: ["src/foo.ts"], dependencies: [], testCriteria: ["tests pass"]
            }]
          },
          metrics: { elapsedSeconds: 0.2, tokenInput: 100, tokenOutput: 50 }
        };
      }
    });

    const paused = await service.submitTask("autoforge", "Build a STANDARD feature");
    expect(paused.state).toBe("awaiting_intervention");

    const retried = await service.retryFromIntervention(paused.id, { fromStage: "planning" });

    // Second planner succeeded — STANDARD tier pauses at plan approval.
    expect(retried.state).toBe("awaiting_plan_approval");
    expect(retried.planSubtasks).toHaveLength(1);
    expect(retried.planSubtasks[0].description).toBe("Do the thing");
    expect(plannerCalls).toBe(2);

    const events = db.listEvents(paused.id);
    expect(events.some((e) => e.type === "retry_requested")).toBe(true);
  });

  test("retry from executing re-runs coder with existing plan", async () => {
    let coderCalls = 0;
    const { service } = createTestService({
      coder: async () => {
        coderCalls += 1;
        if (coderCalls === 1) {
          return {
            status: "TIMEOUT",
            artifacts: [],
            metrics: { elapsedSeconds: 300 }
          };
        }
        return {
          status: "DONE",
          artifacts: ["src/foo.ts"],
          metrics: { elapsedSeconds: 5 }
        };
      }
    });

    const paused = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS" });
    expect(paused.state).toBe("awaiting_intervention");

    const retried = await service.retryFromIntervention(paused.id, { fromStage: "executing" });
    // EXPRESS tier skips reviewer, so a successful coder retry runs through
    // to awaiting_approval.
    expect(retried.state).toBe("awaiting_approval");
    expect(coderCalls).toBe(2);
  });

  test("retry from planning that fails again pauses correctly (state-machine valid)", async () => {
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async () => {
        plannerCalls += 1;
        return {
          status: "FAILED",
          artifacts: [],
          blockReason: `planner failure #${plannerCalls}`,
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    });

    const first = await service.submitTask("autoforge", "Build a STANDARD feature");
    expect(first.state).toBe("awaiting_intervention");

    const second = await service.retryFromIntervention(first.id, { fromStage: "planning" });
    expect(second.state).toBe("awaiting_intervention");
    expect(plannerCalls).toBe(2);

    const events = db.listEvents(first.id);
    const failures = events.filter((e) => e.type === "failure_analysis");
    expect(failures).toHaveLength(2);
    expect(failures[1].payload.failure_reason).toBe("planner failure #2");
  });

  test("retry on a non-paused task throws", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "tiny", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");
    await expect(service.retryFromIntervention(task.id)).rejects.toThrow(/Cannot retry/);
  });

  test("cancel from awaiting_intervention transitions to failed", async () => {
    const { service } = createTestService({
      planner: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "nope",
        metrics: { elapsedSeconds: 0.1 }
      })
    });

    const paused = await service.submitTask("autoforge", "Build a STANDARD feature");
    expect(paused.state).toBe("awaiting_intervention");

    const cancelled = await service.cancelTask(paused.id, "no longer needed");
    expect(cancelled.state).toBe("failed");
  });
});

describe("StageFailedError is exported for callers that need to distinguish", () => {
  test("class is exported and identifiable via instanceof", () => {
    const err = new StageFailedError("task-xyz", "planning", "nope");
    expect(err).toBeInstanceOf(StageFailedError);
    expect(err.taskId).toBe("task-xyz");
    expect(err.stage).toBe("planning");
    expect(err.message).toBe("nope");
  });
});
