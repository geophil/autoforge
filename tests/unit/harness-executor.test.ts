import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExecutor } from "../../src/runtime/harness-executor";
import { SkillRegistry } from "../../src/skills/registry";
import { ToolRegistry } from "../../src/runtime/tool-registry";
import type { ModelMessage, ModelProvider, ModelResponse } from "../../src/runtime/model-provider";
import { MockWorkspace } from "../../src/runtime/mock-workspace";
import type { Workspace } from "../../src/runtime/workspace";
import type { ToolExecutionContext } from "../../src/runtime/tool-registry";
import { createRuntimeToolRegistry } from "../../src/runtime/tools";

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
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
    expect(result.metrics.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(result.metrics.elapsedSeconds).toBeLessThan(5);
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
});
