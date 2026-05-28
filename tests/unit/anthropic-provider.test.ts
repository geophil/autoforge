import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../../src/runtime/anthropic-provider";

describe("AnthropicProvider", () => {
  test("translates normalized message requests to Anthropic messages.create params", async () => {
    const captured: { params?: unknown; timeout?: number } = {};
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async (params, options) => {
        captured.params = params;
        captured.timeout = options.timeout;
        return {
          usage: { input_tokens: 3, output_tokens: 5 },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } }]
        };
      }
    });

    const response = await provider.message({
      model: "claude-sonnet-test",
      systemPrompt: "system",
      history: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      ],
      maxTokens: 1234,
      timeoutSeconds: 7
    });

    expect(captured.timeout).toBe(7000);
    expect(captured.params).toEqual({
      model: "claude-sonnet-test",
      max_tokens: 1234,
      system: [{ type: "text", text: "system" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      ]
    });
    expect(response).toEqual({
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } }],
      usage: { input: 3, output: 5, cached: 0, cacheCreation: 0 }
    });
  });

  test("preserves Anthropic stop reasons used by the harness", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async () => ({
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "refusal",
        content: [{ type: "text", text: "I cannot help with that." }]
      })
    });

    const response = await provider.message({
      model: "claude-sonnet-test",
      systemPrompt: "system",
      history: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: []
    });

    expect(response.stopReason).toBe("refusal");
  });

  test("does not cache volatile user text blocks", async () => {
    const captured: { params?: any } = {};
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async (params) => {
        captured.params = params;
        return {
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
      }
    });

    await provider.message({
      model: "claude-sonnet-test",
      systemPrompt: "system",
      history: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ack" }] },
        { role: "user", content: [{ type: "text", text: "second" }] }
      ],
      tools: []
    });

    expect(captured.params.messages[0].content[0].cache_control).toBeUndefined();
    expect(captured.params.messages[2].content[0].cache_control).toBeUndefined();
  });

  test("applies cache controls only to structured stable system blocks", async () => {
    const captured: { params?: any } = {};
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async (params) => {
        captured.params = params;
        return {
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
      }
    });

    await provider.message({
      model: "claude-sonnet-test",
      system: [
        { type: "text", text: "stable", cache: true, stable: true },
        { type: "text", text: "dynamic", cache: false, stable: false }
      ],
      history: [{ role: "user", content: [{ type: "text", text: "task" }] }],
      tools: []
    });

    expect(captured.params.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "dynamic" }
    ]);
    expect(captured.params.messages[0].content[0].cache_control).toBeUndefined();
  });

  test("ignores cache hints on dynamic and unstructured system blocks", async () => {
    const captured: { params?: any } = {};
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async (params) => {
        captured.params = params;
        return {
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
      }
    });

    await provider.message({
      model: "claude-sonnet-test",
      system: [
        { type: "text", text: "stable", cache: true, stable: true },
        { type: "text", text: "runtime budget", cache: true, stable: false, name: "runtime_budget" },
        { type: "text", text: "legacy hint", cache: true }
      ],
      history: [{ role: "user", content: [{ type: "text", text: "task" }] }],
      tools: []
    });

    expect(captured.params.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "runtime budget" },
      { type: "text", text: "legacy hint" }
    ]);

    await provider.message({
      model: "claude-sonnet-test",
      systemPrompt: "unstructured fallback",
      history: [{ role: "user", content: [{ type: "text", text: "task" }] }],
      tools: []
    });

    expect(captured.params.system).toEqual([{ type: "text", text: "unstructured fallback" }]);
  });

  test("maps Anthropic cache usage into provider usage", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      createMessage: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20
        }
      } as any)
    });

    const response = await provider.message({
      model: "claude-3-5-sonnet-20241022",
      systemPrompt: "system",
      history: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: []
    });

    expect(response.usage).toEqual({
      input: 100,
      output: 25,
      cached: 80,
      cacheCreation: 20
    });
  });
});
