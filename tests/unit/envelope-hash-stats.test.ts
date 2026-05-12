import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestService } from "../helpers/create-service";

describe("DbClient.envelopeHashStats", () => {
  test("returns prior occurrence count and latest token input", () => {
    const { db, cleanup } = createTestService();
    try {
      const hash = "hash-1";
      db.appendEvent({
        id: randomUUID(),
        taskId: "t1",
        projectId: "p1",
        timestamp: new Date().toISOString(),
        agent: "planner",
        type: "planned",
        status: "done",
        payload: {},
        budgetSeconds: 10,
        tokenUsage: { input: 100, output: 10, estimatedCost: 0 }
      }, { contextEnvelopeHash: hash });
      db.appendEvent({
        id: randomUUID(),
        taskId: "t2",
        projectId: "p1",
        timestamp: new Date().toISOString(),
        agent: "planner",
        type: "planned",
        status: "done",
        payload: {},
        budgetSeconds: 10,
        tokenUsage: { input: 140, output: 10, estimatedCost: 0 }
      }, { contextEnvelopeHash: hash });

      const stats = db.envelopeHashStats("p1", hash);
      expect(stats.occurrences).toBe(2);
      expect(stats.lastTokenInput).toBe(140);
    } finally {
      cleanup();
    }
  });
});
