import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { AgentExecutor, AgentResult, AgentTask } from "./interface";
import { buildStatusReportingPrompt, loadSkillFiles, readStatusFileFromWorkspace } from "./status-convention";
import { requireLocalWorkspaceRoot } from "../runtime/local-workspace";

class ClaudeSpawnError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly command: string;

  constructor(args: {
    message: string;
    exitCode: number | null;
    stderr: string;
    stdout: string;
    command: string;
  }) {
    super(args.message);
    this.name = "ClaudeSpawnError";
    this.exitCode = args.exitCode;
    this.stderr = args.stderr;
    this.stdout = args.stdout;
    this.command = args.command;
  }
}

/**
 * @deprecated Transitional local-only executor.
 *
 * Claude Code remains functional while `HarnessExecutor` reaches feature
 * parity for filesystem-heavy planner/coder/reviewer/doc work. New execution
 * features should target `HarnessExecutor`, `Workspace`, `ModelProvider`, and
 * `ToolRegistry` instead of adding new behavior here.
 */
export class ClaudeCodeExecutor implements AgentExecutor {
  readonly name = "claude-code";

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const command = process.env.CLAUDE_COMMAND ?? "claude";
    const prompt = buildPrompt(task);
    const cwd = requireLocalWorkspaceRoot(task.workspace);

    // Write a temporary MCP config if QMD is configured, so the claude session
    // has access to the QMD query/get/multi_get/status tools via HTTP MCP.
    const mcpConfigPath = task.environment.QMD_MCP_URL
      ? writeMcpConfig(task.environment.QMD_MCP_URL)
      : null;

    let timedOut = false;

    try {
      await spawnClaude(command, prompt, cwd, task.environment, task.budgetSeconds, mcpConfigPath, () => {
        timedOut = true;
      });
    } catch (err) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      if (timedOut) {
        return { status: "TIMEOUT", artifacts: [], metrics: { elapsedSeconds: task.budgetSeconds } };
      }
      const diagnostics = err instanceof ClaudeSpawnError
        ? {
            exitCode: err.exitCode,
            stderrExcerpt: excerpt(err.stderr),
            stdoutExcerpt: excerpt(err.stdout),
            command: err.command,
            executorMode: this.name
          }
        : {
            stderrExcerpt: excerpt(err instanceof Error ? err.message : String(err)),
            stdoutExcerpt: "",
            command,
            executorMode: this.name
          };
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: formatFailureReason(err),
        diagnostics,
        metrics: { elapsedSeconds }
      };
    } finally {
      if (mcpConfigPath) {
        try { unlinkSync(mcpConfigPath); } catch { /* already gone */ }
      }
    }

    const elapsedSeconds = (Date.now() - start) / 1000;
    const statusFile = await readStatusFileFromWorkspace(task.workspace);

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
      output: statusFile,
      metrics: { elapsedSeconds }
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

/**
 * Writes a temporary MCP config JSON file pointing at the QMD HTTP MCP server.
 * Returns the path so the caller can pass it to claude via --mcp-config and
 * clean it up afterwards.
 *
 * NOTE: claude CLI's MCP config schema requires a `type` discriminator
 * (one of "stdio" | "http" | "sse"). Omitting it causes claude to exit
 * with "Does not adhere to MCP server configuration schema".
 */
function writeMcpConfig(qmdMcpUrl: string): string {
  const config = {
    mcpServers: {
      qmd: { type: "http", url: qmdMcpUrl }
    }
  };
  const path = join(tmpdir(), `autoforge-mcp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(task: AgentTask): string {
  const sections: string[] = [];

  // Persona defines who the agent is — prepend first, matching AnthropicSdkExecutor behavior.
  if (task.systemPrompt) {
    sections.push(task.systemPrompt);
  }

  // Spec B §5.4: injected lineage lessons sit between persona and skills so
  // the agent reads them before picking up tool/skill guidance.
  if (task.lessons && task.lessons.trim().length > 0) {
    sections.push(task.lessons.trim());
  }

  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    sections.push(`# Skills\n\n${skillContents}`);
  }

  sections.push(`# Task\n\n${task.prompt}`);

  sections.push(buildStatusReportingPrompt(task.budgetSeconds));

  return sections.join("\n\n");
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
  mcpConfigPath: string | null,
  onTimeout: () => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // --print: non-interactive mode
    // --dangerously-skip-permissions: allows file writes without confirmation prompts
    // --output-format text: plain text output (no ANSI/JSON wrapping)
    // --input-format text: read prompt from stdin to avoid OS arg length limits for large prompts
    // --mcp-config: optional path to MCP server config (added when QMD is configured)
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--output-format", "text",
      "--input-format", "text",
      ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [])
    ];

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Deliver prompt via stdin then close to signal EOF.
    child.stdin.write(prompt, "utf8");
    child.stdin.end();

    let stderr = "";
    let stdout = "";
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(budgetTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(
        new ClaudeSpawnError({
          message: error.message,
          exitCode: null,
          stderr,
          stdout,
          command
        })
      );
    });

    child.on("close", (code) => {
      clearTimeout(budgetTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      // code null = killed by signal (budget timeout); treat as success so caller checks timedOut flag.
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(
          new ClaudeSpawnError({
            message: `claude exited with code ${code}: ${stderr.slice(0, 500)}`,
            exitCode: code,
            stderr,
            stdout,
            command
          })
        );
      }
    });
  });
}

function excerpt(input: string, maxLen = 500): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}...`;
}

function formatFailureReason(err: unknown): string {
  if (err instanceof ClaudeSpawnError) {
    const stderrSnippet = excerpt(err.stderr, 400);
    const stdoutSnippet = excerpt(err.stdout, 200);
    if (stderrSnippet) {
      return `claude exited with code ${err.exitCode ?? "unknown"}: ${stderrSnippet}`;
    }
    if (stdoutSnippet) {
      return `claude exited with code ${err.exitCode ?? "unknown"} (stdout excerpt): ${stdoutSnippet}`;
    }
    return `claude exited with code ${err.exitCode ?? "unknown"} with no diagnostics`;
  }
  return err instanceof Error ? err.message : String(err);
}
