import type { AppEnv } from "../config/env";
import { ClaudeCodeExecutor } from "./claude-code";
import { AnthropicSdkExecutor } from "./anthropic-sdk";
import { MockExecutor } from "./mock";

export interface ExecutorSet {
  /** Primary executor — used when no routing rule overrides. */
  primary: AgentExecutor;
  /** SDK executor — available for simple/express tasks when configured. */
  sdk: AnthropicSdkExecutor | null;
  /** Claude Code executor — always available as long as the CLI exists. */
  claudeCode: ClaudeCodeExecutor;
}

/**
 * Build all available executors from env.
 * Returns both SDK and Claude Code when both are configured, so the
 * orchestrator can route by tier/agent type.
 */
export function createExecutors(env: AppEnv): ExecutorSet {
  const claudeCode = new ClaudeCodeExecutor();

  if (env.EXECUTOR_DEFAULT === "mock") {
    const mock = new MockExecutor();
    return { primary: mock, sdk: null, claudeCode };
  }

  const sdk =
    env.ANTHROPIC_API_KEY
      ? new AnthropicSdkExecutor(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL)
      : null;

  if (env.EXECUTOR_DEFAULT === "anthropic-sdk") {
    if (!sdk) {
      throw new Error("EXECUTOR_DEFAULT=anthropic-sdk requires ANTHROPIC_API_KEY to be set in .env");
    }
    return { primary: sdk, sdk, claudeCode };
  }

  // Default: claude-code as primary, SDK available as secondary when configured.
  return { primary: claudeCode, sdk, claudeCode };
}

