import { describe, expect, test } from "bun:test";
import {
  WorkspaceToolRequestSchema,
  WorkspaceToolResponseSchema,
  WorkspaceToolStreamSchema,
  workspaceSubject
} from "../../src/nats/messages";
import { WORKSPACE_STREAM } from "../../src/nats/streams";
import {
  WorkspaceCreatedPayloadSchema,
  WorkspaceDestroyedPayloadSchema
} from "../../src/runtime/workspace-events";

describe("workspace NATS subjects and schemas", () => {
  test("builds stable workspace tool subjects", () => {
    expect(workspaceSubject("workspace-1", "request")).toBe("autoforge.workspace.workspace-1.tool.request");
    expect(workspaceSubject("workspace-1", "response", "corr-1")).toBe(
      "autoforge.workspace.workspace-1.tool.response.corr-1"
    );
    expect(workspaceSubject("workspace-1", "stream", "corr-1")).toBe(
      "autoforge.workspace.workspace-1.tool.stream.corr-1"
    );
  });

  test("rejects response and stream subjects without a correlation id", () => {
    expect(() => workspaceSubject("workspace-1", "response")).toThrow("correlation id");
    expect(() => workspaceSubject("workspace-1", "stream")).toThrow("correlation id");
  });

  test("validates workspace tool traffic payloads", () => {
    expect(WorkspaceToolRequestSchema.parse({
      correlationId: "corr-1",
      workspaceId: "workspace-1",
      toolName: "read_file",
      input: { path: "README.md" }
    }).toolName).toBe("read_file");

    expect(WorkspaceToolResponseSchema.parse({
      correlationId: "corr-1",
      workspaceId: "workspace-1",
      ok: true,
      result: { content: "hello" }
    }).ok).toBe(true);

    expect(WorkspaceToolStreamSchema.parse({
      correlationId: "corr-1",
      workspaceId: "workspace-1",
      stream: "stdout",
      chunk: "hello"
    }).stream).toBe("stdout");
  });

  test("validates workspace lifecycle event payloads", () => {
    expect(WorkspaceCreatedPayloadSchema.parse({
      workspace_id: "task-1:planner",
      provider: "local",
      task_id: "task-1",
      dispatch_id: "planner"
    }).provider).toBe("local");

    expect(WorkspaceDestroyedPayloadSchema.parse({
      workspace_id: "task-1:planner",
      provider: "local",
      task_id: "task-1",
      dispatch_id: "planner",
      reason: "terminal_task"
    }).reason).toBe("terminal_task");
  });

  test("defines a short-retention workspace stream", () => {
    expect(WORKSPACE_STREAM.name).toBe("WORKSPACE");
    expect(WORKSPACE_STREAM.subjects).toEqual(["autoforge.workspace.>"]);
  });
});
