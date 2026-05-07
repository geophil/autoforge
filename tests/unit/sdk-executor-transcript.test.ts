import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  test("treats list_directory recursive=true boolean as recursive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-tr-list-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));
    writeFileSync(join(dir, "root.txt"), "root");
    const nestedDir = join(dir, "nested");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "child.txt"), "child");

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let callCount = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_list", name: "list_directory", input: { path: ".", recursive: true } }
          ]
        };
      }
      return {
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      };
    };

    const result = await exec.execute({
      id: "tx-list", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    const toolResult = result.transcript!.turns.find((t) => t.kind === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "tool_result") {
      expect(toolResult.content).toContain("nested/");
      expect(toolResult.content).toContain("child.txt");
    }
  });
});

// ---------------------------------------------------------------------------
// MCP wiring (client-side)
//
// AnthropicSdkExecutor opens a Streamable HTTP MCP client to QMD_MCP_URL at
// the start of each execute() call, lists its tools, exposes them alongside
// the executor's local tools, and routes tool_use blocks named after an MCP
// tool to the MCP client. These tests stub the MCP client via a private
// `_testMcpClient` hook so they don't need a real server.
// ---------------------------------------------------------------------------

interface FakeMcpCall {
  name: string;
  arguments?: Record<string, unknown>;
}

function buildFakeMcpClient(opts?: {
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  callResponse?: (call: FakeMcpCall) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}) {
  const calls: FakeMcpCall[] = [];
  let closed = false;
  const tools = opts?.tools ?? [
    {
      name: "query",
      description: "Query the QMD knowledge base",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    }
  ];
  const client = {
    async listTools() {
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: "object" }) as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
          }
        }))
      };
    },
    async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
      calls.push({ name: params.name, arguments: params.arguments });
      if (opts?.callResponse) return opts.callResponse(params);
      return { content: [{ type: "text" as const, text: `result for ${params.name}` }] };
    },
    async close() {
      closed = true;
    }
  };
  return { client, calls, isClosed: () => closed };
}

describe("SDK executor prompt caching", () => {
  test("places an ephemeral cache_control breakpoint on the system prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cache-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { system?: unknown } = {};
    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testCreate?: (opts: { system?: unknown }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.system = opts.system;
        return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
      };

    await exec.execute({
      id: "tc", type: "planner", systemPrompt: "persona-text", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(Array.isArray(captured.system)).toBe(true);
    const blocks = captured.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("persona-text");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("SDK executor MCP wiring", () => {
  test("registers MCP tools alongside local tools when QMD_MCP_URL is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-mcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const fake = buildFakeMcpClient({
      tools: [
        { name: "query", description: "QMD search" },
        { name: "get", description: "Fetch a doc" }
      ]
    });
    const captured: { tools?: Array<{ name: string }> } = {};

    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testMcpClient?: unknown })._testMcpClient = fake.client;
    (exec as unknown as { _testCreate?: (opts: { tools?: Array<{ name: string }> }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.tools = opts.tools;
        return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
      };

    await exec.execute({
      id: "tm", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30,
      environment: { QMD_MCP_URL: "http://localhost:8181/mcp" },
      skillFiles: []
    });

    const toolNames = (captured.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("query");
    expect(toolNames).toContain("get");
    expect(fake.isClosed()).toBe(true);
  });

  test("dispatches tool_use to the MCP client when the tool name matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-mcp-disp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const fake = buildFakeMcpClient({
      tools: [{ name: "query", description: "QMD search" }],
      callResponse: async () => ({
        content: [{ type: "text" as const, text: "doc snippet about caching" }]
      })
    });

    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testMcpClient?: unknown })._testMcpClient = fake.client;
    let callCount = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_q", name: "query", input: { q: "caching" } }
          ]
        };
      }
      return {
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      };
    };

    const result = await exec.execute({
      id: "tm-disp", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30,
      environment: { QMD_MCP_URL: "http://localhost:8181/mcp" },
      skillFiles: []
    });

    expect(fake.calls).toEqual([{ name: "query", arguments: { q: "caching" } }]);
    const toolResult = result.transcript!.turns.find((t) => t.kind === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "tool_result") {
      expect(toolResult.content).toBe("doc snippet about caching");
    }
    expect(fake.isClosed()).toBe(true);
  });

  test("skips MCP entirely when QMD_MCP_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-nomcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const fake = buildFakeMcpClient();
    const captured: { tools?: Array<{ name: string }> } = {};

    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testMcpClient?: unknown })._testMcpClient = fake.client;
    (exec as unknown as { _testCreate?: (opts: { tools?: Array<{ name: string }> }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.tools = opts.tools;
        return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
      };

    await exec.execute({
      id: "tm2", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    const toolNames = (captured.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("query");
    expect(fake.calls).toEqual([]);
    expect(fake.isClosed()).toBe(false);
  });
});

describe("SDK executor return-path transcript invariants", () => {
  test("terminal non-tool stop reasons do not spin another model iteration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-refusal-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let calls = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      calls++;
      return {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "refusal",
        content: [{ type: "text", text: "refused" }]
      };
    };

    const result = await exec.execute({
      id: "tr", type: "planner", systemPrompt: "p-refusal", prompt: "u-refusal",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(calls).toBe(1);
  });

  test("provider error stop reason fails without spinning another model iteration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-provider-error-"));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let calls = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      calls++;
      return {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: null,
        content: [{ type: "text", text: "unknown stop" }]
      };
    };

    const result = await exec.execute({
      id: "te", type: "planner", systemPrompt: "p-error", prompt: "u-error",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("FAILED");
    expect(result.blockReason).toContain("error stop reason");
    expect(calls).toBe(1);
  });

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
    expect(result.blockReason).toBe("synthetic upstream failure");
    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("p-fail");
    expect(result.transcript!.userPrompt).toBe("u-fail");
    // The catch-block now pushes an `error` turn so forensics survive even
    // when the API call never returned a response (no assistant/tool turns).
    const errorTurn = result.transcript!.turns.find((t) => t.kind === "error");
    expect(errorTurn).toBeDefined();
    if (errorTurn && errorTurn.kind === "error") {
      expect(errorTurn.message).toBe("synthetic upstream failure");
      expect(errorTurn.name).toBe("Error");
    }
  });

  test("FAILED return path reports completed tool iterations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-fail-iter-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let calls = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "hello.txt" } }]
        };
      }
      throw new Error("synthetic upstream failure");
    };

    const result = await exec.execute({
      id: "tf-iter", type: "planner", systemPrompt: "p-fail", prompt: "u-fail",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.status).toBe("FAILED");
    expect(result.metrics.toolStats?.iterations).toBe(1);
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
  test("records a compaction turn when token threshold triggers memory compaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cmp-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testSummarize?: (input: { model: string; text: string }) => Promise<string> })
      ._testSummarize = async ({ text }) => `summary: ${text.slice(0, 60)}`;
    let callCount = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      callCount++;
      if (callCount <= 4) {
        return {
          usage: { input_tokens: 80_000, output_tokens: 7 },
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
