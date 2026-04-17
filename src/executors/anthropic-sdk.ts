import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentExecutor, AgentResult, AgentTask, AgentTranscript, AgentTranscriptTurn } from "./interface";

const STATUS_FILE = ".autoforge-status.json";
const MAX_TOOL_ITERATIONS = 50;
const PER_CALL_TIMEOUT_MS = 120_000;
const CIRCUIT_BREAKER_READ_THRESHOLD = 12;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        content: { type: "string", description: "Full file content to write." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path. Set recursive=true for a tree view up to 3 levels deep.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory. Use '.' for root." },
        recursive: { type: "boolean", description: "If true, list recursively up to 3 levels deep." }
      },
      required: ["path"]
    }
  },
  {
    name: "search_files",
    description: "Search file contents with a regex pattern, like grep. Returns up to 20 matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for." },
        glob: { type: "string", description: "Optional file glob filter, e.g. '*.ts' or '*.json'. Searches all files if omitted." }
      },
      required: ["pattern"]
    }
  },
  {
    name: "read_multiple_files",
    description: "Read several files at once. More efficient than calling read_file repeatedly.",
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "string", description: "JSON array of file paths relative to the working directory, e.g. [\"src/a.ts\",\"src/b.ts\"]." }
      },
      required: ["paths"]
    }
  },
  {
    name: "bash",
    description: "Run a shell command in the working directory. Prefer read_file/write_file for file operations.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." }
      },
      required: ["command"]
    }
  }
];

// ---------------------------------------------------------------------------
// Tool stats (for circuit breaker and failure attribution)
// ---------------------------------------------------------------------------

interface ToolStats {
  readCount: number;
  writeCount: number;
  bashCount: number;
  searchCount: number;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function executeTool(
  name: string,
  input: Record<string, string>,
  cwd: string,
  env: Record<string, string>,
  stats: ToolStats
): string {
  try {
    switch (name) {
      case "read_file": {
        stats.readCount++;
        const abs = resolve(cwd, input.path);
        if (!existsSync(abs)) return `Error: file not found: ${input.path}`;
        return readFileSync(abs, "utf8");
      }
      case "write_file": {
        stats.writeCount++;
        const abs = resolve(cwd, input.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.content, "utf8");
        return `Written: ${input.path}`;
      }
      case "list_directory": {
        stats.readCount++;
        const abs = resolve(cwd, input.path);
        if (!existsSync(abs)) return `Error: directory not found: ${input.path}`;
        const recursive = input.recursive === "true";
        if (recursive) {
          return listRecursive(abs, cwd, 0, 3);
        }
        return readdirSync(abs, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
      }
      case "search_files": {
        stats.searchCount++;
        const args = ["-rn", "-m", "20"];
        if (input.glob) args.push("--include", input.glob);
        args.push(input.pattern, ".");
        const result = spawnSync("grep", args, {
          cwd,
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"]
        });
        return result.stdout?.trim() || "(no matches)";
      }
      case "read_multiple_files": {
        let paths: string[];
        try {
          paths = JSON.parse(input.paths) as string[];
        } catch {
          return "Error: paths must be a valid JSON array of strings";
        }
        stats.readCount += paths.length;
        return paths
          .map((p) => {
            const abs = resolve(cwd, p);
            if (!existsSync(abs)) return `--- ${p} ---\nError: file not found`;
            return `--- ${p} ---\n${readFileSync(abs, "utf8")}`;
          })
          .join("\n\n");
      }
      case "bash": {
        stats.bashCount++;
        const result = spawnSync("bash", ["-c", input.command], {
          cwd,
          env: { ...process.env, ...env },
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return out || `(exit ${result.status ?? "signal"})`;
      }
      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function listRecursive(absPath: string, rootCwd: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return "";
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  try {
    const entries = readdirSync(absPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = join(absPath, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        const children = listRecursive(entryPath, rootCwd, depth + 1, maxDepth);
        if (children) lines.push(children);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class AnthropicSdkExecutor implements AgentExecutor {
  readonly name = "anthropic-sdk";

  /**
   * Test hook: when set, used instead of constructing an Anthropic client.
   * Production code never sets this. Wired to support unit testing without
   * stubbing the entire SDK module. The opts shape mirrors the messages.create
   * params, optionally including mcp_servers when MCP is wired.
   */
  private _testCreate?: (opts: Anthropic.MessageCreateParamsNonStreaming & {
    mcp_servers?: Array<{ type: "url"; url: string; name: string }>;
  }) => Promise<{
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
    content: unknown[];
  }>;

  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const client = new Anthropic({ apiKey: this.apiKey });

    const systemPrompt = buildSystemPrompt(task);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: task.prompt }
    ];
    const turns: AgentTranscriptTurn[] = [];
    const buildTranscript = (): AgentTranscript => ({
      systemPrompt,
      userPrompt: task.prompt,
      turns
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let timedOut = false;
    const deadlineMs = Date.now() + task.budgetSeconds * 1000;
    const stats: ToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0 };

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }

        // Circuit breaker: if many reads and zero writes, nudge toward implementation.
        if (stats.readCount >= CIRCUIT_BREAKER_READ_THRESHOLD && stats.writeCount === 0 && iteration > 0) {
          messages.push({
            role: "user",
            content: `You have read ${stats.readCount} files without writing any implementation yet. You have enough context — start writing the implementation now. Do not read more files unless strictly necessary.`
          });
          // Reset read count so the nudge isn't repeated every iteration.
          stats.readCount = 0;
        }

        // Context window management: compress after 20 iterations to prevent bloat.
        if (iteration === 20 && messages.length > 14) {
          const droppedTurns = messages.length - 13;
          turns.push({ kind: "compaction", droppedTurns });
          const first = messages.slice(0, 1);
          const recent = messages.slice(-12);
          messages.length = 0;
          messages.push(...first, ...recent);
        }

        const mcpServers = task.environment.QMD_MCP_URL
          ? [{ type: "url" as const, url: task.environment.QMD_MCP_URL, name: "qmd" }]
          : undefined;

        const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
          model: task.model ?? this.model,
          max_tokens: 8192,
          system: systemPrompt,
          tools: TOOLS,
          messages
        };
        // Test hook expects a flat opts object including mcp_servers; merge here so both
        // production and test branches see the same shape.
        const callOpts = mcpServers ? { ...baseParams, mcp_servers: mcpServers } : baseParams;

        const perCallTimeout = Math.min(PER_CALL_TIMEOUT_MS, remainingMs);

        let response: Anthropic.Message;
        try {
          if (this._testCreate) {
            response = (await this._testCreate(callOpts)) as Anthropic.Message;
          } else if (mcpServers) {
            // mcp_servers is only accepted by the beta messages endpoint. Routing the
            // non-MCP path through `client.messages.create` keeps production traffic on
            // the GA endpoint when MCP is not in use.
            const betaResponse = await client.beta.messages.create(
              callOpts as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming,
              {
                timeout: perCallTimeout,
                signal: AbortSignal.timeout(perCallTimeout)
              }
            );
            response = betaResponse as unknown as Anthropic.Message;
          } else {
            response = await client.messages.create(
              baseParams,
              {
                timeout: perCallTimeout,
                signal: AbortSignal.timeout(perCallTimeout)
              }
            );
          }
        } catch (callErr) {
          // Treat any per-call timeout/abort as overall budget exhaustion.
          if (
            callErr instanceof Error &&
            (callErr.name === "AbortError" ||
              callErr.message.includes("timeout") ||
              callErr.message.includes("timed out") ||
              callErr.message.includes("aborted"))
          ) {
            timedOut = true;
            break;
          }
          throw callErr;
        }

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;

        messages.push({ role: "assistant", content: response.content });
        turns.push({ kind: "assistant", content: response.content });

        if (response.stop_reason === "end_turn") {
          break;
        }

        if (response.stop_reason === "tool_use") {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const result = executeTool(
              block.name,
              block.input as Record<string, string>,
              task.workingDirectory,
              task.environment,
              stats
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result
            });
            turns.push({ kind: "tool_result", toolUseId: block.id, content: result });
          }

          messages.push({ role: "user", content: toolResults });
        }
      }
    } catch (err) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: err instanceof Error ? err.message : String(err),
        metrics: {
          elapsedSeconds,
          tokenInput: totalInputTokens,
          tokenOutput: totalOutputTokens,
          toolStats: { ...stats, iterations: MAX_TOOL_ITERATIONS }
        },
        transcript: buildTranscript()
      };
    }

    const elapsedSeconds = (Date.now() - start) / 1000;
    const totalIterations = messages.filter((m) => m.role === "assistant").length;

    if (timedOut) {
      return {
        status: "TIMEOUT",
        artifacts: [],
        metrics: {
          elapsedSeconds: task.budgetSeconds,
          tokenInput: totalInputTokens,
          tokenOutput: totalOutputTokens,
          toolStats: { ...stats, iterations: totalIterations }
        },
        transcript: buildTranscript()
      };
    }

    const statusFile = readStatusFile(task.workingDirectory);
    if (!statusFile) {
      return {
        status: "DONE_WITH_CONCERNS",
        artifacts: [],
        concerns: "Agent did not write .autoforge-status.json",
        metrics: {
          elapsedSeconds,
          tokenInput: totalInputTokens,
          tokenOutput: totalOutputTokens,
          toolStats: { ...stats, iterations: totalIterations }
        },
        transcript: buildTranscript()
      };
    }

    return {
      status: statusFile.status,
      artifacts: statusFile.artifacts,
      concerns: statusFile.concerns,
      blockReason: statusFile.blockReason,
      output: statusFile,
      metrics: {
        elapsedSeconds,
        tokenInput: totalInputTokens,
        tokenOutput: totalOutputTokens,
        toolStats: { ...stats, iterations: totalIterations }
      },
      transcript: buildTranscript()
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = new Anthropic({ apiKey: this.apiKey });
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(task: AgentTask): string {
  const sections: string[] = [];

  sections.push(task.systemPrompt);

  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    sections.push(`# Skills\n\n${skillContents}`);
  }

  sections.push(`# Status Reporting (required)

When you have finished the task you MUST write \`${STATUS_FILE}\` in the working directory using the write_file tool with this exact JSON format:

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

Time budget: ${task.budgetSeconds} seconds. Work efficiently. Use search_files to find relevant code rather than reading every file. Use read_multiple_files to read several files at once.`);

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
      // skip unreadable skill files
    }
  }
  return parts.join("\n\n---\n\n");
}

interface AgentStatusFile {
  status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  // Extra fields (e.g. "meta" from the meta agent, "subtasks" from the planner) pass through as output.
  [key: string]: unknown;
}

function readStatusFile(workingDirectory: string): AgentStatusFile | null {
  const statusPath = join(workingDirectory, STATUS_FILE);
  try {
    if (!existsSync(statusPath)) return null;
    return JSON.parse(readFileSync(statusPath, "utf8")) as AgentStatusFile;
  } catch {
    return null;
  }
}
