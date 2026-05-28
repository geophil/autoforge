import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import type { AgentTask } from "../../src/executors/interface";

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
    } finally {
      cleanup();
    }
  });
});
