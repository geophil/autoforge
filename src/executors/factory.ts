import type { AppEnv } from "../config/env";
import { AnthropicProvider } from "../runtime/anthropic-provider";
import { HarnessExecutor } from "../runtime/harness-executor";
import { createRuntimeToolRegistry } from "../runtime/tools";
import { MockExecutor } from "./mock";
import type { AgentExecutor } from "./interface";
import { DEFAULT_CHEAP_MODEL } from "../runtime/model-selection";

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
    supportedModels: unique([
      env.ANTHROPIC_MODEL,
      env.MODEL_TIER_CHEAP ?? env.PLANNER_MODEL_EXPRESS,
      env.MODEL_TIER_STANDARD ?? env.ANTHROPIC_MODEL,
      env.MODEL_TIER_STRONG ?? env.PLANNER_MODEL_COMPLEX,
      env.HARNESS_COMPACTION_MODEL,
      env.HARNESS_SUMMARIZATION_MODEL,
      env.HARNESS_CLASSIFICATION_MODEL,
      env.HARNESS_EXTRACTION_MODEL,
      env.MODEL_TIER_CHEAP,
      DEFAULT_CHEAP_MODEL
    ].filter((model): model is string => typeof model === "string" && model.length > 0))
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
      contextMaxChars: env.HARNESS_CONTEXT_MAX_CHARS,
      ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
      MODEL_TIER_CHEAP: env.MODEL_TIER_CHEAP,
      MODEL_TIER_STANDARD: env.MODEL_TIER_STANDARD,
      MODEL_TIER_STRONG: env.MODEL_TIER_STRONG,
      PLANNER_MODEL_EXPRESS: env.PLANNER_MODEL_EXPRESS,
      PLANNER_MODEL_COMPLEX: env.PLANNER_MODEL_COMPLEX,
      HARNESS_COMPACTION_MODEL: env.HARNESS_COMPACTION_MODEL,
      HARNESS_SUMMARIZATION_MODEL: env.HARNESS_SUMMARIZATION_MODEL,
      HARNESS_CLASSIFICATION_MODEL: env.HARNESS_CLASSIFICATION_MODEL,
      HARNESS_EXTRACTION_MODEL: env.HARNESS_EXTRACTION_MODEL,
      HARNESS_COMPACTION_TIMEOUT_SECONDS: env.HARNESS_COMPACTION_TIMEOUT_SECONDS,
      HARNESS_SUMMARIZATION_TIMEOUT_SECONDS: env.HARNESS_SUMMARIZATION_TIMEOUT_SECONDS,
      HARNESS_CLASSIFICATION_TIMEOUT_SECONDS: env.HARNESS_CLASSIFICATION_TIMEOUT_SECONDS,
      HARNESS_EXTRACTION_TIMEOUT_SECONDS: env.HARNESS_EXTRACTION_TIMEOUT_SECONDS,
      HARNESS_COMPACTION_MAX_TOKENS: env.HARNESS_COMPACTION_MAX_TOKENS,
      HARNESS_SUMMARIZATION_MAX_TOKENS: env.HARNESS_SUMMARIZATION_MAX_TOKENS,
      HARNESS_CLASSIFICATION_MAX_TOKENS: env.HARNESS_CLASSIFICATION_MAX_TOKENS,
      HARNESS_EXTRACTION_MAX_TOKENS: env.HARNESS_EXTRACTION_MAX_TOKENS
    }
  });

  return { primary: harness };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
