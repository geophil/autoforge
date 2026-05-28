import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createWebServer } from "../../src/web/server";
import { createTestService } from "../helpers/create-service";
import { testEnv } from "../helpers/test-env";
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

function appendRuntimeTelemetryEvent(input: {
  db: ReturnType<typeof createTestService>["db"];
  projectId: string;
  taskId: string;
  stablePrefixHash: string;
  inputTokens: number;
  cachedInputTokens: number;
  savings: number;
  maxHistoryChars: number;
  returnedToolOutputBytes: number;
  nestedReturnedToolOutputBytes?: number;
}): void {
  input.db.appendEvent({
    id: randomUUID(),
    taskId: input.taskId,
    projectId: input.projectId,
    timestamp: new Date().toISOString(),
    agent: "coder",
    type: "agent_runtime_telemetry",
    status: "done",
    payload: {
      stablePrefixHash: input.stablePrefixHash,
      tokenTotals: {
        input: input.inputTokens,
        output: 0,
        cached: input.cachedInputTokens,
        cacheCreation: 0
      },
      estimatedCachedInputSavings: input.savings,
      maxHistoryChars: input.maxHistoryChars,
      returnedToolOutputBytes: input.returnedToolOutputBytes,
      toolOutputBytes: input.nestedReturnedToolOutputBytes === undefined
        ? undefined
        : {
            returnedToModel: input.nestedReturnedToolOutputBytes
          }
    },
    budgetSeconds: 30
  });
}

describe("GET /api/metrics/:projectId/token-kpis", () => {
  test("returns planner KPI summary scoped to project", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
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

describe("GET /api/metrics/:projectId/runtime-cache-kpis", () => {
  test("returns runtime cache KPI summary scoped to project", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
    try {
      appendRuntimeTelemetryEvent({
        db,
        projectId: "p1",
        taskId: "t1",
        stablePrefixHash: "prefix-a",
        inputTokens: 100,
        cachedInputTokens: 80,
        savings: 0.001,
        maxHistoryChars: 200,
        returnedToolOutputBytes: 10,
        nestedReturnedToolOutputBytes: 15
      });
      appendRuntimeTelemetryEvent({
        db,
        projectId: "p1",
        taskId: "t2",
        stablePrefixHash: "prefix-a",
        inputTokens: 100,
        cachedInputTokens: 20,
        savings: 0.002,
        maxHistoryChars: 300,
        returnedToolOutputBytes: 30
      });
      appendRuntimeTelemetryEvent({
        db,
        projectId: "p2",
        taskId: "t3",
        stablePrefixHash: "prefix-a",
        inputTokens: 100,
        cachedInputTokens: 100,
        savings: 1,
        maxHistoryChars: 999,
        returnedToolOutputBytes: 999
      });

      const response = await app.request("/api/metrics/p1/runtime-cache-kpis?windowDays=30");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.projectId).toBe("p1");
      expect(body.rows).toHaveLength(2);
      expect(body.summary.repeatedStablePrefixCount).toBe(1);
      expect(body.summary.cachedInputTokenRatio).toBe(0.5);
      expect(body.summary.estimatedCachedInputSavings).toBeCloseTo(0.003);
      expect(body.summary.maxHistoryChars).toBe(300);
      expect(body.summary.toolOutputContributionBytes).toBe(45);
      expect(body.stablePrefixes).toEqual([{
        stablePrefixHash: "prefix-a",
        occurrences: 2,
        cachedInputTokens: 100,
        inputTokens: 200,
        cachedInputTokenRatio: 0.5,
        estimatedCachedInputSavings: 0.003,
        maxHistoryChars: 300,
        toolOutputContributionBytes: 45
      }]);
    } finally {
      cleanup();
    }
  });
});

describe("GET /api/metrics/:projectId/envelope-reuse", () => {
  test("returns repeated envelope hashes ordered by occurrences", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
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
