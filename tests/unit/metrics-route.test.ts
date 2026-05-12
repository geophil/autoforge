import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createWebServer } from "../../src/web/server";
import { createTestService } from "../helpers/create-service";
import type { AutoforgeMessage } from "../../src/nats/messages";

function appendTokenEvent(input: {
  db: ReturnType<typeof createTestService>["db"];
  projectId: string;
  taskId: string;
  agent: AutoforgeMessage["agent"];
  eventType: string;
  transcriptStage?: string;
  attempt?: number;
  tokenInput: number;
  tokenOutput?: number;
  contextEnvelopeHash?: string;
}): void {
  const payload: Record<string, unknown> = {};
  if (input.transcriptStage) payload.transcript_stage = input.transcriptStage;
  if (input.attempt !== undefined) payload.attempt = input.attempt;
  input.db.appendEvent({
    id: randomUUID(),
    taskId: input.taskId,
    projectId: input.projectId,
    timestamp: new Date().toISOString(),
    agent: input.agent,
    type: input.eventType,
    status: "done",
    payload,
    budgetSeconds: 30,
    tokenUsage: {
      input: input.tokenInput,
      output: input.tokenOutput ?? 0,
      estimatedCost: 0
    }
  }, { contextEnvelopeHash: input.contextEnvelopeHash });
}

describe("GET /api/metrics/:projectId/token-kpis", () => {
  test("returns planner KPI summary scoped to project", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t1",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:spec",
        attempt: 0,
        tokenInput: 100
      });
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t1",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:execution_plan",
        attempt: 1,
        tokenInput: 300
      });
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t1",
        agent: "coder",
        eventType: "subtask_done",
        tokenInput: 200
      });
      // Different project must not affect p1 metrics.
      appendTokenEvent({
        db,
        projectId: "p2",
        taskId: "t2",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:spec",
        attempt: 0,
        tokenInput: 999
      });

      const response = await app.request("/api/metrics/p1/token-kpis?windowDays=30");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.projectId).toBe("p1");
      expect(body.plannerRows).toBe(2);
      expect(body.summary.plannerMedianInputTokens).toBe(200);
      expect(body.summary.totalInputTokens).toBe(600);
      expect(body.summary.plannerRetries).toBe(1);
      expect(body.summary.plannerInputShare).toBeCloseTo(2 / 3, 5);
    } finally {
      cleanup();
    }
  });
});

describe("GET /api/metrics/:projectId/envelope-reuse", () => {
  test("returns repeated envelope hashes ordered by occurrences", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t1",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:spec",
        tokenInput: 100,
        contextEnvelopeHash: "hash-a"
      });
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t2",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:execution_plan",
        tokenInput: 120,
        contextEnvelopeHash: "hash-a"
      });
      appendTokenEvent({
        db,
        projectId: "p1",
        taskId: "t3",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:execution_plan",
        tokenInput: 130,
        contextEnvelopeHash: "hash-b"
      });
      // Different project, same hash should not leak into p1 results.
      appendTokenEvent({
        db,
        projectId: "p2",
        taskId: "t4",
        agent: "planner",
        eventType: "planned",
        transcriptStage: "planner:execution_plan",
        tokenInput: 999,
        contextEnvelopeHash: "hash-a"
      });

      const response = await app.request("/api/metrics/p1/envelope-reuse?windowDays=30&limit=5");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.projectId).toBe("p1");
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].contextEnvelopeHash).toBe("hash-a");
      expect(body.rows[0].occurrences).toBe(2);
    } finally {
      cleanup();
    }
  });
});
