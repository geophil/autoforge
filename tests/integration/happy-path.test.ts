import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("happy path pipeline", () => {
  test("submits task and reaches approval, then completes after approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a hello world endpoint");
    expect(task.state).toBe("awaiting_approval");

    const approved = await service.approveTask(task.id);
    expect(approved.state).toBe("completed");
  });
});
