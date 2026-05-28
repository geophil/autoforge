import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import type { AgentResult, AgentTask } from "../../src/executors/interface";

describe("orchestrator model routing", () => {
  test("emits routing decisions and passes routed models to agents", async () => {
    const models: string[] = [];
    const { service, db, cleanup } = createTestService({
      coder: (task: AgentTask) => {
        models.push(task.model ?? "");
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    }, {
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });
    try {
      const task = await service.submitTask("autoforge", "Update auth session migration", {
        reviewPlan: false,
        forceTier: "STANDARD"
      });

      expect(task.state).toBe("awaiting_approval");
      expect(models).toContain("strong-model");
      const routingEvents = db.listEvents(task.id).filter((event) => event.type === "model_routing_decision");
      expect(routingEvents.length).toBeGreaterThan(0);
      expect(routingEvents.some((event) => event.payload.selected_model_tier === "strong")).toBe(true);
      expect(routingEvents.some((event) => Array.isArray(event.payload.sensitive_areas) &&
        event.payload.sensitive_areas.includes("auth"))).toBe(true);
      const runtimeEvents = db.listEvents(task.id).filter((event) => event.type === "agent_runtime_telemetry");
      expect(runtimeEvents.some((event) => event.payload.agentType === "coder" && event.payload.routedTier === "strong"))
        .toBe(true);
    } finally {
      cleanup();
    }
  });

  test("retries a failed standard dispatch once with the strong model", async () => {
    const plannerModels: string[] = [];
    let plannerCalls = 0;
    const { service, db, cleanup } = createTestService({
      planner: (task: AgentTask) => {
        plannerCalls += 1;
        plannerModels.push(task.model ?? "");
        if (plannerCalls === 1) {
          return {
            status: "FAILED",
            artifacts: [],
            blockReason: "underpowered",
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        return {
          status: "DONE",
          artifacts: [],
          output: {
            discovery: {
              intent: "Do work",
              constraints: [],
              assumptions: [],
              decisions: [],
              nonGoals: [],
              openQuestions: []
            },
            spec: {
              problem: "Do work",
              desiredBehavior: ["Works"],
              acceptanceCriteria: ["Passes"],
              verification: ["Run tests"],
              risks: []
            },
            subtasks: [{
              id: "sub-1",
              sequence: 1,
              behavior: "Works",
              description: "Implement work",
              filesInScope: ["src/"],
              dependencies: [],
              verificationCommands: ["bun test"],
              testCriteria: ["Tests pass"],
              completionEvidence: ["Tests pass"]
            }]
          },
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    }, {
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });
    try {
      const task = await service.submitTask("autoforge", "Add a small helper", {
        reviewPlan: false,
        forceTier: "EXPRESS"
      });

      expect(task.state).toBe("awaiting_approval");
      expect(plannerModels).toEqual(["standard-model", "strong-model"]);
      const routingEvents = db.listEvents(task.id).filter((event) => event.type === "model_routing_decision");
      expect(routingEvents.some((event) => event.payload.escalated === true &&
        event.payload.prior_tier === "standard")).toBe(true);
      const runtimeEvents = db.listEvents(task.id).filter((event) => event.type === "agent_runtime_telemetry");
      expect(runtimeEvents.some((event) => event.payload.agentType === "planner" &&
        event.payload.routedTier === "strong" &&
        event.payload.finalStatus === "DONE")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("emits runtime telemetry for planner, coder, reviewer, and doc dispatches", async () => {
    const { service, db, cleanup } = createTestService({}, {
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });
    try {
      const task = await service.submitTask("autoforge", "Add lifecycle telemetry", {
        reviewPlan: false,
        forceTier: "STANDARD"
      });
      expect(task.state).toBe("awaiting_approval");
      db.sqlite.query("UPDATE tasks SET pr_url = NULL WHERE id = ?").run(task.id);

      const approved = await service.approveTask(task.id);
      expect(approved.state).toBe("completed");

      const runtimeEvents = db.listEvents(task.id).filter((event) => event.type === "agent_runtime_telemetry");
      const agentTypes = runtimeEvents.map((event) => event.payload.agentType);
      expect(agentTypes).toContain("planner");
      expect(agentTypes).toContain("coder");
      expect(agentTypes).toContain("reviewer");
      expect(agentTypes).toContain("doc");

      for (const agentType of ["planner", "coder", "reviewer", "doc"]) {
        const event = runtimeEvents.find((candidate) => candidate.payload.agentType === agentType);
        expect(event?.payload).toMatchObject({
          executor: "mock",
          model: "standard-model",
          routedTier: "standard",
          taskTier: "STANDARD",
          finalStatus: "DONE",
          tokenTotals: { input: 0, output: 0, cached: 0, cacheCreation: 0 },
          modelCounts: { total: 0 },
          toolCounts: { total: 0 },
          qmd: { callCount: 0 },
          toolOutputBytes: { raw: 0, returnedToModel: 0, artifact: 0, summary: 0 }
        });
        expect(event?.status).toBe("done");
      }
    } finally {
      cleanup();
    }
  });

  test("records failed runtime telemetry events with compact failure counts", async () => {
    const { service, db, cleanup } = createTestService({
      coder: (task: AgentTask) => failedCoderResult(task, "FAILED")
    }, {
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });
    try {
      const task = await service.submitTask("autoforge", "Fail during implementation", {
        reviewPlan: false,
        forceTier: "STANDARD"
      });

      const runtimeEvent = db.listEvents(task.id)
        .find((event) => event.type === "agent_runtime_telemetry" && event.payload.agentType === "coder");
      expect(runtimeEvent?.status).toBe("failed");
      expect(runtimeEvent?.payload).toMatchObject({
        finalStatus: "FAILED",
        model: "standard-model",
        routedTier: "standard",
        tokenTotals: { input: 42, output: 3, cached: 0, cacheCreation: 0 },
        modelCounts: { total: 1, byProvider: { anthropic: 1 }, byModel: { "standard-model": 1 } },
        toolCounts: { total: 1, byName: { bash: 1 }, byStatus: { error: 1 }, errors: 1 },
        failureSubtypeCounts: { command_failed: 2 }
      });
      expect(runtimeEvent?.tokenUsage).toEqual({ input: 42, output: 3 });
      expect(runtimeEvent?.estimatedCost).toBe(0.01);
    } finally {
      cleanup();
    }
  });

  test("records timeout runtime telemetry events without requiring a schema migration", async () => {
    const { service, db, cleanup } = createTestService({
      coder: (task: AgentTask) => failedCoderResult(task, "TIMEOUT")
    }, {
      MODEL_TIER_STANDARD: "standard-model",
      MODEL_TIER_STRONG: "strong-model"
    });
    try {
      const task = await service.submitTask("autoforge", "Time out during implementation", {
        reviewPlan: false,
        forceTier: "STANDARD"
      });

      const row = db.sqlite
        .query("SELECT payload FROM events WHERE task_id = ? AND event_type = 'agent_runtime_telemetry' AND agent = 'coder'")
        .get(task.id) as { payload: string } | null;
      const payload = row ? JSON.parse(row.payload) as Record<string, unknown> : null;
      expect(payload).toMatchObject({
        agentType: "coder",
        finalStatus: "TIMEOUT",
        model: "standard-model",
        routedTier: "standard",
        failureSubtypeCounts: { command_timeout: 2 }
      });

      const runtimeEvent = db.listEvents(task.id)
        .find((event) => event.type === "agent_runtime_telemetry" && event.payload.agentType === "coder");
      expect(runtimeEvent?.status).toBe("timeout");
    } finally {
      cleanup();
    }
  });
});

function failedCoderResult(task: AgentTask, status: "FAILED" | "TIMEOUT"): AgentResult {
  const failureSubtype = status === "TIMEOUT" ? "command_timeout" : "command_failed";
  return {
    status,
    artifacts: [],
    blockReason: `${status.toLowerCase()} for telemetry test`,
    diagnostics: { failureSubtype },
    metrics: {
      elapsedSeconds: 1.5,
      tokenInput: 42,
      tokenOutput: 3,
      estimatedCost: 0.01,
      toolStats: {
        readCount: 0,
        writeCount: 1,
        bashCount: 1,
        searchCount: 0,
        iterations: 1
      },
      telemetry: {
        totalEstimatedCost: 0.01,
        totalTokens: { input: 42, output: 3, cached: 0, cacheCreation: 0 },
        cacheHitRatio: 0,
        retryCount: 0,
        mostExpensiveModel: task.model ?? "",
        mostExpensivePhase: "coder",
        toolOutputContributionBytes: 12,
        events: {
          models: [{
            provider: "anthropic",
            model: task.model ?? "",
            agentType: "coder",
            tokens: { input: 42, output: 3 },
            latencyMs: 80,
            timestamp: 1,
            retryAttempt: 0,
            estimatedCost: 0.01,
            failureSubtype
          }],
          tools: [{
            toolName: "bash",
            status: "error",
            latencyMs: 120,
            rawOutputBytes: 24,
            truncatedOutputBytes: 12,
            returnedToModelBytes: 12,
            failureSubtype
          }]
        }
      }
    }
  };
}
