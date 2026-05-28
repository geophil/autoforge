import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { StageFailedError } from "../../src/orchestrator/service";

describe("awaiting_intervention: planner failures surface with forensics", () => {
  test("planner output without QMD evidence pauses in awaiting_intervention when QMD is configured", async () => {
    const { service, db } = createTestService(
      {
        planner: async () => ({
          status: "DONE",
          artifacts: [],
          output: {
            discovery: {
              intent: "Plan feature",
              constraints: [],
              assumptions: [],
              decisions: [],
              nonGoals: [],
              openQuestions: []
            },
            spec: {
              problem: "Need behavior",
              desiredBehavior: ["Do the thing"],
              acceptanceCriteria: ["Works"],
              verification: ["Tests"],
              risks: []
            }
          },
          metrics: { elapsedSeconds: 0.3 }
        })
      },
      { QMD_MCP_URL: "http://localhost:8181/mcp" }
    );

    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis");
    expect(failure).toBeDefined();
    expect(failure!.payload.failure_category).toBe("planner_missing_qmd_context");
    expect(failure!.payload.qmd_required).toBe(true);
    expect(failure!.payload.qmd_evidence_status).toBe("missing");
  });

  test("planner output with QMD evidence proceeds to spec approval when QMD is configured", async () => {
    const { service } = createTestService(
      {
        planner: async () => ({
          status: "DONE",
          artifacts: [],
          output: {
            discovery: {
              intent: "Plan feature",
              constraints: [],
              assumptions: [],
              decisions: [],
              nonGoals: [],
              openQuestions: []
            },
            spec: {
              problem: "Need behavior",
              desiredBehavior: ["Do the thing"],
              acceptanceCriteria: ["Works"],
              verification: ["Tests"],
              risks: []
            },
            planningContext: {
              qmdContext: {
                status: "used",
                phase: "spec",
                queries: ["task orchestration planning gate"],
                documents: ["docs/qmd/domain-task-orchestration.md"],
                fallbackReason: null
              }
            }
          },
          metrics: { elapsedSeconds: 0.3 }
        })
      },
      { QMD_MCP_URL: "http://localhost:8181/mcp" }
    );

    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");
  });

  test("execution-plan phase also enforces QMD evidence when configured", async () => {
    const { service, db } = createTestService(
      {
        planner: async (task) => {
          const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
          const phase = phaseMatch?.[1];
          if (phase === "spec") {
            return {
              status: "DONE",
              artifacts: [],
              output: {
                discovery: {
                  intent: "Plan feature",
                  constraints: [],
                  assumptions: [],
                  decisions: [],
                  nonGoals: [],
                  openQuestions: []
                },
                spec: {
                  problem: "Need behavior",
                  desiredBehavior: ["Do the thing"],
                  acceptanceCriteria: ["Works"],
                  verification: ["Tests"],
                  risks: []
                },
                planningContext: {
                  qmdContext: {
                    status: "used",
                    phase: "spec",
                    queries: ["spec phase query"],
                    documents: ["docs/qmd/domain-task-orchestration.md"],
                    fallbackReason: null
                  }
                }
              },
              metrics: { elapsedSeconds: 0.2 }
            };
          }
          return {
            status: "DONE",
            artifacts: [],
            output: {
              subtasks: [
                {
                  id: "t1-subtask-1",
                  sequence: 1,
                  description: "Implement",
                  filesInScope: ["src/"],
                  dependencies: [],
                  testCriteria: ["passes"]
                }
              ]
            },
            metrics: { elapsedSeconds: 0.2 }
          };
        }
      },
      { QMD_MCP_URL: "http://localhost:8181/mcp" }
    );

    const created = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(created.state).toBe("awaiting_spec_approval");

    const afterApproveSpec = await service.approveSpec(created.id);
    expect(afterApproveSpec.state).toBe("awaiting_intervention");

    const events = db.listEvents(created.id);
    const failure = events.find((e) => e.type === "failure_analysis");
    expect(failure).toBeDefined();
    expect(failure!.payload.failure_category).toBe("planner_missing_qmd_context");
    expect(failure!.payload.requested_phase).toBe("execution_plan");
  });

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
    expect(failure!.payload).toHaveProperty("exit_code");
    expect(failure!.payload).toHaveProperty("stderr_excerpt");
    expect(failure!.payload).toHaveProperty("stdout_excerpt");
    expect(failure!.payload).toHaveProperty("command");
    expect(failure!.payload).toHaveProperty("workspace_id");
    expect(failure!.payload).toHaveProperty("checkpoint_stage");
    expect(failure!.payload).toHaveProperty("checkpoint_id");
  });

  test("coder failure diagnostics include excerpt + workspace/checkpoint context when provided", async () => {
    const { service, db } = createTestService(
      {
        coder: async () => ({
          status: "FAILED",
          artifacts: [],
          blockReason: "claude exited with code 1:",
          diagnostics: {
            exitCode: 1,
            stderrExcerpt: "Invalid MCP configuration",
            stdoutExcerpt: "Loading config...",
            command: "claude --print",
            executorMode: "harness"
          },
          metrics: { elapsedSeconds: 0.15 }
        })
      },
      { AUTOFORGE_RESUME_SUBTASK_ENABLED: "1" }
    );

    const task = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_intervention");

    const events = db.listEvents(task.id);
    const failure = events.find((e) => e.type === "failure_analysis" && e.payload.stage_failed === "executing");
    expect(failure).toBeDefined();
    expect(failure!.payload.exit_code).toBe(1);
    expect(failure!.payload.stderr_excerpt).toContain("Invalid MCP configuration");
    expect(failure!.payload.stdout_excerpt).toContain("Loading config");
    expect(failure!.payload.command).toContain("claude");
    expect(failure!.payload.executor_mode).toBe("harness");
    expect(typeof failure!.payload.workspace_id).toBe("string");
    expect(failure!.payload.checkpoint_stage).toBe("task_start");
    expect(typeof failure!.payload.checkpoint_id).toBe("string");
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
      planner: async (task) => {
        plannerCalls += 1;
        if (plannerCalls <= 2) {
          return {
            status: "FAILED",
            artifacts: [],
            blockReason: "first call fails",
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];
        if (phase === "spec") {
          const desc =
            typeof task.metadata?.description === "string" ? task.metadata.description : "task";
          return {
            status: "DONE",
            artifacts: [],
            output: {
              discovery: {
                intent: desc,
                constraints: [],
                assumptions: [],
                decisions: [],
                nonGoals: [],
                openQuestions: []
              },
              spec: {
                problem: `Solve: ${desc}`,
                desiredBehavior: ["Meet criteria", "Keep tests green"],
                acceptanceCriteria: ["Matches description", "Tests pass"],
                verification: ["Run tests"],
                risks: []
              },
              blockingQuestion: null
            },
            metrics: { elapsedSeconds: 0.2, tokenInput: 100, tokenOutput: 50 }
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

    expect(retried.state).toBe("awaiting_spec_approval");
    expect(retried.specArtifacts?.spec.problem.length).toBeGreaterThan(0);
    expect(plannerCalls).toBe(3);

    const afterExec = await service.approveSpec(retried.id);
    expect(afterExec.state).toBe("awaiting_plan_approval");
    expect(afterExec.planSubtasks).toHaveLength(1);
    expect(afterExec.planSubtasks[0].description).toBe("Do the thing");
    expect(plannerCalls).toBe(4);

    const events = db.listEvents(paused.id);
    expect(events.some((e) => e.type === "retry_requested")).toBe(true);
  });

  test("rollback to task-start checkpoint then retry from planning stays replay-consistent", async () => {
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async (task) => {
        plannerCalls += 1;
        if (plannerCalls <= 2) {
          return {
            status: "FAILED",
            artifacts: [],
            blockReason: "first call fails",
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];
        if (phase === "spec") {
          const desc =
            typeof task.metadata?.description === "string" ? task.metadata.description : "task";
          return {
            status: "DONE",
            artifacts: [],
            output: {
              discovery: {
                intent: desc,
                constraints: [],
                assumptions: [],
                decisions: [],
                nonGoals: [],
                openQuestions: []
              },
              spec: {
                problem: `Solve: ${desc}`,
                desiredBehavior: ["Meet criteria", "Keep tests green"],
                acceptanceCriteria: ["Matches description", "Tests pass"],
                verification: ["Run tests"],
                risks: []
              },
              blockingQuestion: null
            },
            metrics: { elapsedSeconds: 0.2, tokenInput: 100, tokenOutput: 50 }
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

    const taskStartCheckpoint = db.listEvents(paused.id).find(
      (event) => event.type === "checkpoint_created" && event.payload.label === "task-start"
    );
    expect(taskStartCheckpoint).toBeDefined();

    const retried = await service.retryFromIntervention(paused.id, {
      fromStage: "planning",
      checkpointId: String(taskStartCheckpoint!.payload.checkpoint_id),
      operatorNote: "reset to task start"
    });
    expect(retried.state).toBe("awaiting_spec_approval");
    expect(plannerCalls).toBe(3);

    const rollback = db.listEvents(paused.id).find((event) => event.type === "rollback_applied");
    expect(rollback).toBeDefined();
    expect(rollback!.payload.checkpoint_id).toBe(taskStartCheckpoint!.payload.checkpoint_id);
    expect(rollback!.payload.operator_note).toBe("reset to task start");

    const live = db.getTask(paused.id);
    expect(live).toBeDefined();
    db.rebuildProjectionsFromEvents();
    const rebuilt = db.getTask(paused.id);
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.state).toBe(live?.state);
    expect(rebuilt?.iteration).toBe(live?.iteration);
  });

  test("rejects retry stage earlier than checkpoint stage", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "FAILED",
        artifacts: [],
        blockReason: "planner failed",
        metrics: { elapsedSeconds: 0.1 }
      })
    });

    const paused = await service.submitTask("autoforge", "Build a STANDARD feature");
    expect(paused.state).toBe("awaiting_intervention");

    const interventionCheckpoint = db.listEvents(paused.id).find(
      (event) => event.type === "checkpoint_created" && event.payload.stage === "awaiting_intervention"
    );
    expect(interventionCheckpoint).toBeDefined();

    await expect(service.retryFromIntervention(paused.id, {
      fromStage: "planning",
      checkpointId: String(interventionCheckpoint!.payload.checkpoint_id)
    })).rejects.toThrow("checkpoint_stage_after_retry_stage");

    await expect(service.retryFromIntervention(paused.id, {
      checkpointId: String(interventionCheckpoint!.payload.checkpoint_id)
    })).rejects.toThrow("checkpoint_stage_after_retry_stage");
  });

  test("steering queued during intervention is consumed on next planner retry", async () => {
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async () => {
        plannerCalls += 1;
        if (plannerCalls <= 2) {
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
    service.addSteeringMessage(paused.id, "Keep the plan focused and avoid unrelated refactors.");

    await service.retryFromIntervention(paused.id, { fromStage: "planning" });

    const events = db.listEvents(paused.id);
    const steeringMessage = events.find((event) => event.type === "steering_message");
    const consumed = events.find((event) => event.type === "steering_consumed");
    expect(steeringMessage).toBeDefined();
    expect(consumed).toBeDefined();
    expect(consumed!.payload.agent_type).toBe("planner");
    expect(consumed!.payload.steering_event_ids).toContain(steeringMessage!.id);
  });

  test("retry from executing re-runs coder with existing plan", async () => {
    let coderCalls = 0;
    const { service } = createTestService({
      coder: async () => {
        coderCalls += 1;
        if (coderCalls <= 2) {
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
    expect(coderCalls).toBe(3);
  });

  test("retry from executing resumes from failed subtask when feature flag is enabled", async () => {
    const coderCalls: string[] = [];
    const { service } = createTestService(
      {
        planner: async () => ({
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [
              {
                id: "sub-1",
                sequence: 1,
                description: "first subtask",
                filesInScope: ["src/a.ts"],
                dependencies: [],
                testCriteria: ["passes"]
              },
              {
                id: "sub-2",
                sequence: 2,
                description: "second subtask",
                filesInScope: ["src/b.ts"],
                dependencies: ["sub-1"],
                testCriteria: ["passes"]
              }
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        }),
        coder: async (task) => {
          const subtaskId = String((task.metadata?.subtask as { id?: string } | undefined)?.id ?? "unknown");
          coderCalls.push(subtaskId);
          if (coderCalls.length === 2 || coderCalls.length === 3) {
            return {
              status: "FAILED",
              artifacts: [],
              blockReason: "sub-2 failed",
              metrics: { elapsedSeconds: 0.1 }
            };
          }
          return {
            status: "DONE",
            artifacts: [`src/${subtaskId}.ts`],
            metrics: { elapsedSeconds: 0.1 }
          };
        }
      },
      { AUTOFORGE_RESUME_SUBTASK_ENABLED: "1" }
    );

    const paused = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS", reviewPlan: false });
    expect(paused.state).toBe("awaiting_intervention");
    expect(coderCalls).toEqual(["sub-1", "sub-2", "sub-2"]);

    const retried = await service.retryFromIntervention(paused.id, { fromStage: "executing" });
    expect(retried.state).toBe("awaiting_approval");
    expect(coderCalls).toEqual(["sub-1", "sub-2", "sub-2", "sub-2"]);
  });

  test("retry from executing can force full replay even when resume mode is enabled", async () => {
    const coderCalls: string[] = [];
    const { service } = createTestService(
      {
        planner: async () => ({
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [
              {
                id: "sub-1",
                sequence: 1,
                description: "first subtask",
                filesInScope: ["src/a.ts"],
                dependencies: [],
                testCriteria: ["passes"]
              },
              {
                id: "sub-2",
                sequence: 2,
                description: "second subtask",
                filesInScope: ["src/b.ts"],
                dependencies: ["sub-1"],
                testCriteria: ["passes"]
              }
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        }),
        coder: async (task) => {
          const subtaskId = String((task.metadata?.subtask as { id?: string } | undefined)?.id ?? "unknown");
          coderCalls.push(subtaskId);
          if (coderCalls.length === 2 || coderCalls.length === 3) {
            return {
              status: "FAILED",
              artifacts: [],
              blockReason: "sub-2 failed",
              metrics: { elapsedSeconds: 0.1 }
            };
          }
          return {
            status: "DONE",
            artifacts: [`src/${subtaskId}.ts`],
            metrics: { elapsedSeconds: 0.1 }
          };
        }
      },
      { AUTOFORGE_RESUME_SUBTASK_ENABLED: "1" }
    );

    const paused = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS", reviewPlan: false });
    expect(paused.state).toBe("awaiting_intervention");

    const retried = await service.retryFromIntervention(paused.id, {
      fromStage: "executing",
      forceFullReplay: true
    });
    expect(retried.state).toBe("awaiting_approval");
    expect(coderCalls).toEqual(["sub-1", "sub-2", "sub-2", "sub-1", "sub-2"]);
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
    expect(plannerCalls).toBe(4);

    const events = db.listEvents(first.id);
    const failures = events.filter((e) => e.type === "failure_analysis");
    expect(failures).toHaveLength(2);
    expect(failures[1].payload.failure_reason).toBe("planner failure #4");
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

// Plan §Task 7 — rollback-to-approved-spec policy.
//
// All four scenarios share the same setup: a STANDARD task whose spec was
// approved and whose subsequent execution-plan planner call failed, leaving
// the task in `awaiting_intervention` with `planningContext.reviewedAt` set.
function specApprovedExecutionFailedPlanner() {
  let plannerCalls = 0;
  return {
    plannerCalls: () => plannerCalls,
    handler: async (task: { prompt: string; metadata?: { description?: unknown } }) => {
      plannerCalls += 1;
      const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
      const phase = phaseMatch?.[1];
      if (phase === "execution_plan") {
        return {
          status: "FAILED" as const,
          artifacts: [] as string[],
          blockReason: "synthetic execution-plan failure",
          metrics: { elapsedSeconds: 0.1 }
        };
      }
      const desc =
        typeof task.metadata?.description === "string" ? task.metadata.description : "task";
      return {
        status: "DONE" as const,
        artifacts: [] as string[],
        output: {
          discovery: {
            intent: desc,
            constraints: [],
            assumptions: [],
            decisions: [],
            nonGoals: [],
            openQuestions: []
          },
          spec: {
            problem: `Solve: ${desc}`,
            desiredBehavior: ["Meet criteria", "Keep tests green"],
            acceptanceCriteria: ["Matches description", "Tests pass"],
            verification: ["Run tests"],
            risks: []
          },
          blockingQuestion: null
        },
        metrics: { elapsedSeconds: 0.2, tokenInput: 100, tokenOutput: 50 }
      };
    }
  };
}

describe("retryFromIntervention: rollback-to-approved-spec policy", () => {
  test("rollback to spec-phase checkpoint clears planningContext.reviewedAt and re-pauses at awaiting_spec_approval", async () => {
    const planner = specApprovedExecutionFailedPlanner();
    const { service, db } = createTestService({ planner: planner.handler });

    const initial = await service.submitTask("autoforge", "Build a STANDARD widget");
    expect(initial.state).toBe("awaiting_spec_approval");

    await service.approveSpec(initial.id);
    const afterFailure = service.getTask(initial.id)!;
    expect(afterFailure.state).toBe("awaiting_intervention");
    expect(afterFailure.planningContext?.reviewedAt).toBeTruthy();
    expect(afterFailure.planningContext?.approvalMode).toBe("manual");

    const taskStart = db.listEvents(initial.id).find(
      (event) => event.type === "checkpoint_created" && event.payload.label === "task-start"
    );
    expect(taskStart).toBeDefined();
    expect((taskStart!.payload as { planning_phase?: string }).planning_phase).toBe("spec");

    const retried = await service.retryFromIntervention(initial.id, {
      fromStage: "planning",
      checkpointId: String(taskStart!.payload.checkpoint_id),
      operatorNote: "spec was wrong"
    });

    expect(retried.state).toBe("awaiting_spec_approval");
    expect(retried.planningContext?.reviewedAt).toBeNull();
    expect(retried.planningContext?.approvalMode).toBeNull();

    const rollback = db.listEvents(initial.id).find((event) => event.type === "rollback_applied");
    expect(rollback).toBeDefined();
    expect(rollback!.payload.invalidated_planning_context).toBe(true);
    expect(rollback!.payload.checkpoint_planning_phase).toBe("spec");
  });

  test("retry with planningPhase=spec on an approved-spec task without checkpoint throws cannot_rollback_to_approved_spec", async () => {
    const planner = specApprovedExecutionFailedPlanner();
    const { service } = createTestService({ planner: planner.handler });

    const initial = await service.submitTask("autoforge", "Build a STANDARD widget");
    await service.approveSpec(initial.id);
    expect(service.getTask(initial.id)!.state).toBe("awaiting_intervention");

    await expect(
      service.retryFromIntervention(initial.id, {
        fromStage: "planning",
        planningPhase: "spec"
      })
    ).rejects.toThrow("cannot_rollback_to_approved_spec");
  });

  test("force: true bypasses the cannot_rollback_to_approved_spec guard", async () => {
    const planner = specApprovedExecutionFailedPlanner();
    const { service, db } = createTestService({ planner: planner.handler });

    const initial = await service.submitTask("autoforge", "Build a STANDARD widget");
    await service.approveSpec(initial.id);
    expect(service.getTask(initial.id)!.state).toBe("awaiting_intervention");

    const retried = await service.retryFromIntervention(initial.id, {
      fromStage: "planning",
      planningPhase: "spec",
      force: true
    });
    expect(retried.state).toBe("awaiting_spec_approval");

    // The retry_requested event records the force flag so audit trail is preserved.
    const retryRequested = db.listEvents(initial.id).find((e) => e.type === "retry_requested");
    expect(retryRequested!.payload.force).toBe(true);
  });

  test("post-rollback spec attempt uses monotonic counter and scoped budget", async () => {
    const planner = specApprovedExecutionFailedPlanner();
    const { service, db } = createTestService({ planner: planner.handler });

    const initial = await service.submitTask("autoforge", "Build a STANDARD widget");
    await service.approveSpec(initial.id);

    const preRollbackTranscripts = db.listTranscriptsByTask(initial.id);
    const preSpec = preRollbackTranscripts.filter((t) => t.stage === "planner:spec");
    expect(preSpec).toHaveLength(1);
    expect(preSpec[0].attempt).toBe(0);
    expect(preSpec[0].rollbackEventId).toBeNull();

    const taskStart = db.listEvents(initial.id).find(
      (event) => event.type === "checkpoint_created" && event.payload.label === "task-start"
    );
    await service.retryFromIntervention(initial.id, {
      fromStage: "planning",
      checkpointId: String(taskStart!.payload.checkpoint_id)
    });

    const rollbackEvent = db.listEvents(initial.id).find((e) => e.type === "rollback_applied")!;
    const postSpec = db
      .listTranscriptsByTask(initial.id)
      .filter((t) => t.stage === "planner:spec");
    expect(postSpec).toHaveLength(2);

    // Monotonic counter: new spec transcript uses attempt = max(prior) + 1.
    const newAttempt = postSpec.find((t) => t.rollbackEventId === rollbackEvent.id);
    expect(newAttempt).toBeDefined();
    expect(newAttempt!.attempt).toBe(1);

    // (task_id, stage, attempt) UNIQUE is preserved since the new row used
    // attempt=1 rather than reusing 0. Sanity check via direct SQL.
    const dupRows = db.sqlite
      .query(
        "SELECT attempt FROM agent_transcripts WHERE task_id = ? AND stage = ? ORDER BY attempt ASC"
      )
      .all(initial.id, "planner:spec") as Array<{ attempt: number }>;
    expect(dupRows.map((r) => r.attempt)).toEqual([0, 1]);

    // Budget scope: the spec critique budget is enforced on transcripts
    // matching the current rollback scope. Pre-rollback attempts are excluded.
    // After the rollback there is exactly one scoped spec attempt (attempt=1),
    // so critiqueSpec must accept three more critiques before tripping the
    // PLANNER_SPEC_MAX_ITERATIONS=3 ceiling.
    await service.critiqueSpec(initial.id, "tighten acceptance criteria");
    await service.critiqueSpec(initial.id, "name a concrete metric");
    await expect(
      service.critiqueSpec(initial.id, "one more tweak")
    ).rejects.toThrow(/limit/i);
  });
});
