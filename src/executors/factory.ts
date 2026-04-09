import type { AppEnv } from "../config/env";
import type { AgentExecutor } from "./interface";
import { ClaudeCodeExecutor } from "./claude-code";
import { MockExecutor } from "./mock";

export function createExecutor(env: AppEnv): AgentExecutor {
  if (env.EXECUTOR_DEFAULT === "mock") {
    return new MockExecutor();
  }
  return new ClaudeCodeExecutor();
}
