import type { AppEnv } from "../config/env";
import type { AgentExecutor } from "./interface";
import { ClaudeCodeExecutor } from "./claude-code";
import { AnthropicSdkExecutor } from "./anthropic-sdk";
import { MockExecutor } from "./mock";

export function createExecutor(env: AppEnv): AgentExecutor {
  if (env.EXECUTOR_DEFAULT === "mock") {
    return new MockExecutor();
  }

  if (env.EXECUTOR_DEFAULT === "anthropic-sdk") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("EXECUTOR_DEFAULT=anthropic-sdk requires ANTHROPIC_API_KEY to be set in .env");
    }
    return new AnthropicSdkExecutor(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL);
  }

  return new ClaudeCodeExecutor();
}
