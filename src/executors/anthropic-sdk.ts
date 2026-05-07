import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentExecutor, AgentResult, AgentTask, AgentTranscript, AgentTranscriptTurn } from "./interface";
import { buildStatusReportingPrompt, loadSkillFiles, readStatusFile } from "./status-convention";
import { AnthropicProvider, toToolDefinition } from "../runtime/anthropic-provider";

const MAX_TOOL_ITERATIONS = 50;
const PER_CALL_TIMEOUT_MS = 120_000;
const CIRCUIT_BREAKER_READ_THRESHOLD = 12;
const COMPACTION_THRESHOLD_FRACTION = 0.7;
const DEFAULT_MODEL_CONTEXT_TOKENS = 180_000;
const CHARS_PER_TOKEN_HEURISTIC = 4;
const FALLBACK_SUMMARY_MAX_BYTES = 8 * 1024;
const FALLBACK_SUMMARY_MAX_SEGMENTS = 30;
const DEFAULT_COMPACTION_MODEL = "claude-haiku-4";

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

interface ExecutorToolStats {
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
  stats: ExecutorToolStats,
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
        const recursive = input.recursive === true || input.recursive === "true";
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

function modelContextTokens(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("sonnet")) return 200_000;
  if (lower.includes("opus")) return 200_000;
  if (lower.includes("haiku")) return 200_000;
  return DEFAULT_MODEL_CONTEXT_TOKENS;
}

function estimateMessagesCharCount(messages: Anthropic.MessageParam[]): number {
  return messages.reduce((sum, message) => {
    const content = message.content;
    if (typeof content === "string") return sum + content.length;
    try {
      return sum + JSON.stringify(content).length;
    } catch {
      return sum;
    }
  }, 0);
}

function hasToolUse(content: Anthropic.MessageParam["content"]): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_use");
}

function hasToolResult(content: Anthropic.MessageParam["content"]): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result");
}

interface ExchangeGroup {
  assistantIndex: number;
  userIndex: number;
}

function collectExchangeGroups(messages: Anthropic.MessageParam[]): ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const assistant = messages[i];
    const toolResult = messages[i + 1];
    if (assistant.role !== "assistant" || toolResult.role !== "user") continue;
    if (!hasToolUse(assistant.content)) continue;
    if (!hasToolResult(toolResult.content)) continue;
    groups.push({ assistantIndex: i, userIndex: i + 1 });
  }
  return groups;
}

function renderCompactionInput(messages: Anthropic.MessageParam[], groups: ExchangeGroup[]): string {
  const lines: string[] = [];
  for (const group of groups) {
    const assistant = messages[group.assistantIndex];
    const user = messages[group.userIndex];
    lines.push("## Assistant Tool Use");
    lines.push(typeof assistant.content === "string" ? assistant.content : JSON.stringify(assistant.content));
    lines.push("## Tool Results");
    lines.push(typeof user.content === "string" ? user.content : JSON.stringify(user.content));
    lines.push("");
  }
  return lines.join("\n");
}

function extractiveSummaryFallback(input: string): string {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const mustKeep = lines.filter((line) => /reviewer|operator feedback|operator steering/i.test(line)).slice(-3);
  const segments: string[] = [];
  for (const line of lines) {
    if (segments.length >= FALLBACK_SUMMARY_MAX_SEGMENTS) break;
    segments.push(line.length > 280 ? `${line.slice(0, 277)}...` : line);
  }
  for (const line of mustKeep) {
    if (segments.length >= FALLBACK_SUMMARY_MAX_SEGMENTS) {
      segments.pop();
    }
    if (!segments.includes(line)) segments.push(line);
  }

  const joined = segments.join("\n");
  return joined.length <= FALLBACK_SUMMARY_MAX_BYTES
    ? joined
    : joined.slice(0, FALLBACK_SUMMARY_MAX_BYTES);
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

  /**
   * Test hook used by sdk-compaction tests to control the compaction summary
   * output without invoking a real model call.
   */
  private _testSummarize?: (input: { model: string; text: string }) => Promise<string>;

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
    const provider = new AnthropicProvider({
      apiKey: this.apiKey,
      client,
      createMessage: this._testCreate
        ? async (params) => this._testCreate!(params)
        : undefined
    });

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
    let completedIterations = 0;
    let inputTokensSinceCompaction = 0;
    let lastKnownInputTokens = 0;
    const deadlineMs = Date.now() + task.budgetSeconds * 1000;
    const stats: ExecutorToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0 };

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

        const modelContext = modelContextTokens(task.model ?? this.model);
        const projectedNextInputTokens =
          inputTokensSinceCompaction +
          Math.max(
            lastKnownInputTokens,
            Math.ceil(estimateMessagesCharCount(messages) / CHARS_PER_TOKEN_HEURISTIC)
          );
        if (projectedNextInputTokens >= COMPACTION_THRESHOLD_FRACTION * modelContext) {
          const compaction = await this.compactMessages({
            client,
            model: task.model ?? this.model,
            messages
          });
          if (compaction) {
            inputTokensSinceCompaction = 0;
            turns.push({
              kind: "compaction",
              droppedTurns: compaction.droppedTurns,
              retainedRecentTurns: compaction.retainedRecentTurns,
              triggerInputTokens: projectedNextInputTokens,
              summaryInputCharCount: compaction.summaryInputCharCount,
              summaryOutputCharCount: compaction.summaryOutputCharCount,
              summaryModel: compaction.summaryModel,
              usedFallback: compaction.usedFallback
            });
          }
        }

        const perCallTimeout = Math.min(PER_CALL_TIMEOUT_MS, remainingMs);

        let response: {
          usage: { input_tokens: number; output_tokens: number };
          stop_reason: string;
          content: Anthropic.ContentBlock[];
        };
        try {
          const modelResponse = await provider.message({
            model: task.model ?? this.model,
            systemPrompt,
            history: messages as unknown as Parameters<typeof provider.message>[0]["history"],
            tools: apiTools.map(toToolDefinition),
            maxTokens: 8192,
            timeoutSeconds: perCallTimeout / 1000
          });
          response = {
            usage: {
              input_tokens: modelResponse.usage.input,
              output_tokens: modelResponse.usage.output
            },
            stop_reason: modelResponse.stopReason,
            content: modelResponse.content as unknown as Anthropic.ContentBlock[]
          };
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
        completedIterations += 1;
        inputTokensSinceCompaction += response.usage.input_tokens;
        lastKnownInputTokens = response.usage.input_tokens;

        messages.push({ role: "assistant", content: response.content });
        turns.push({ kind: "assistant", content: response.content });

        if (response.stop_reason === "error") {
          throw new Error("Model provider returned error stop reason");
        }

        if (
          response.stop_reason === "end_turn" ||
          response.stop_reason === "stop_sequence" ||
          response.stop_reason === "refusal"
        ) {
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
          toolStats: { ...stats, iterations: completedIterations }
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
    const totalIterations = completedIterations;

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

  private async compactMessages(input: {
    client: Anthropic;
    model: string;
    messages: Anthropic.MessageParam[];
  }): Promise<{
    droppedTurns: number;
    retainedRecentTurns: number;
    summaryInputCharCount: number;
    summaryOutputCharCount: number;
    summaryModel: string | null;
    usedFallback: boolean;
  } | null> {
    const groups = collectExchangeGroups(input.messages);
    if (groups.length < 2) {
      return null;
    }
    const groupsToCompact = groups.slice(0, -1);
    if (groupsToCompact.length === 0) {
      return null;
    }

    const summaryInput = renderCompactionInput(input.messages, groupsToCompact);
    const summaryInputCharCount = summaryInput.length;
    if (summaryInputCharCount === 0) {
      return null;
    }

    const { memoryBlock, summaryModel, usedFallback } = await this.summarizeCompactionSlice({
      client: input.client,
      text: summaryInput
    });
    const summaryOutputCharCount = memoryBlock.length;

    const dropIndices = new Set<number>();
    for (const group of groupsToCompact) {
      dropIndices.add(group.assistantIndex);
      dropIndices.add(group.userIndex);
    }
    const retained = input.messages.filter((_, index) => !dropIndices.has(index));
    if (retained.length === input.messages.length) return null;

    const memoryMessage: Anthropic.MessageParam = {
      role: "user",
      content: `# Conversation Memory\n${memoryBlock}`
    };
    retained.splice(1, 0, memoryMessage);
    const droppedTurns = input.messages.length - retained.length;

    input.messages.length = 0;
    input.messages.push(...retained);

    return {
      droppedTurns,
      retainedRecentTurns: retained.length,
      summaryInputCharCount,
      summaryOutputCharCount,
      summaryModel,
      usedFallback
    };
  }

  private async summarizeCompactionSlice(input: {
    client: Anthropic;
    text: string;
  }): Promise<{ memoryBlock: string; summaryModel: string | null; usedFallback: boolean }> {
    const summaryModel = process.env.AUTOFORGE_COMPACTION_MODEL ?? DEFAULT_COMPACTION_MODEL;
    const summarizerContext = modelContextTokens(summaryModel);
    const maxInputChars = Math.floor((summarizerContext / 2) * CHARS_PER_TOKEN_HEURISTIC);
    const chunks: string[] = [];
    for (let offset = 0; offset < input.text.length; offset += maxInputChars) {
      chunks.push(input.text.slice(offset, offset + maxInputChars));
    }

    try {
      const partials: string[] = [];
      for (const chunk of chunks) {
        partials.push(await this.callCompactionSummarizer(input.client, summaryModel, chunk));
      }
      const merged = partials.join("\n\n");
      const memoryBlock =
        merged.length > maxInputChars
          ? await this.callCompactionSummarizer(input.client, summaryModel, merged.slice(0, maxInputChars))
          : merged;
      return { memoryBlock, summaryModel, usedFallback: false };
    } catch {
      return {
        memoryBlock: extractiveSummaryFallback(input.text),
        summaryModel: null,
        usedFallback: true
      };
    }
  }

  private async callCompactionSummarizer(client: Anthropic, model: string, text: string): Promise<string> {
    if (this._testSummarize) {
      return this._testSummarize({ model, text });
    }

    const response = await client.messages.create({
      model,
      max_tokens: 1200,
      system: `You compress coding-agent history into durable memory.
Output concise markdown with these headings exactly:
- Task goal
- Current plan / next step
- Files read and key findings
- Files changed
- Commands run and outcomes
- Failed attempts and why
- Reviewer or operator feedback
- Assumptions and constraints`,
      messages: [{ role: "user", content: text }]
    });
    const textBlocks = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return textBlocks.length > 0 ? textBlocks : extractiveSummaryFallback(text);
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

  sections.push(buildStatusReportingPrompt(task.budgetSeconds));

  return sections.join("\n\n");
}

/**
 * Test-only escape hatch that exposes the internal prompt composer so unit
 * tests can assert section ordering without instantiating the SDK client.
 */
export function buildSystemPromptForTest(task: AgentTask): string {
  return buildSystemPrompt(task);
}
