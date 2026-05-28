import { describe, expect, test } from "bun:test";
import { RuntimeControls } from "../../src/runtime/runtime-controls";
import { McpToolAdapter, type McpClient } from "../../src/runtime/mcp-tool-adapter";
import { guardrailToolResult, type ToolExecutionOutcome } from "../../src/runtime/tool-execution-outcome";
import type { AgentTask } from "../../src/executors/interface";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-runtime-controls",
    type: "planner",
    systemPrompt: "system",
    prompt: "## Phase\nspec\n\nDo work",
    workspace: {
      id: "workspace-runtime-controls",
      provider: "mock",
      readFile: async () => "",
      writeFile: async () => {},
      exec: async function* () {},
      destroy: async () => {}
    },
    budgetSeconds: 120,
    environment: {},
    skillFiles: [],
    metadata: { phase: "spec" },
    ...overrides
  };
}

describe("runtime components", () => {
  test("RuntimeControls composes budget, guardrails, and shaper", () => {
    const controls = new RuntimeControls(task(), {
      plannerSpecMaxQmdCalls: 0,
      plannerSpecMaxToolCalls: 0,
      qmdTotalAllowanceSeconds: 1,
      qmdCallTimeoutSeconds: 1
    });

    expect(controls.budget.timeoutForQmdCall().timeoutSeconds).toBeLessThanOrEqual(1);
    expect(controls.guardrails.beforeTool({ toolName: "query", isQmd: true, budget: controls.budget })?.failureSubtype)
      .toBe("planner_qmd_call_cap_exceeded");
    expect(controls.shaper).toBeDefined();
  });

  test("McpToolAdapter setup and calls normalize success", async () => {
    const client: McpClient = {
      listTools: async () => ({ tools: [{ name: "query", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "text", text: "answer" }] }),
      close: async () => {}
    };
    const adapter = new McpToolAdapter(async () => client);

    const setup = await adapter.setup("http://qmd.test", {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });
    const call = await adapter.callTool("query", {}, {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    expect(setup.status).toBe("success");
    expect(setup.toolDefinitions.map((tool) => tool.name)).toEqual(["query"]);
    expect(adapter.hasTool("query")).toBe(true);
    expect(call).toMatchObject({ status: "success", text: "answer" });
  });

  test("McpToolAdapter extracts text and resource content and preserves MCP error status", async () => {
    const adapter = new McpToolAdapter(async () => ({
      listTools: async () => ({ tools: [{ name: "get", inputSchema: { type: "object" } }] }),
      callTool: async () => ({
        isError: true,
        content: [
          { type: "text", text: "first" },
          { type: "resource", resource: { text: "second" } },
          { type: "json", value: 3 }
        ]
      }),
      close: async () => {}
    }));
    await adapter.setup("http://qmd.test", {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    const call = await adapter.callTool("get", {}, {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    expect(call.status).toBe("error");
    expect(call.text).toContain("first\nsecond\n");
    expect(call.text).toContain("\"type\":\"json\"");
  });

  test("McpToolAdapter closes a partially opened client when setup fails", async () => {
    let closed = 0;
    const adapter = new McpToolAdapter(async () => ({
      listTools: async () => {
        throw new Error("list failed");
      },
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed += 1;
      }
    }));

    const setup = await adapter.setup("http://qmd.test", {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    expect(setup).toMatchObject({ status: "error", message: "list failed" });
    expect(adapter.hasTool("query")).toBe(false);
    expect(closed).toBe(1);
  });

  test("McpToolAdapter closes a partially opened client when setup times out", async () => {
    let closed = 0;
    const adapter = new McpToolAdapter(async () => ({
      listTools: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { tools: [] };
      },
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed += 1;
      }
    }));

    const setup = await adapter.setup("http://qmd.test", {
      timeoutMs: 1,
      timeoutSeconds: 0.001,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    expect(setup).toMatchObject({ status: "error", failureSubtype: "qmd_call_timeout" });
    expect(adapter.hasTool("query")).toBe(false);
    expect(closed).toBe(1);
  });

  test("McpToolAdapter closes a client opened after setup timeout", async () => {
    let closed = 0;
    const adapter = new McpToolAdapter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closed += 1;
        }
      };
    });

    const setup = await adapter.setup("http://qmd.test", {
      timeoutMs: 1,
      timeoutSeconds: 0.001,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(setup).toMatchObject({ status: "error", failureSubtype: "qmd_call_timeout" });
    expect(adapter.hasTool("query")).toBe(false);
    expect(closed).toBe(1);
  });

  test("McpToolAdapter reports setup and call timeout outcomes", async () => {
    const adapter = new McpToolAdapter(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {}
    }));

    const setup = await adapter.setup("http://qmd.test", {
      timeoutMs: 0,
      timeoutSeconds: 0,
      baseRemainingMs: 0,
      wallRemainingMs: 0,
      failureSubtype: "qmd_allowance_exceeded"
    });

    const readyAdapter = new McpToolAdapter(async () => ({
      listTools: async () => ({ tools: [{ name: "query", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [] }),
      close: async () => {}
    }));
    await readyAdapter.setup("http://qmd.test", {
      timeoutMs: 1000,
      timeoutSeconds: 1,
      baseRemainingMs: 1000,
      wallRemainingMs: 1000
    });
    const call = await readyAdapter.callTool("query", {}, {
      timeoutMs: 0,
      timeoutSeconds: 0,
      baseRemainingMs: 0,
      wallRemainingMs: 0,
      failureSubtype: "qmd_allowance_exceeded"
    });

    expect(setup).toMatchObject({ status: "error", failureSubtype: "qmd_allowance_exceeded" });
    expect(call).toMatchObject({ status: "error", failureSubtype: "qmd_allowance_exceeded" });
  });

  test("ToolExecutionOutcome represents guardrail blocks", () => {
    const outcome: ToolExecutionOutcome = {
      source: "guardrail",
      status: "error",
      result: guardrailToolResult("stop", "max_tool_iterations"),
      isQmdTool: false,
      failureSubtype: "max_tool_iterations"
    };

    expect(outcome).toMatchObject({
      source: "guardrail",
      status: "error",
      failureSubtype: "max_tool_iterations"
    });
  });
});
