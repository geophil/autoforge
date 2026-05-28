import type { AgentTask } from "../executors/interface";
import type { AgentRunGuardrails } from "./agent-run-guardrails";
import type { McpToolAdapter } from "./mcp-tool-adapter";
import type { RunBudget } from "./run-budget";
import {
  isRuntimeFailureError,
  isTimeoutLikeError
} from "./runtime-failure-classifier";
import { statsBucketForTool, type ToolRegistry } from "./tool-registry";
import { guardrailToolResult, type ToolExecutionOutcome } from "./tool-execution-outcome";

export interface ToolUseRequest {
  name: string;
  input: Record<string, unknown>;
}

export interface ExecuteToolUseArgs {
  toolUse: ToolUseRequest;
  task: AgentTask;
  tools: ToolRegistry;
  mcpAdapter: McpToolAdapter;
  budget: RunBudget;
  guardrails: AgentRunGuardrails;
  recordLoadedSkill?: (name: string) => void;
}

export async function executeToolUse(args: ExecuteToolUseArgs): Promise<ToolExecutionOutcome> {
  const { toolUse, task, tools, mcpAdapter, budget, guardrails, recordLoadedSkill } = args;
  const toolStart = Date.now();
  const isQmdTool = mcpAdapter.hasTool(toolUse.name);
  try {
    const guardBlock = guardrails.beforeTool({ toolName: toolUse.name, isQmd: isQmdTool, budget });
    if (guardBlock) {
      return {
        toolName: toolUse.name,
        input: toolUse.input,
        source: "guardrail",
        status: "error",
        result: guardrailToolResult(guardBlock.message, guardBlock.failureSubtype),
        latencyMs: Date.now() - toolStart,
        isQmdTool,
        failureSubtype: guardBlock.failureSubtype
      };
    }

    if (isQmdTool) {
      guardrails.recordTool({ isQmd: true });
      const qmdTimeout = budget.timeoutForQmdCall();
      const call = await mcpAdapter.callTool(toolUse.name, toolUse.input, qmdTimeout);
      budget.observeQmdElapsed(call.elapsedMs);
      return {
        toolName: toolUse.name,
        input: toolUse.input,
        source: "qmd",
        status: call.status,
        result: call.failureSubtype === "qmd_allowance_exceeded"
          ? guardrailToolResult(call.text, call.failureSubtype)
          : call.text,
        latencyMs: Date.now() - toolStart,
        isQmdTool: true,
        qmdElapsedMs: call.elapsedMs,
        qmdAllowanceUsedMs: budget.qmdAllowanceUsedMs(),
        qmdAllowanceRemainingMs: budget.qmdAllowanceRemainingMs(),
        failureSubtype: call.failureSubtype
      };
    }

    guardrails.recordTool({ isQmd: false });
    const localTimeout = budget.timeoutForLocalTool();
    if (localTimeout.timeoutMs <= 0) {
      const error = new Error("Task budget exhausted before tool execution");
      error.name = "AbortError";
      throw error;
    }
    const tool = tools.get(toolUse.name);
    const result = await tool.execute(toolUse.input, task.workspace, {
      environment: task.environment,
      deadlineMs: Date.now() + localTimeout.timeoutMs,
      timeoutSeconds: localTimeout.timeoutSeconds,
      recordLoadedSkill
    });
    return {
      toolName: toolUse.name,
      input: toolUse.input,
      source: "local",
      status: result instanceof Error ? "error" : "success",
      result,
      latencyMs: Date.now() - toolStart,
      isQmdTool: false,
      statsBucket: statsBucketForTool(tool)
    };
  } catch (error) {
    if (isToolTimeoutError(error)) throw error;
    return {
      toolName: toolUse.name,
      input: toolUse.input,
      source: "error",
      status: "error",
      result: error instanceof Error ? error : new Error(String(error)),
      latencyMs: Date.now() - toolStart,
      isQmdTool: false
    };
  }
}

export function isToolTimeoutError(error: unknown): boolean {
  if (isRuntimeFailureError(error)) return true;
  return isTimeoutLikeError(error);
}
