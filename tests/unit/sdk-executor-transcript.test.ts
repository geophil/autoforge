import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicSdkExecutor } from "../../src/executors/anthropic-sdk";

function buildExecutor(captured: { model?: string }): AnthropicSdkExecutor {
  const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
  (exec as unknown as { _testCreate?: (opts: { model: string }) => Promise<unknown> })
    ._testCreate = async (opts) => {
      captured.model = opts.model;
      return {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        content: []
      };
    };
  return exec;
}

describe("SDK executor model override", () => {
  test("uses task.model when set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-exec-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { model?: string } = {};
    const exec = buildExecutor(captured);

    await exec.execute({
      id: "t1", type: "planner", systemPrompt: "you are x", prompt: "do y",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: [],
      model: "claude-opus-override"
    });

    expect(captured.model).toBe("claude-opus-override");
  });

  test("falls back to constructor default when task.model unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-exec-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { model?: string } = {};
    const exec = buildExecutor(captured);

    await exec.execute({
      id: "t2", type: "planner", systemPrompt: "you are x", prompt: "do y",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(captured.model).toBe("default-sonnet");
  });
});
