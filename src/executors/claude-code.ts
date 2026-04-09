import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecutor, AgentResult, AgentTask } from "./interface";

/** Convention file written by the agent to report status and artifacts. */
const STATUS_FILE = ".autoforge-status.json";

interface AgentStatusFile {
  status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
}

export class ClaudeCodeExecutor implements AgentExecutor {
  readonly name = "claude-code";

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const command = process.env.CLAUDE_COMMAND ?? "claude";
    const prompt = buildPrompt(task);

    let timedOut = false;

    try {
      await spawnClaude(command, prompt, task.workingDirectory, task.environment, task.budgetSeconds, () => {
        timedOut = true;
      });
    } catch (err) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      if (timedOut) {
        return { status: "TIMEOUT", artifacts: [], metrics: { elapsedSeconds: task.budgetSeconds } };
      }
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: err instanceof Error ? err.message : String(err),
        metrics: { elapsedSeconds }
      };
    }

    const elapsedSeconds = (Date.now() - start) / 1000;
    const statusFile = readStatusFile(task.workingDirectory);

    if (!statusFile) {
      // Agent completed but didn't write the convention file — treat as DONE_WITH_CONCERNS.
      return {
        status: "DONE_WITH_CONCERNS",
        artifacts: [],
        concerns: "Agent did not write .autoforge-status.json",
        output: { raw: "(no status file)" },
        metrics: { elapsedSeconds }
      };
    }

    return {
      status: statusFile.status,
      artifacts: statusFile.artifacts,
      concerns: statusFile.concerns,
      blockReason: statusFile.blockReason,
      metrics: { elapsedSeconds }
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(task: AgentTask): string {
  const sections: string[] = [];

  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    sections.push(`# Skills\n\n${skillContents}`);
  }

  sections.push(`# Task\n\n${task.prompt}`);

  sections.push(`# Status Reporting (required)

When you have finished the task you MUST write \`${STATUS_FILE}\` in the working directory with this exact JSON format:

\`\`\`json
{
  "status": "DONE",
  "artifacts": ["relative/path/to/changed/file1", "relative/path/to/changed/file2"]
}
\`\`\`

Valid status values:
- **"DONE"** — completed successfully, all criteria met
- **"DONE_WITH_CONCERNS"** — completed but add a "concerns" field explaining what was imperfect
- **"BLOCKED"** — cannot proceed; add a "blockReason" field with a clear explanation
- **"NEEDS_CONTEXT"** — missing information; add a "blockReason" field specifying what is needed

Time budget: ${task.budgetSeconds} seconds. Work efficiently.`);

  return sections.join("\n\n");
}

function loadSkillFiles(skillFiles: string[]): string {
  const parts: string[] = [];
  for (const filePath of skillFiles) {
    try {
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath, "utf8").trim());
      }
    } catch {
      // Skip unreadable skill files silently.
    }
  }
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Status file reading
// ---------------------------------------------------------------------------

function readStatusFile(workingDirectory: string): AgentStatusFile | null {
  const statusPath = join(workingDirectory, STATUS_FILE);
  try {
    if (!existsSync(statusPath)) return null;
    return JSON.parse(readFileSync(statusPath, "utf8")) as AgentStatusFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

async function spawnClaude(
  command: string,
  prompt: string,
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  onTimeout: () => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // --print: non-interactive mode
    // --dangerously-skip-permissions: allows file writes without confirmation prompts
    // --output-format text: plain text output (no ANSI/JSON wrapping)
    // --input-format text: read prompt from stdin to avoid OS arg length limits for large prompts
    const child = spawn(
      command,
      ["--print", "--dangerously-skip-permissions", "--output-format", "text", "--input-format", "text"],
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    // Deliver prompt via stdin then close to signal EOF.
    child.stdin.write(prompt, "utf8");
    child.stdin.end();

    let stderr = "";
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const budgetTimer = setTimeout(() => {
      onTimeout();
      child.kill("SIGTERM");
      // SIGKILL after 10-second grace period if process hasn't exited.
      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 10_000);
    }, timeoutSeconds * 1000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(budgetTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(budgetTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      // code null = killed by signal (budget timeout); treat as success so caller checks timedOut flag.
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
