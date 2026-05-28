import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExecutor, MAX_TOOL_RESULT_CHARS, serializeToolResult } from "../../src/runtime/harness-executor";
import { SkillRegistry } from "../../src/skills/registry";
import { ToolRegistry } from "../../src/runtime/tool-registry";
import type { ModelMessage, ModelProvider, ModelResponse } from "../../src/runtime/model-provider";
import { MockWorkspace } from "../../src/runtime/mock-workspace";
import type { Workspace } from "../../src/runtime/workspace";
import type { ToolExecutionContext } from "../../src/runtime/tool-registry";
import { createRuntimeToolRegistry } from "../../src/runtime/tools";

class ScriptedProvider implements ModelProvider {
  readonly name: string = "scripted";
  readonly supportedModels = ["test-model"];
  readonly calls: Array<{ history: ModelMessage[]; tools: string[]; timeoutSeconds?: number }> = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async message(args: Parameters<ModelProvider["message"]>[0]): Promise<ModelResponse> {
    this.calls.push({
      history: args.history,
      tools: args.tools.map((tool) => tool.name),
      timeoutSeconds: args.timeoutSeconds
    });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No scripted response");
    }
    return response;
  }
}

describe("HarnessExecutor", () => {
  test("runs provider tool calls through the registry and workspace", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "write_status", input: { status: "DONE" } }],
        usage: { input: 3, output: 5 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 7, output: 11 }
      }
    ]);
    const tools = new ToolRegistry().register({
      name: "write_status",
      description: "Write the Autoforge status file.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"]
      },
      execute: async (input, toolWorkspace: Workspace) => {
        await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({
          status: input.status,
          artifacts: ["artifact.txt"]
        }));
        return { ok: true };
      }
    });
    const executor = new HarnessExecutor({ provider, tools, defaultModel: "test-model" });

    const result = await executor.execute({
      id: "task-1",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(result.artifacts).toEqual(["artifact.txt"]);
    expect(result.metrics.tokenInput).toBe(10);
    expect(result.metrics.tokenOutput).toBe(16);
    expect(result.metrics.toolStats).toMatchObject({ iterations: 2, writeCount: 1 });
    expect(provider.calls[0].tools).toEqual(["write_status"]);
    expect(provider.calls[1].history.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "{\"ok\":true}" }]
    });
  });

  test("uses cached token pricing when provider reports cached input tokens", async () => {
    class AnthropicScriptedProvider extends ScriptedProvider {
      readonly name = "anthropic";
    }

    const workspace = new MockWorkspace({
      id: "workspace-cached-telemetry",
      files: { ".autoforge-status.json": JSON.stringify({ status: "DONE", artifacts: [] }) }
    });
    const provider = new AnthropicScriptedProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1000, output: 100, cached: 750 }
      }
    ] as any);

    const result = await new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "claude-3-5-sonnet-20241022"
    }).execute({
      id: "task-cached-telemetry",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.metrics.telemetry?.totalTokens.cached).toBe(750);
    expect(result.metrics.telemetry?.events.models[0].estimatedCost).toBeCloseTo(0.002475);
  });

  test("returns DONE_WITH_CONCERNS when the model ends without a status file", async () => {
    const provider = new ScriptedProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done without status" }],
        usage: { input: 2, output: 4 }
      }
    ]);
    const executor = new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model"
    });

    const result = await executor.execute({
      id: "task-2",
      type: "planner",
      systemPrompt: "system",
      prompt: "plan",
      workspace: new MockWorkspace({ id: "workspace-2" }),
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.concerns).toBe("Agent did not write .autoforge-status.json");
    expect(result.transcript?.turns[0]).toEqual({
      kind: "assistant",
      content: [{ type: "text", text: "done without status" }]
    });
  });

  test("classifies provider aborts and timeouts as TIMEOUT", async () => {
    const provider: ModelProvider = {
      name: "timeout-provider",
      supportedModels: ["test-model"],
      async message() {
        const error = new Error("aborted by timeout");
        error.name = "AbortError";
        throw error;
      }
    };
    const executor = new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model"
    });

    const result = await executor.execute({
      id: "task-timeout",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace: new MockWorkspace({ id: "timeout-workspace" }),
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("TIMEOUT");
    expect(result.diagnostics?.failureSubtype).toBe("model_call_timeout");
    expect(result.metrics.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(result.metrics.elapsedSeconds).toBeLessThan(5);
    expect(result.metrics.telemetry).toBeDefined();
    expect(result.metrics.telemetry?.events.models[0].failureSubtype).toBe("model_call_timeout");
  });

  test("caps model calls with configured per-call timeout", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-model-timeout-cap",
      files: { ".autoforge-status.json": JSON.stringify({ status: "DONE", artifacts: [] }) }
    });
    const provider = new ScriptedProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    await new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model",
      runtime: { modelCallTimeoutSeconds: 7 }
    }).execute({
      id: "task-model-timeout-cap",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(provider.calls[0].timeoutSeconds).toBe(7);
  });

  test("treats pause_turn as a terminal model stop", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "pause-provider",
      supportedModels: ["test-model"],
      async message() {
        calls++;
        return {
          stopReason: "pause_turn",
          content: [{ type: "text", text: "paused" }],
          usage: { input: 1, output: 1 }
        };
      }
    };
    const executor = new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model"
    });

    const result = await executor.execute({
      id: "task-pause",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace: new MockWorkspace({
        id: "pause-workspace",
        files: { ".autoforge-status.json": JSON.stringify({ status: "DONE", artifacts: [] }) }
      }),
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(calls).toBe(1);
  });

  test("passes task environment and remaining deadline to tools", async () => {
    let context: ToolExecutionContext | undefined;
    const workspace = new MockWorkspace({ id: "workspace-context" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "tool-env", name: "inspect_context", input: {} }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);
    const tools = new ToolRegistry().register({
      name: "inspect_context",
      description: "Inspect tool context.",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, toolWorkspace, toolContext) => {
        context = toolContext;
        await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({ status: "DONE", artifacts: [] }));
        return undefined;
      }
    });

    const result = await new HarnessExecutor({ provider, tools, defaultModel: "test-model" }).execute({
      id: "task-context",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: { CUSTOM_ENV: "present" },
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(context?.environment.CUSTOM_ENV).toBe("present");
    expect(context?.deadlineMs).toBeGreaterThan(Date.now());
  });

  test("serializes undefined and non-json tool results safely", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "tool-undefined", name: "returns_undefined", input: {} },
          { type: "tool_use", id: "tool-error", name: "returns_error", input: {} },
          { type: "tool_use", id: "tool-circular", name: "returns_circular", input: {} },
          { type: "tool_use", id: "tool-function", name: "returns_function", input: {} }
        ],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);
    const workspace = new MockWorkspace({ id: "workspace-serialization" });
    const tools = new ToolRegistry()
      .register({
        name: "returns_undefined",
        description: "Return undefined.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => undefined
      })
      .register({
        name: "returns_error",
        description: "Return error.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => new Error("bad result")
      })
      .register({
        name: "returns_circular",
        description: "Return circular.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_input, toolWorkspace) => {
          await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({ status: "DONE", artifacts: [] }));
          return circular;
        }
      })
      .register({
        name: "returns_function",
        description: "Return function.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => () => "not json"
      });

    await new HarnessExecutor({ provider, tools, defaultModel: "test-model" }).execute({
      id: "task-serialization",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(provider.calls[1].history.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-undefined", content: "(empty result)" },
        { type: "tool_result", tool_use_id: "tool-error", content: "Error: bad result" },
        {
          type: "tool_result",
          tool_use_id: "tool-circular",
          content: "[unserializable tool result]"
        },
        {
          type: "tool_result",
          tool_use_id: "tool-function",
          content: "[unserializable tool result]"
        }
      ]
    });
  });

  test("provider history snapshots do not allow nested mutation of transcript state", async () => {
    const workspace = new MockWorkspace({ id: "workspace-mutation" });
    const provider: ModelProvider = {
      name: "mutating-provider",
      supportedModels: ["test-model"],
      async message(args) {
        const priorAssistant = args.history.find((message) => message.role === "assistant");
        const firstBlock = priorAssistant?.content[0] as { input?: { status?: string } } | undefined;
        if (firstBlock?.input) {
          firstBlock.input.status = "MUTATED";
          return {
            stopReason: "end_turn",
            content: [{ type: "text", text: "done" }],
            usage: { input: 1, output: 1 }
          };
        }
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "tool-mutate", name: "write_status", input: { status: "DONE" } }],
          usage: { input: 1, output: 1 }
        };
      }
    };
    const tools = new ToolRegistry().register({
      name: "write_status",
      description: "Write status.",
      inputSchema: { type: "object", properties: {} },
      execute: async (input, toolWorkspace) => {
        await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({ status: input.status, artifacts: [] }));
        return { ok: true };
      }
    });

    const result = await new HarnessExecutor({ provider, tools, defaultModel: "test-model" }).execute({
      id: "task-mutation",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    const assistantTurn = result.transcript?.turns[0];
    expect(assistantTurn?.kind).toBe("assistant");
    if (assistantTurn?.kind === "assistant") {
      expect((assistantTurn.content[0] as { input: { status: string } }).input.status).toBe("DONE");
    }
  });

  test("records skills loaded through the runtime skill tool", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "harness-skills-"));
    writeFileSync(join(skillsDir, "tdd.md"), "# TDD\nWrite tests first.");
    const workspace = new MockWorkspace({ id: "workspace-skill" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "load-1", name: "load_skill", input: { name: "tdd" } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry({ skillRegistry: new SkillRegistry(skillsDir) }),
      defaultModel: "test-model"
    }).execute({
      id: "task-skill",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(result.transcript?.loadedSkills).toEqual(["tdd"]);
    expect(result.transcript?.turns).toContainEqual({ kind: "loaded_skills", skills: ["tdd"] });
  });

  test("returns recoverable tool errors as tool_result content", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "harness-missing-skill-"));
    const workspace = new MockWorkspace({ id: "workspace-missing-skill" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "load-missing", name: "load_skill", input: { name: "missing" } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-after-error", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry({ skillRegistry: new SkillRegistry(skillsDir) }),
      defaultModel: "test-model"
    }).execute({
      id: "task-missing-skill",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(provider.calls[1].history.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "load-missing", content: "Error: Skill not found: missing" }]
    });
  });

  test("returns unknown tool names as recoverable tool_result errors", async () => {
    const workspace = new MockWorkspace({ id: "workspace-unknown-tool" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "missing-tool", name: "missing_tool", input: {} }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-after-unknown", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-unknown-tool",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(provider.calls[1].history.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "missing-tool", content: "Error: Unknown tool: missing_tool" }]
    });
  });

  test("records raw and bounded byte counts from serialized tool output", async () => {
    const largePayload = { text: "x".repeat(MAX_TOOL_RESULT_CHARS + 1000) };
    const workspace = new MockWorkspace({ id: "workspace-tool-bytes" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "large-tool", name: "large_result", input: {} }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-tool", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);
    const tools = createRuntimeToolRegistry().register({
      name: "large_result",
      description: "Return a large JSON payload.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => largePayload
    });

    const result = await new HarnessExecutor({ provider, tools, defaultModel: "test-model" }).execute({
      id: "task-tool-bytes",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    const event = result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "large_result");
    expect(event?.rawOutputBytes).toBe(Buffer.byteLength(JSON.stringify(largePayload), "utf8"));
    expect(event?.truncatedOutputBytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  test("summarizes exec output and stores the raw output as an ignored artifact", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-exec-summary",
      commands: [
        {
          cmd: "bun",
          args: ["test"],
          events: [
            { kind: "stdout", chunk: `tests/unit/foo.test.ts:\n${"x".repeat(10_000)}\n` },
            { kind: "stderr", chunk: "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" },
            { kind: "exit", exitCode: 1 }
          ]
        }
      ]
    });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "exec-1", name: "exec", input: { cmd: "bun", args: ["test"] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-exec-summary",
      type: "coder",
      systemPrompt: "system",
      prompt: "run tests",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    const toolResult = provider.calls[1].history.at(-1)?.content[0] as unknown as { content: string };
    const payload = JSON.parse(toolResult.content);
    expect(payload.outputMode).toBe("summary");
    expect(payload.parser).toBe("typescript");
    expect(payload.keyFindings).toContain("src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(payload.artifactReference).toMatch(/^\.autoforge\/tool-results\/exec-1-/);
    expect(await workspace.readFile(".autoforge/.gitignore")).toBe("*\n");
    const artifact = JSON.parse(await workspace.readFile(payload.artifactReference));
    expect(artifact.stderr).toContain("TS2322");

    const event = result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "exec");
    expect(event?.artifactReference).toBe(payload.artifactReference);
    expect(event?.outputMode).toBe("summary");
    expect(event?.rawOutputBytes).toBeGreaterThan(event?.returnedToModelBytes ?? 0);
    expect(event?.returnedToModelBytes).toBe(Buffer.byteLength(toolResult.content, "utf8"));
  });

  test("returns full exec output only when a reason is supplied", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-exec-full",
      commands: [
        {
          cmd: "node",
          args: ["script.js"],
          events: [
            { kind: "stdout", chunk: "full stdout\n" },
            { kind: "stderr", chunk: "full stderr\n" },
            { kind: "exit", exitCode: 0 }
          ]
        }
      ]
    });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "exec-full",
          name: "exec",
          input: { cmd: "node", args: ["script.js"], outputMode: "full", reason: "Need exact output" }
        }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-exec-full",
      type: "coder",
      systemPrompt: "system",
      prompt: "run script",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    const toolResult = provider.calls[1].history.at(-1)?.content[0] as unknown as { content: string };
    const payload = JSON.parse(toolResult.content);
    expect(payload.outputMode).toBe("full");
    expect(payload.stdout).toBe("full stdout\n");
    expect(payload.stderr).toBe("full stderr\n");
    expect(result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "exec")?.fullOutputReason)
      .toBe("Need exact output");
  });

  test("summarizes large QMD tool results and records QMD allowance telemetry", async () => {
    const workspace = new MockWorkspace({ id: "workspace-qmd-summary" });
    const largeQmdText = `# Domain Agent Execution\n\n${"docs/qmd/domain-agent-execution.md\n".repeat(400)}`;
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "qmd-1", name: "get", input: { path: "docs/qmd/domain-agent-execution.md" } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model",
      runtime: { qmdTotalAllowanceSeconds: 90, qmdCallTimeoutSeconds: 20, finalReserveSeconds: 5 },
      mcpClientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: "get",
              description: "Get QMD doc",
              inputSchema: { type: "object", properties: { path: { type: "string" } } }
            }]
          };
        },
        async callTool(_request, _schema, options) {
          expect(options?.timeout).toBeLessThanOrEqual(20_000);
          return { content: [{ type: "text", text: largeQmdText }] };
        },
        async close() {}
      })
    }).execute({
      id: "task-qmd-summary",
      type: "planner",
      systemPrompt: "system",
      prompt: "## Phase\nspec\n\n## Task\nplan",
      workspace,
      budgetSeconds: 60,
      environment: { QMD_MCP_URL: "http://qmd.test/mcp" },
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    const toolResult = provider.calls[1].history.at(-1)?.content[0] as unknown as { content: string };
    const payload = JSON.parse(toolResult.content);
    expect(payload.toolKind).toBe("qmd");
    expect(payload.outputMode).toBe("summary");
    expect(payload.artifactReference).toMatch(/^\.autoforge\/tool-results\/qmd-1-/);
    expect(payload.relevantPaths).toContain("docs/qmd/domain-agent-execution.md");
    const artifact = JSON.parse(await workspace.readFile(payload.artifactReference));
    expect(artifact.text).toBe(largeQmdText);

    const event = result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "get");
    expect(event?.artifactReference).toBe(payload.artifactReference);
    expect(event?.qmdAllowanceRemainingMs).toBeDefined();
    expect(event?.returnedToModelBytes).toBeLessThan(event?.rawOutputBytes ?? 0);
  });

  test("caps QMD setup with QMD timeout telemetry", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-qmd-setup-timeout",
      files: { ".autoforge-status.json": JSON.stringify({ status: "DONE", artifacts: [] }) }
    });
    const provider = new ScriptedProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model",
      runtime: { qmdTotalAllowanceSeconds: 1, qmdCallTimeoutSeconds: 0.001 },
      mcpClientFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          async listTools() {
            return { tools: [] };
          },
          async callTool() {
            return { content: [] };
          },
          async close() {}
        };
      }
    }).execute({
      id: "task-qmd-setup-timeout",
      type: "planner",
      systemPrompt: "system",
      prompt: "## Phase\nspec\n\n## Task\nplan",
      workspace,
      budgetSeconds: 60,
      environment: { QMD_MCP_URL: "http://qmd.test/mcp" },
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    const setupEvent = result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "qmd_setup");
    expect(setupEvent?.status).toBe("error");
    expect(setupEvent?.failureSubtype).toBe("qmd_call_timeout");
    expect(setupEvent?.qmdAllowanceRemainingMs).toBeDefined();
  });

  test("closes QMD client on terminal model return", async () => {
    let closed = 0;
    const workspace = new MockWorkspace({
      id: "workspace-qmd-close",
      files: { ".autoforge-status.json": JSON.stringify({ status: "DONE", artifacts: [] }) }
    });
    const provider = new ScriptedProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model",
      mcpClientFactory: async () => ({
        listTools: async () => ({ tools: [{ name: "get", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closed += 1;
        }
      })
    }).execute({
      id: "task-qmd-close",
      type: "planner",
      systemPrompt: "system",
      prompt: "plan",
      workspace,
      budgetSeconds: 60,
      environment: { QMD_MCP_URL: "http://qmd.test/mcp" },
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(closed).toBe(1);
  });

  test("summarizes large QMD error results as retrievable artifacts", async () => {
    const workspace = new MockWorkspace({ id: "workspace-qmd-error-summary" });
    const largeErrorText = `QMD error\n${"docs/qmd/domain-task-orchestration.md failed\n".repeat(400)}`;
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "qmd-error", name: "get", input: { path: "missing-doc" } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model",
      runtime: { qmdTotalAllowanceSeconds: 90, qmdCallTimeoutSeconds: 20, finalReserveSeconds: 5 },
      mcpClientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: "get",
              description: "Get QMD doc",
              inputSchema: { type: "object", properties: { path: { type: "string" } } }
            }]
          };
        },
        async callTool() {
          return { isError: true, content: [{ type: "text", text: largeErrorText }] };
        },
        async close() {}
      })
    }).execute({
      id: "task-qmd-error-summary",
      type: "planner",
      systemPrompt: "system",
      prompt: "## Phase\nspec\n\n## Task\nplan",
      workspace,
      budgetSeconds: 60,
      environment: { QMD_MCP_URL: "http://qmd.test/mcp" },
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    const toolResult = provider.calls[1].history.at(-1)?.content[0] as unknown as { content: string };
    const payload = JSON.parse(toolResult.content);
    expect(payload.status).toBe("error");
    expect(payload.artifactReference).toMatch(/^\.autoforge\/tool-results\/qmd-error-/);
    const event = result.metrics.telemetry?.events.tools.find((tool) => tool.toolName === "get");
    expect(event?.status).toBe("error");
    expect(event?.artifactReference).toBe(payload.artifactReference);
    expect(event?.returnedToModelBytes).toBeLessThan(event?.rawOutputBytes ?? 0);
  });

  test("records recoverable unknown tool errors as tool telemetry errors", async () => {
    const workspace = new MockWorkspace({ id: "workspace-unknown-tool-telemetry" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "missing-tool", name: "missing_tool", input: {} }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-after-error", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-unknown-tool-telemetry",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.metrics.telemetry?.events.tools).toContainEqual(expect.objectContaining({
      toolName: "missing_tool",
      status: "error",
      rawOutputBytes: Buffer.byteLength("Error: Unknown tool: missing_tool", "utf8"),
      truncatedOutputBytes: Buffer.byteLength("Error: Unknown tool: missing_tool", "utf8")
    }));
  });

  test("does not start tool execution after the task deadline expires", async () => {
    let toolRan = false;
    const provider: ModelProvider = {
      name: "slow-provider",
      supportedModels: ["test-model"],
      async message() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "late-tool", name: "late_tool", input: {} }],
          usage: { input: 1, output: 1 }
        };
      }
    };
    const tools = new ToolRegistry().register({
      name: "late_tool",
      description: "Should not run after deadline.",
      inputSchema: { type: "object", properties: {} },
      statsBucket: "read",
      execute: async () => {
        toolRan = true;
        return { ok: true };
      }
    });

    const result = await new HarnessExecutor({ provider, tools, defaultModel: "test-model" }).execute({
      id: "task-late-tool",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace: new MockWorkspace({ id: "workspace-late-tool" }),
      budgetSeconds: 0.001,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("TIMEOUT");
    expect(toolRan).toBe(false);
    expect(result.metrics.toolStats?.readCount).toBe(0);
  });

  test("includes telemetry when maximum harness iterations are exceeded", async () => {
    const provider: ModelProvider = {
      name: "loop-provider",
      supportedModels: ["test-model"],
      async message() {
        return {
          stopReason: "tool_use",
          content: [],
          usage: { input: 1, output: 1 }
        };
      }
    };

    const result = await new HarnessExecutor({
      provider,
      tools: new ToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-max-iterations",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace: new MockWorkspace({ id: "workspace-max-iterations" }),
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("FAILED");
    expect(result.blockReason).toContain("Exceeded maximum harness iterations");
    expect(result.metrics.telemetry?.events.models.length).toBe(50);
  });

  test("generates and persists telemetry data to workspace and metrics", async () => {
    const workspace = new MockWorkspace({ id: "workspace-telemetry" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "tool-telemetry", name: "write_status", input: { status: "DONE" } }],
        usage: { input: 10, output: 20 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 30, output: 40 }
      }
    ]);

    const tools = new ToolRegistry().register({
      name: "write_status",
      description: "Write the Autoforge status file.",
      inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
      execute: async (input, toolWorkspace: Workspace) => {
        await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({ status: input.status, artifacts: [] }));
        return { ok: true };
      }
    });

    const executor = new HarnessExecutor({ provider, tools, defaultModel: "claude-3-5-sonnet-20241022" });

    const result = await executor.execute({
      id: "task-telemetry",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    
    // Telemetry metric check
    expect(result.metrics.telemetry).toBeDefined();
    expect(result.metrics.telemetry?.totalTokens.input).toBe(40); // 10 + 30
    expect(result.metrics.telemetry?.totalTokens.output).toBe(60); // 20 + 40
    expect(result.metrics.telemetry?.events.models.length).toBe(2);
    expect(result.metrics.telemetry?.events.tools.length).toBe(1);

    // Workspace file check
    const telemetryFileContent = await workspace.readFile(".autoforge/telemetry.json").catch(() => null);
    expect(telemetryFileContent).not.toBeNull();
    const parsed = JSON.parse(telemetryFileContent!);
    expect(parsed.totalTokens.input).toBe(40);
  });
});

describe("serializeToolResult bounds", () => {
  test.each([
    { kind: "string", value: "hello", expected: "hello" },
    { kind: "json", value: { ok: true }, expected: '{"ok":true}' },
    { kind: "error", value: new Error("boom"), expected: "Error: boom" }
  ] as const)("below cap leaves $kind results unchanged", ({ value, expected }) => {
    expect(serializeToolResult(value)).toBe(expected);
  });

  test.each([
    { kind: "string", make: () => "y".repeat(MAX_TOOL_RESULT_CHARS + 500) },
    {
      kind: "json",
      make: () => ({ pad: "z".repeat(MAX_TOOL_RESULT_CHARS + 500) })
    },
    {
      kind: "error",
      make: () => new Error("e".repeat(MAX_TOOL_RESULT_CHARS + 500))
    }
  ] as const)("above cap truncates $kind with head, tail, and marker", ({ kind, make }) => {
    const full = serializeToolResult(make());
    expect(full.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(full).toMatch(/<truncated \d+ chars>/);
    if (kind === "string") {
      expect(full.startsWith("y")).toBe(true);
      expect(full.endsWith("y")).toBe(true);
    }
    if (kind === "json") {
      expect(full.startsWith('{"pad":"')).toBe(true);
      expect(full.endsWith("}")).toBe(true);
    }
    if (kind === "error") {
      expect(full.startsWith("Error: ")).toBe(true);
      expect(full.endsWith("e")).toBe(true);
    }
  });

  test("str_replace outside workspace is a recoverable tool_result error", async () => {
    const workspace = new MockWorkspace({ id: "workspace-str-replace-escape" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "sr-1",
          name: "str_replace",
          input: { path: "../outside", old_string: "a", new_string: "b" }
        }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "done-1", name: "done", input: { status: "DONE", artifacts: [] } }],
        usage: { input: 1, output: 1 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 }
      }
    ]);

    const result = await new HarnessExecutor({
      provider,
      tools: createRuntimeToolRegistry(),
      defaultModel: "test-model"
    }).execute({
      id: "task-str-replace-outside",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    expect(provider.calls[1].history.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "sr-1", content: "Error: Path is outside workspace root: ../outside" }]
    });
  });
});
