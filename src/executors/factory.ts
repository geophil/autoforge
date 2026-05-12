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
    supportedModels: [env.ANTHROPIC_MODEL]
  });
  const tools = createRuntimeToolRegistry();
  const harness = new HarnessExecutor({
    provider,
    tools,
    defaultModel: env.ANTHROPIC_MODEL
  });

  return { primary: harness };
}

