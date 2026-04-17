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

describe("SDK executor transcript capture", () => {
  test("returns transcript with system + user prompts and one assistant turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-tr-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => ({
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello back" }]
    });

    const result = await exec.execute({
      id: "tx", type: "planner", systemPrompt: "persona", prompt: "do thing",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("persona");
    expect(result.transcript!.userPrompt).toBe("do thing");
    expect(result.transcript!.turns.length).toBeGreaterThanOrEqual(1);
    expect(result.transcript!.turns[0].kind).toBe("assistant");
  });

  test("captures tool_result turns when model uses a tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-tr-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let callCount = 0;
    (exec as unknown as { _testCreate?: (opts: { messages: unknown[] }) => Promise<unknown> })
      ._testCreate = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            usage: { input_tokens: 5, output_tokens: 7 },
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "hello.txt" } }
            ]
          };
        }
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "got it" }]
        };
      };

    const result = await exec.execute({
      id: "tx2", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    const kinds = result.transcript!.turns.map((t) => t.kind);
    expect(kinds).toContain("tool_result");
    const toolResult = result.transcript!.turns.find((t) => t.kind === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "tool_result") {
      expect(toolResult.content).toBe("world");
    }
  });
});

describe("SDK executor MCP wiring", () => {
  test("includes mcp_servers when QMD_MCP_URL is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-mcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { mcp_servers?: unknown } = {};
    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testCreate?: (opts: { mcp_servers?: unknown }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.mcp_servers = opts.mcp_servers;
        return {
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          content: []
        };
      };

    await exec.execute({
      id: "tm", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30,
      environment: { QMD_MCP_URL: "http://localhost:8181/mcp" },
      skillFiles: []
    });

    expect(captured.mcp_servers).toEqual([
      { type: "url", url: "http://localhost:8181/mcp", name: "qmd" }
    ]);
  });

  test("omits mcp_servers when QMD_MCP_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-nomcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { mcp_servers?: unknown } = {};
    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testCreate?: (opts: { mcp_servers?: unknown }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.mcp_servers = opts.mcp_servers;
        return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
      };

    await exec.execute({
      id: "tm2", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(captured.mcp_servers).toBeUndefined();
  });
});

describe("SDK executor return-path transcript invariants", () => {
  test("FAILED return path includes transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-fail-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      throw new Error("synthetic upstream failure");
    };

    const result = await exec.execute({
      id: "tf", type: "planner", systemPrompt: "p-fail", prompt: "u-fail",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("FAILED");
    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("p-fail");
    expect(result.transcript!.userPrompt).toBe("u-fail");
  });

  test("TIMEOUT return path includes transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-to-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const result = await exec.execute({
      id: "tt", type: "planner", systemPrompt: "p-to", prompt: "u-to",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("TIMEOUT");
    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("p-to");
    expect(result.transcript!.userPrompt).toBe("u-to");
  });

  test("DONE_WITH_CONCERNS (no status file) return path includes transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-dwc-"));
    // intentionally do NOT write .autoforge-status.json

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => ({
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    });

    const result = await exec.execute({
      id: "tdwc", type: "planner", systemPrompt: "p-dwc", prompt: "u-dwc",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("p-dwc");
    expect(result.transcript!.userPrompt).toBe("u-dwc");
  });
});

describe("SDK executor compaction marker", () => {
  test("records a compaction turn when iteration 20 triggers splice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cmp-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let callCount = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      callCount++;
      if (callCount <= 21) {
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: `tu_${callCount}`, name: "read_file", input: { path: "hello.txt" } }
          ]
        };
      }
      return {
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "end_turn",
        content: []
      };
    };

    const result = await exec.execute({
      id: "tcmp", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 60, environment: {}, skillFiles: []
    });

    expect(result.transcript).toBeDefined();
    const compaction = result.transcript!.turns.find((t) => t.kind === "compaction");
    expect(compaction).toBeDefined();
    if (compaction && compaction.kind === "compaction") {
      expect(compaction.droppedTurns).toBeGreaterThan(0);
    }
  });
});
