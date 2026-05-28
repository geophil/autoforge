import type { AppEnv } from "../config/env";
import { AnthropicProvider } from "../runtime/anthropic-provider";
import { HarnessExecutor } from "../runtime/harness-executor";
import { createRuntimeToolRegistry } from "../runtime/tools";
import { MockExecutor } from "./mock";
import type { AgentExecutor } from "./interface";

export interface ExecutorSet {
  /** Primary executor used for real traffic. */
  primary: AgentExecutor;
}

/**
 * Build runtime executors from env.
 * Real traffic always runs through the harness executor.
 */
export function createExecutors(env: AppEnv): ExecutorSet {
  if (env.EXECUTOR_DEFAULT === "mock") {
    const mock = new MockExecutor();
    return { primary: mock };
  }

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when EXECUTOR_DEFAULT is not 'mock'");
  }

  const provider = new AnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    supportedModels: [
      env.ANTHROPIC_MODEL,
      env.MODEL_TIER_CHEAP ?? env.PLANNER_MODEL_EXPRESS,
      env.MODEL_TIER_STANDARD ?? env.ANTHROPIC_MODEL,
      env.MODEL_TIER_STRONG ?? env.PLANNER_MODEL_COMPLEX
    ]
  });
  const tools = createRuntimeToolRegistry();
  const harness = new HarnessExecutor({
    provider,
    tools,
    defaultModel: env.ANTHROPIC_MODEL,
    runtime: {
      qmdTotalAllowanceSeconds: env.QMD_MCP_TOTAL_ALLOWANCE_SECONDS,
      qmdCallTimeoutSeconds: env.QMD_MCP_CALL_TIMEOUT_SECONDS,
      finalReserveSeconds: env.PLANNER_FINAL_RESERVE_SECONDS,
      plannerSpecMaxQmdCalls: env.PLANNER_SPEC_MAX_QMD_CALLS,
      plannerSpecMaxToolCalls: env.PLANNER_SPEC_MAX_TOOL_CALLS,
      modelCallTimeoutSeconds: env.MODEL_CALL_TIMEOUT_SECONDS,
      contextMaxChars: env.HARNESS_CONTEXT_MAX_CHARS
    }
  });

  return { primary: harness };
}
