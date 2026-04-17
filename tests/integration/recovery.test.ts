import { describe, expect, test } from "bun:test";
import { DbClient } from "../../src/db/client";
import { RecoveryService } from "../../src/orchestrator/recovery";
import { resolve } from "node:path";
import { createTestService } from "../helpers/create-service";

describe("event-sourced recovery", () => {
  test("rebuilds task projections from append-only events", async () => {
    const { service, dbPath } = createTestService();
    const created = await service.submitTask("autoforge", "Create a status endpoint", { reviewPlan: false });
    expect(created.state).toBe("awaiting_approval");

    const restartedDb = new DbClient(dbPath);
    restartedDb.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
    const recovery = new RecoveryService(restartedDb);
    recovery.recover();

    const recoveredTask = restartedDb.getTask(created.id);
    expect(recoveredTask).not.toBeNull();
    expect(recoveredTask?.state).toBe("awaiting_approval");
  });
});
