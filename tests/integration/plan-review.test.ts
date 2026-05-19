import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { fullPlanSubtask } from "../helpers/plan-subtask";

describe("plan-review pause", () => {
  test("STANDARD task pauses at awaiting_spec_approval after planner", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");
    expect(task.specArtifacts).toBeTruthy();
    expect(task.planSubtasks).toHaveLength(0);

    const transcripts = db.listTranscriptsByTask(task.id);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].stage).toBe("planner:spec");
    expect(transcripts[0].personaVersionId).toBeTruthy();
  });

  test("EXPRESS task does not pause; runs through to awaiting_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "tiny tweak", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");
  });
});

describe("approvePlan", () => {
  test("approves plan and runs to awaiting_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");

    const planGate = await service.approveSpec(task.id);
    expect(planGate.state).toBe("awaiting_plan_approval");

    const resumed = await service.approvePlan(planGate.id);
    expect(resumed.state).toBe("awaiting_approval");
  });

  test("rejects approve when task is not in awaiting_plan_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    await expect(service.approvePlan(task.id)).rejects.toThrow();
  });

  test("queued steering is consumed on next coder dispatch", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_spec_approval");

    await service.approveSpec(task.id);
    service.addSteeringMessage(task.id, "Prefer the v2 endpoint and avoid legacy adapters.");
    const resumed = await service.approvePlan(task.id);
    expect(resumed.state).toBe("awaiting_approval");

    const events = db.listEvents(task.id);
    const steeringMessage = events.find((event) => event.type === "steering_message");
    const consumed = events.find((event) => event.type === "steering_consumed");
    expect(steeringMessage).toBeDefined();
    expect(consumed).toBeDefined();
    expect(consumed!.payload.agent_type).toBe("coder");
    expect(consumed!.payload.steering_event_ids).toContain(steeringMessage!.id);
  });
});

describe("critiquePlan", () => {
  test("critique re-runs planner and returns to awaiting_plan_approval", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    await service.approveSpec(task.id);
    const atPlan = service.getTask(task.id)!;
    expect(atPlan.state).toBe("awaiting_plan_approval");

    const after = await service.critiquePlan(task.id, "please split subtask 1");
    expect(after.state).toBe("awaiting_plan_approval");

    const transcripts = db.listTranscriptsByTask(task.id);
    const execRows = transcripts.filter((t) => t.stage === "planner:execution_plan");
    expect(execRows).toHaveLength(2);
    expect(execRows[1].attempt).toBe(1);
  });

  test("critique on a non-paused task is rejected", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    await expect(service.critiquePlan(task.id, "x")).rejects.toThrow();
  });

  test("4th critique exceeds limit and throws", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "STANDARD task");
    await service.approveSpec(task.id);
    await service.critiquePlan(task.id, "feedback 1");
    await service.critiquePlan(task.id, "feedback 2");
    await service.critiquePlan(task.id, "feedback 3");
    await expect(service.critiquePlan(task.id, "feedback 4")).rejects.toThrow(/limit/i);
  });
});

// Plan §Test Matrix item 3 — blocking-question Q&A round-trip.
describe("blockingQuestion answer loop", () => {
  test("planner blockingQuestion is persisted, critique routes Q+A into next prompt, clears on success", async () => {
    const prompts: string[] = [];
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async (task) => {
        plannerCalls += 1;
        prompts.push(task.prompt);
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];

        if (phase === "spec") {
          // First spec attempt poses a blockingQuestion; the second attempt
          // (after the operator answers) returns a clean spec with no question.
          const blockingQuestion =
            plannerCalls === 1 ? "Should totals exclude archived widgets?" : null;
          return {
            status: "DONE",
            artifacts: [],
            output: {
              discovery: {
                intent: "Widget totals API",
                constraints: [],
                assumptions: [],
                decisions: [],
                nonGoals: [],
                openQuestions: []
              },
              spec: {
                problem: "No totals view",
                desiredBehavior: ["Return totals", "Paginate"],
                acceptanceCriteria: ["p95 <100ms", "Rate limit applied"],
                verification: ["Load test"],
                risks: []
              },
              blockingQuestion
            },
            metrics: { elapsedSeconds: 0.2 }
          };
        }
        // execution_plan phase
        return {
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [
              {
                id: "t1-subtask-1",
                sequence: 1,
                description: "Wire endpoint",
                filesInScope: ["src/api/totals.ts"],
                dependencies: [],
                testCriteria: ["Returns totals"]
              }
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const task = await service.submitTask("autoforge", "Widget totals API", { forceTier: "THOROUGH" });
    expect(task.state).toBe("awaiting_spec_approval");
    expect(task.currentBlockingQuestion).toBe("Should totals exclude archived widgets?");

    await service.critiqueSpec(task.id, "Exclude archived widgets entirely.");
    const afterAnswer = service.getTask(task.id)!;
    expect(afterAnswer.state).toBe("awaiting_spec_approval");
    // currentBlockingQuestion clears once the next planner attempt does not pose one.
    expect(afterAnswer.currentBlockingQuestion).toBeNull();

    // The second planner prompt must include the Q+A scaffolding.
    expect(prompts).toHaveLength(2);
    const secondPrompt = prompts[1];
    expect(secondPrompt).toContain("## Operator Answer To Question");
    expect(secondPrompt).toContain("> Q: Should totals exclude archived widgets?");
    expect(secondPrompt).toContain("Exclude archived widgets entirely.");

    // Transcripts: two planner:spec attempts at monotonic indices.
    const specRows = db
      .listTranscriptsByTask(task.id)
      .filter((t) => t.stage === "planner:spec")
      .sort((a, b) => a.attempt - b.attempt);
    expect(specRows.map((r) => r.attempt)).toEqual([0, 1]);
  });
});

// Plan §Test Matrix item 6 — retry from awaiting_intervention preserves
// approved spec context when only the execution-plan phase failed.
describe("retry preserves approved spec when execution-plan attempt fails", () => {
  test("retry without checkpoint, planningPhase=execution_plan, keeps specArtifacts and reviewedAt", async () => {
    let planCalls = 0;
    const { service, db } = createTestService({
      planner: async (task) => {
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];

        if (phase === "spec") {
          return {
            status: "DONE",
            artifacts: [],
            output: {
              discovery: {
                intent: "Build widget API",
                constraints: [],
                assumptions: [],
                decisions: [],
                nonGoals: [],
                openQuestions: []
              },
              spec: {
                problem: "Need widget API",
                desiredBehavior: ["Return totals", "Paginate"],
                acceptanceCriteria: ["p95 <100ms", "Rate limit applied"],
                verification: ["Load test"],
                risks: []
              },
              blockingQuestion: null
            },
            metrics: { elapsedSeconds: 0.2 }
          };
        }
        // execution_plan
        planCalls += 1;
        if (planCalls === 1) {
          return {
            status: "FAILED",
            artifacts: [],
            blockReason: "synthetic plan failure",
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        return {
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [
              {
                id: "t-subtask-1",
                sequence: 1,
                description: "Wire endpoint",
                filesInScope: ["src/api/totals.ts"],
                dependencies: [],
                testCriteria: ["Returns 200"]
              }
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const initial = await service.submitTask("autoforge", "Widget API");
    expect(initial.state).toBe("awaiting_spec_approval");

    await service.approveSpec(initial.id);
    const paused = service.getTask(initial.id)!;
    expect(paused.state).toBe("awaiting_intervention");
    expect(paused.planningContext?.reviewedAt).toBeTruthy();
    expect(paused.specArtifacts?.spec.problem).toBe("Need widget API");

    // Retry without checkpoint, default phase (inferred = execution_plan since
    // last transcript is planner:execution_plan). Approved spec must survive.
    const retried = await service.retryFromIntervention(initial.id, {
      fromStage: "planning"
    });

    expect(retried.state).toBe("awaiting_plan_approval");
    expect(retried.specArtifacts?.spec.problem).toBe("Need widget API");
    expect(retried.planningContext?.reviewedAt).toBeTruthy();
    expect(retried.planningContext?.approvalMode).toBe("manual");

    // The execution-plan retry got the approved spec injected into its prompt.
    const execTranscripts = db
      .listTranscriptsByTask(initial.id)
      .filter((t) => t.stage === "planner:execution_plan");
    expect(execTranscripts).toHaveLength(2);
  });
});

// Plan §Test Matrix item 8 — reviewPlan: false combined-phase persistence.
describe("reviewPlan: false combined-phase persistence", () => {
  test("STANDARD task with reviewPlan: false issues one planner call and persists both spec and subtasks", async () => {
    let plannerCalls = 0;
    const phasesSeen: string[] = [];
    const { service, db } = createTestService({
      planner: async (task) => {
        plannerCalls += 1;
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1] ?? "unknown";
        phasesSeen.push(phase);

        return {
          status: "DONE",
          artifacts: [],
          output: {
            discovery: {
              intent: "Streamlined task",
              constraints: [],
              assumptions: [],
              decisions: [],
              nonGoals: [],
              openQuestions: []
            },
            spec: {
              problem: "Combined-phase spec",
              desiredBehavior: ["Behave"],
              acceptanceCriteria: ["Works"],
              verification: ["Tests"],
              risks: []
            },
            subtasks: [
              fullPlanSubtask({
                id: "t1-subtask-1",
                description: "Implement",
                filesInScope: ["src/foo.ts"],
                testCriteria: ["passes"]
              })
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const task = await service.submitTask("autoforge", "Combined-phase task", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    expect(plannerCalls).toBe(1);
    expect(phasesSeen).toEqual(["combined"]);

    const reloaded = service.getTask(task.id)!;
    expect(reloaded.specArtifacts?.spec.problem).toBe("Combined-phase spec");
    expect(reloaded.planSubtasks).toHaveLength(1);
    expect(reloaded.planningContext?.approvalMode).toBe("auto");
    expect(reloaded.planningContext?.reviewedAt).toBeTruthy();

    // Exactly one planner transcript stored under the execution_plan namespace
    // (combined-phase calls reuse that stage for routing).
    const transcripts = db.listTranscriptsByTask(task.id);
    const plannerTranscripts = transcripts.filter(
      (t) => t.stage === "planner:spec" || t.stage === "planner:execution_plan"
    );
    expect(plannerTranscripts).toHaveLength(1);
  });

  test("combined-phase falls back to two-call when planner returns spec only", async () => {
    let plannerCalls = 0;
    const { service, db } = createTestService({
      planner: async (task) => {
        plannerCalls += 1;
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];
        const desc =
          typeof task.metadata?.description === "string" ? task.metadata.description : "task";

        if (phase === "combined") {
          // Misbehaving planner: returns spec-only despite the combined request.
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
                problem: `Solve ${desc}`,
                desiredBehavior: ["Behave"],
                acceptanceCriteria: ["Works"],
                verification: [],
                risks: []
              }
            },
            metrics: { elapsedSeconds: 0.2 }
          };
        }
        // Second call gets execution_plan request; returns subtasks.
        return {
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [
              fullPlanSubtask({
                id: "t-subtask-1",
                description: "Wire it",
                filesInScope: ["src/"],
                testCriteria: ["Tests pass"]
              })
            ]
          },
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const task = await service.submitTask("autoforge", "Combined fallback test", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    expect(plannerCalls).toBe(2);

    const events = db.listEvents(task.id);
    const fallback = events.find((e) => e.type === "planner_phase_fallback_to_two_call");
    expect(fallback).toBeDefined();
    expect(fallback!.payload.reason).toBe("combined_output_spec_only");

    // Task must NOT have paused at either spec or plan approval — combined path
    // never lands at a human gate by design.
    const transitions = events.filter((e) => e.type.startsWith("state."));
    const pausedStates = transitions
      .map((e) => (e.payload as { state?: string }).state)
      .filter((s) => s === "awaiting_spec_approval" || s === "awaiting_plan_approval");
    expect(pausedStates).toEqual([]);
  });
});

// Plan §Test Matrix item 10 — phase mismatch is not silent.
describe("planner phase mismatch detection", () => {
  test("STANDARD planner asked for spec but returns subtasks pauses at awaiting_spec_approval with a blockingQuestion", async () => {
    const { service, db } = createTestService({
      planner: async (task) => {
        const phaseMatch = /\n## Phase\n(spec|execution_plan|combined)\n/.exec("\n" + task.prompt);
        const phase = phaseMatch?.[1];
        if (phase === "spec") {
          // Misbehaving: returns subtasks when spec was requested.
          return {
            status: "DONE",
            artifacts: [],
            output: {
              subtasks: [
                {
                  id: "t1-subtask-1",
                  sequence: 1,
                  description: "Just implement it",
                  filesInScope: ["src/"],
                  dependencies: [],
                  testCriteria: ["passes"]
                }
              ]
            },
            metrics: { elapsedSeconds: 0.2 }
          };
        }
        return { status: "DONE", artifacts: [], output: { subtasks: [] }, metrics: { elapsedSeconds: 0.2 } };
      }
    });

    const task = await service.submitTask("autoforge", "Should be in spec phase");
    expect(task.state).toBe("awaiting_spec_approval");
    expect(task.specArtifacts).toBeNull();
    expect(task.currentBlockingQuestion).toContain("planner returned execution plan when spec was requested");

    const events = db.listEvents(task.id);
    const mismatch = events.find((e) => e.type === "planner_phase_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch!.payload.detail).toBe("spec_requested_got_execution_plan");
    // Subtasks must NOT have been persisted.
    expect(task.planSubtasks).toEqual([]);
  });
});

describe("end-to-end critique loop", () => {
  test("submit -> critique -> approve -> awaiting_approval", async () => {
    const { service, db } = createTestService();
    const created = await service.submitTask("autoforge", "Build a STANDARD-tier widget");
    expect(created.state).toBe("awaiting_spec_approval");

    await service.critiqueSpec(created.id, "be more specific about acceptance criteria");
    const afterCritique = service.getTask(created.id)!;
    expect(afterCritique.state).toBe("awaiting_spec_approval");

    await service.approveSpec(created.id);
    await service.critiquePlan(created.id, "be more specific about file paths");
    const afterPlanCritique = service.getTask(created.id)!;
    expect(afterPlanCritique.state).toBe("awaiting_plan_approval");

    const approved = await service.approvePlan(created.id);
    expect(approved.state).toBe("awaiting_approval");

    const transcripts = db.listTranscriptsByTask(created.id);
    expect(transcripts.filter((t) => t.stage === "planner:spec").length).toBe(2);
    const execRows = transcripts.filter((t) => t.stage === "planner:execution_plan");
    expect(execRows.length).toBe(2);
    expect(execRows[0].attempt).toBe(0);
    expect(execRows[1].attempt).toBe(1);

    const completed = await service.approveTask(created.id);
    expect(completed.state).toBe("completed");
  });
});
