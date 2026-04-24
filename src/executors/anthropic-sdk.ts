import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentExecutor, AgentResult, AgentTask, AgentTranscript, AgentTranscriptTurn } from "./interface";

const STATUS_FILE = ".autoforge-status.json";
const MAX_TOOL_ITERATIONS = 50;
const PER_CALL_TIMEOUT_MS = 120_000;
const CIRCUIT_BREAKER_READ_THRESHOLD = 12;

// ---------------------------------------------------------------------------
// MCP integration (client-side)
//
// QMD's MCP server lives on a private network (docker / k8s service DNS) and
// is not reachable from Anthropic's API infrastructure. So we run the MCP
// client in-process: open a Streamable HTTP connection to QMD when the task
// has QMD_MCP_URL set, list its tools, expose them to the model alongside
// our local tools, and dispatch any matching tool_use blocks to the MCP
// client. Same model claude-code.ts uses (it just delegates to the Claude
// CLI, which runs MCP client-side via --mcp-config).
// ---------------------------------------------------------------------------

/**
 * Structural type for the MCP client we use. The real `Client` from
 * `@modelcontextprotocol/sdk` satisfies this shape; tests pass a plain
 * object with the same methods to avoid spinning up a real server.
 */
interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: {
        type: "object";
        properties?: Record<string, unknown> | null;
        required?: readonly string[] | string[] | null;
        [k: string]: unknown;
      };
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

interface McpConnection {
  client: McpClientLike;
  toolNames: Set<string>;
  apiTools: Anthropic.Tool[];
}

function mcpToolToAnthropic(tool: {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown> | null;
    required?: readonly string[] | string[] | null;
  };
}): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    input_schema: {
      type: "object",
      properties: (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      ...(tool.inputSchema.required ? { required: [...tool.inputSchema.required] } : {})
    } as Anthropic.Tool["input_schema"]
  };
}

/**
 * Flatten an MCP tool-call result into a plain string for the Anthropic
 * `tool_result` content. Text blocks pass through; non-text blocks are
 * surfaced as a sentinel so the model knows the tool ran but the content
 * isn't representable as text. Errors are prefixed so the model treats them
 * as recoverable failures rather than data.
 */
function mcpContentToString(
  content: Array<{ type: string; text?: string; [k: string]: unknown }>,
  isError?: boolean
): string {
  const text = content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      return `[unsupported MCP content: ${c.type}]`;
    })
    .join("\n")
    .trim();
  if (isError) return `Error: ${text || "(MCP tool reported error with no message)"}`;
  return text || "(empty MCP result)";
}

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

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
  stats: ToolStats,
  mcp: McpConnection | null
): Promise<string> {
  if (mcp && mcp.toolNames.has(name)) {
    stats.searchCount++;
    try {
      const result = await mcp.client.callTool({
        name,
        arguments: input
      });
      return mcpContentToString(result.content, result.isError);
    } catch (err) {
      return `Error calling MCP tool ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Local-tool branches still treat inputs as strings; coerce here so we don't
  // touch every case below.
  const sinput = input as Record<string, string>;
  try {
    switch (name) {
      case "read_file": {
        stats.readCount++;
        const abs = resolve(cwd, sinput.path);
        if (!existsSync(abs)) return `Error: file not found: ${sinput.path}`;
        return readFileSync(abs, "utf8");
      }
      case "write_file": {
        stats.writeCount++;
        const abs = resolve(cwd, sinput.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, sinput.content, "utf8");
        return `Written: ${sinput.path}`;
      }
      case "list_directory": {
        stats.readCount++;
        const abs = resolve(cwd, sinput.path);
        if (!existsSync(abs)) return `Error: directory not found: ${sinput.path}`;
        const recursive = sinput.recursive === "true";
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
        if (sinput.glob) args.push("--include", sinput.glob);
        args.push(sinput.pattern, ".");
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
          paths = JSON.parse(sinput.paths) as string[];
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
        const result = spawnSync("bash", ["-c", sinput.command], {
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
   * stubbing the entire SDK module.
   */
  private _testCreate?: (opts: Anthropic.MessageCreateParamsNonStreaming) => Promise<{
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
    content: unknown[];
  }>;

  /**
   * Test hook: when set, used instead of opening a real MCP connection.
   * Production code never sets this. The stub object only needs the methods
   * declared in `McpClientLike` — no transport or server required.
   */
  private _testMcpClient?: McpClientLike;

  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  /**
   * Open a client-side MCP connection over Streamable HTTP. Lifetime is
   * scoped to a single `execute()` call: opened at the top, closed in
   * `finally`. This matches how `Anthropic` SDK and the Claude CLI's MCP
   * subprocess are scoped — fresh per agent run, no shared state across
   * tasks, no reconnect logic needed when QMD or the orchestrator restarts.
   */
  private async openMcp(url: string): Promise<McpConnection> {
    const client: McpClientLike =
      this._testMcpClient ??
      (await (async () => {
        const real = new Client({ name: "autoforge", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await real.connect(transport);
        return real as unknown as McpClientLike;
      })());

    const { tools } = await client.listTools();
    const apiTools = tools.map(mcpToolToAnthropic);
    const toolNames = new Set(tools.map((t) => t.name));
    return { client, toolNames, apiTools };
  }

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

    // Open a client-side MCP connection if the task is configured for QMD.
    // Tools are merged once and reused for every iteration.
    let mcp: McpConnection | null = null;
    if (task.environment.QMD_MCP_URL) {
      mcp = await this.openMcp(task.environment.QMD_MCP_URL);
    }
    const apiTools: Anthropic.Tool[] = mcp ? [...TOOLS, ...mcp.apiTools] : TOOLS;

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

        // Prompt caching: place an ephemeral cache breakpoint on the system
        // prompt. The breakpoint caches everything before it in the prompt
        // prefix order — that's `tools` + `system` here, which together
        // amount to ~5–15K stable tokens per iteration. Cache writes cost
        // 1.25× normal input tokens; reads cost 0.1×. Break-even after 2
        // reads, and a planner run typically does 5–20 iterations within the
        // 5-minute TTL window. Expected ~80% reduction in prefix input cost
        // per planner run; misses fall back to normal pricing automatically.
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: task.model ?? this.model,
          max_tokens: 8192,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" }
            }
          ],
          tools: apiTools,
          messages
        };

        const perCallTimeout = Math.min(PER_CALL_TIMEOUT_MS, remainingMs);

        let response: Anthropic.Message;
        try {
          if (this._testCreate) {
            response = (await this._testCreate(params)) as Anthropic.Message;
          } else {
            response = await client.messages.create(params, {
              timeout: perCallTimeout,
              signal: AbortSignal.timeout(perCallTimeout)
            });
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
            const result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              task.workingDirectory,
              task.environment,
              stats,
              mcp
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
      const errorName = err instanceof Error ? err.name : "UnknownError";
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      // Preserve the error in the transcript so forensics survive downstream.
      // Without this, a pre-flight failure (bad model alias, auth error, network)
      // leaves an empty transcript and the caller has no way to see why.
      turns.push({ kind: "error", name: errorName, message: errorMessage, stack: errorStack });
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: errorMessage,
        metrics: {
          elapsedSeconds,
          tokenInput: totalInputTokens,
          tokenOutput: totalOutputTokens,
          toolStats: { ...stats, iterations: MAX_TOOL_ITERATIONS }
        },
        transcript: buildTranscript()
      };
    } finally {
      // Always close the MCP connection — even on exception or early return —
      // so connection counts on the QMD side stay bounded across many runs.
      // Swallow close errors so they don't mask the real result/exception.
      if (mcp) {
        try { await mcp.client.close(); } catch { /* ignore */ }
      }
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

  // Spec B §5.4: lessons block slots between the persona and the `# Skills`
  // section. Trim so whitespace-only injections don't leave a stray blank
  // section in the final prompt.
  if (task.lessons && task.lessons.trim().length > 0) {
    sections.push(task.lessons.trim());
  }

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

/**
 * Test-only escape hatch that exposes the internal prompt composer so unit
 * tests can assert section ordering without instantiating the SDK client.
 */
export function buildSystemPromptForTest(task: AgentTask): string {
  return buildSystemPrompt(task);
}
