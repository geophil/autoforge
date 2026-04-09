import { spawn } from "node:child_process";
import type { AgentExecutor, AgentResult, AgentTask } from "./interface";

export class ClaudeCodeExecutor implements AgentExecutor {
  readonly name = "claude-code";

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const command = process.env.CLAUDE_COMMAND ?? "claude";
    const args = ["--print", task.prompt];

    const stdout = await runCommand(command, args, task.workingDirectory, task.environment, task.budgetSeconds);
    const elapsedSeconds = (Date.now() - start) / 1000;

    return {
      status: "DONE",
      artifacts: [],
      output: {
        raw: stdout
      },
      metrics: {
        elapsedSeconds
      }
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      }
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Claude command exited with code ${code}: ${stderr}`));
    });
  });
}
