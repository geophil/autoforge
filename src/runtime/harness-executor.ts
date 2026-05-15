import type {
  AgentExecutor,
  AgentResult,
  AgentTask,
  AgentTranscript,
  AgentTranscriptTurn,
  ToolStats
} from "../executors/interface";
import { buildStatusReportingPrompt, loadSkillFiles, readStatusFileFromWorkspace } from "../executors/status-convention";
import type { ModelContentBlock, ModelMessage, ModelProvider } from "./model-provider";
import { statsBucketForTool, ToolRegistry } from "./tool-registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TelemetryLedger } from "../executors/telemetry";
import { getModelCost } from "./pricing";

const DEFAULT_MAX_TOKENS = 8192;
const MAX_TOOL_ITERATIONS = 50;

/** Max serialized characters per tool result sent to the model; tunable per deployment/model. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/**
 * If `serialized` exceeds {@link MAX_TOOL_RESULT_CHARS}, keeps head and tail with a deterministic
 * marker. Below the cap, returns `serialized` unchanged (byte-for-byte as a JS string).
 */
export function boundSerializedToolResult(serialized: string): string {
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  for (let inner = MAX_TOOL_RESULT_CHARS; inner >= 0; inner--) {
    const omitted = serialized.length - inner;
    if (omitted <= 0) continue;
    const marker = `\n...<truncated ${omitted} chars>...\n`;
    if (inner + marker.length <= MAX_TOOL_RESULT_CHARS) {
      const headLen = Math.floor(inner / 2);
      const tailLen = inner - headLen;
      return serialized.slice(0, headLen) + marker + serialized.slice(serialized.length - tailLen);
    }
  }
  const omitted = serialized.length - 1;
  const marker = `\n...<truncated ${omitted} chars>...\n`;
  return serialized.slice(0, 1) + marker;
}

interface HarnessExecutorOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  defaultModel: string;
}

export class HarnessExecutor implements AgentExecutor {
  readonly name = "harness";

  constructor(private readonly options: HarnessExecutorOptions) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const deadlineMs = start + task.budgetSeconds * 1000;
    const systemPrompt = buildSystemPromptForTask(task);
    const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: task.prompt }] }];
    const turns: AgentTranscriptTurn[] = [];
    const loadedSkills: string[] = [];
    const toolStats: ToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0, iterations: 0 };
    let tokenInput = 0;
    let tokenOutput = 0;

    const ledger = new TelemetryLedger();
    let mcpClient: Client | null = null;
    let availableTools = this.options.tools.definitions();
    const mcpToolNames = new Set<string>();

    if (task.environment.QMD_MCP_URL) {
      mcpClient = new Client({ name: "autoforge-agent", version: "0.1.0" }, { capabilities: {} });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(task.environment.QMD_MCP_URL));
        await mcpClient.connect(transport);
        const { tools: mcpTools } = await mcpClient.listTools();
        const mcpDefs = mcpTools.map(t => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema
        }));
        for (const t of mcpDefs) mcpToolNames.add(t.name);
        availableTools = [...availableTools, ...mcpDefs];
      } catch (err) {
        console.warn(`[harness] Failed to connect to QMD_MCP_URL: ${err}`);
        try { await mcpClient.close(); } catch {}
        mcpClient = null;
      }
    }

    const transcript = (): AgentTranscript => ({
      systemPrompt,
      userPrompt: task.prompt,
      turns: loadedSkills.length > 0
        ? [...turns, { kind: "loaded_skills", skills: [...loadedSkills] }]
        : turns,
      ...(loadedSkills.length > 0 ? { loadedSkills: [...loadedSkills] } : {})
    });

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          return timeoutResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger);
        }

        const modelStart = Date.now();
        const response = await this.options.provider.message({
          model: task.model ?? this.options.defaultModel,
          systemPrompt,
          history: snapshotHistory(history),
          tools: availableTools,
          maxTokens: DEFAULT_MAX_TOKENS,
          timeoutSeconds: remainingMs / 1000
        });
        const modelEnd = Date.now();

        const cost = getModelCost(this.options.provider.name, task.model ?? this.options.defaultModel);
        const cachedTokens = response.usage.cached ?? 0;
        const billableInputTokens = Math.max(response.usage.input - cachedTokens, 0);
        ledger.recordModelCall({
          provider: this.options.provider.name,
          model: task.model ?? this.options.defaultModel,
          agentType: task.type,
          tokens: {
            input: response.usage.input,
            output: response.usage.output,
            cached: cachedTokens
          },
          latencyMs: modelEnd - modelStart,
          timestamp: modelStart,
          retryAttempt: 0,
          estimatedCost: (
            (billableInputTokens * cost.input) +
            (cachedTokens * cost.cached) +
            (response.usage.output * cost.output)
          ) / 1_000_000
        });

        tokenInput += response.usage.input;
        tokenOutput += response.usage.output;
        toolStats.iterations += 1;
        const responseContent = snapshotContent(response.content);
        history.push({ role: "assistant", content: responseContent });
        turns.push({ kind: "assistant", content: snapshotContent(responseContent) });

        if (response.stopReason === "tool_use") {
          const toolResults: ModelContentBlock[] = [];
          for (const toolUse of toolUsesIn(responseContent)) {
            let tool: ReturnType<ToolRegistry["get"]> | null = null;
            let result: unknown;
            const toolStart = Date.now();
            let toolStatus: "success" | "error" = "success";
            try {
              const toolRemainingMs = deadlineMs - Date.now();
              if (toolRemainingMs <= 0) {
                const error = new Error("Task budget exhausted before tool execution");
                error.name = "AbortError";
                throw error;
              }

              if (mcpClient && mcpToolNames.has(toolUse.name)) {
                const mcpResult = await mcpClient.callTool(
                  { name: toolUse.name, arguments: toolUse.input as Record<string, unknown> },
                  undefined,
                  { timeout: toolRemainingMs }
                );
                const contentArray = (mcpResult.content || []) as any[];
                const extractText = (c: any) => {
                  if (c.type === "text") return c.text ?? "";
                  if (c.type === "resource" && c.resource) return c.resource.text ?? "";
                  return JSON.stringify(c);
                };
                if (mcpResult.isError) {
                  toolStatus = "error";
                  result = new Error(contentArray.map(extractText).join("\n"));
                } else {
                  result = contentArray.map(extractText).join("\n");
                }
              } else {
                tool = this.options.tools.get(toolUse.name);
                result = await tool.execute(toolUse.input, task.workspace, {
                  environment: task.environment,
                  deadlineMs,
                  timeoutSeconds: toolRemainingMs / 1000,
                  recordLoadedSkill: (name) => {
                    if (!loadedSkills.includes(name)) loadedSkills.push(name);
                  }
                });
                if (result instanceof Error) toolStatus = "error";
              }
            } catch (error) {
              if (isTimeoutError(error)) throw error;
              toolStatus = "error";
              result = error instanceof Error ? error : new Error(String(error));
            } finally {
              if (tool) recordToolStat(toolStats, statsBucketForTool(tool));
            }
            const serialized = serializeToolResultDetailed(result);
            ledger.recordToolCall({
              toolName: toolUse.name,
              status: toolStatus,
              latencyMs: Date.now() - toolStart,
              rawOutputBytes: Buffer.byteLength(serialized.raw, "utf8"),
              truncatedOutputBytes: Buffer.byteLength(serialized.bounded, "utf8")
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: serialized.bounded
            });
            turns.push({
              kind: "tool_result",
              toolUseId: toolUse.id,
              content: serialized.bounded
            });
          }
          history.push({ role: "user", content: toolResults });
          continue;
        }

        if (response.stopReason === "error") {
          throw new Error("Model provider returned error stop reason");
        }

        if (isTerminalStop(response.stopReason)) {
          return await finalize(task, start, tokenInput, tokenOutput, toolStats, transcript(), ledger);
        }
      }

      await flushTelemetry(task.workspace, ledger).catch(() => {});
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: `Exceeded maximum harness iterations (${MAX_TOOL_ITERATIONS})`,
        metrics: {
          ...elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
          telemetry: telemetryMetrics(ledger)
        },
        transcript: transcript()
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        return timeoutResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger);
      }
      const message = error instanceof Error ? error.message : String(error);
      turns.push({
        kind: "error",
        name: error instanceof Error ? error.name : "UnknownError",
        message,
        stack: error instanceof Error ? error.stack : undefined
      });
      await flushTelemetry(task.workspace, ledger).catch(() => {});
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: message,
        metrics: {
          ...elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
          telemetry: telemetryMetrics(ledger)
        },
        transcript: transcript()
      };
    } finally {
      if (mcpClient) {
        try { await mcpClient.close(); } catch {}
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export function buildSystemPromptForTask(task: Pick<AgentTask, "systemPrompt" | "lessons" | "skillFiles" | "budgetSeconds">): string {
  const sections: string[] = [];
  if (task.systemPrompt) sections.push(task.systemPrompt);
  if (task.lessons && task.lessons.trim().length > 0) sections.push(task.lessons.trim());
  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) sections.push(`# Skills\n\n${skillContents}`);
  sections.push(buildStatusReportingPrompt(task.budgetSeconds));
  return sections.join("\n\n");
}

function toolUsesIn(content: ModelContentBlock[]): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return content.flatMap((block) => {
    if (block.type !== "tool_use") return [];
    if (typeof block.id !== "string" || typeof block.name !== "string") {
      throw new Error("Malformed tool_use block");
    }
    return [{
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {}
    }];
  });
}

function snapshotHistory(history: ModelMessage[]): ModelMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: snapshotContent(message.content)
  }));
}

interface SerializedToolResult {
  raw: string;
  bounded: string;
}

export function serializeToolResultDetailed(result: unknown): SerializedToolResult {
  let raw: string;
  if (result === undefined || result === null) raw = "(empty result)";
  else if (typeof result === "string") raw = result;
  else if (result instanceof Error) raw = `Error: ${result.message}`;
  else {
    try {
      const json = JSON.stringify(result);
      raw = typeof json === "string" ? json : "[unserializable tool result]";
    } catch (error) {
      void error;
      raw = "[unserializable tool result]";
    }
  }
  return { raw, bounded: boundSerializedToolResult(raw) };
}

export function serializeToolResult(result: unknown): string {
  return serializeToolResultDetailed(result).bounded;
}

function snapshotContent(content: ModelContentBlock[]): ModelContentBlock[] {
  return content.map((block) => cloneContentBlock(block));
}

function cloneContentBlock(block: ModelContentBlock): ModelContentBlock {
  try {
    return structuredClone(block) as ModelContentBlock;
  } catch {
    try {
      return JSON.parse(JSON.stringify(block)) as ModelContentBlock;
    } catch {
      return { type: block.type, text: "[unserializable content block]" };
    }
  }
}

function isTerminalStop(stopReason: string): boolean {
  return (
    stopReason === "end_turn" ||
    stopReason === "stop_sequence" ||
    stopReason === "pause_turn" ||
    stopReason === "refusal" ||
    stopReason === "max_tokens"
  );
}

async function finalize(
  task: AgentTask,
  start: number,
  tokenInput: number,
  tokenOutput: number,
  toolStats: ToolStats,
  transcript: AgentTranscript,
  ledger: TelemetryLedger
): Promise<AgentResult> {
  const statusFile = await readStatusFileFromWorkspace(task.workspace);
  await flushTelemetry(task.workspace, ledger).catch(() => {});
  const telemetry = telemetryMetrics(ledger);

  if (!statusFile) {
    return {
      status: "DONE_WITH_CONCERNS",
      artifacts: [],
      concerns: "Agent did not write .autoforge-status.json",
      metrics: {
        ...elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
        telemetry
      },
      transcript
    };
  }
  return {
    status: statusFile.status,
    artifacts: statusFile.artifacts,
    concerns: statusFile.concerns,
    blockReason: statusFile.blockReason,
    output: statusFile,
    metrics: {
      ...elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
      telemetry
    },
    transcript
  };
}

function timeoutResult(
  workspace: import("./workspace").Workspace,
  start: number,
  tokenInput: number,
  tokenOutput: number,
  toolStats: ToolStats,
  transcript: AgentTranscript,
  ledger: TelemetryLedger
): AgentResult {
  flushTelemetry(workspace, ledger).catch(() => {});
  return {
    status: "TIMEOUT",
    artifacts: [],
    metrics: {
      elapsedSeconds: (Date.now() - start) / 1000,
      tokenInput,
      tokenOutput,
      toolStats,
      telemetry: telemetryMetrics(ledger)
    },
    transcript
  };
}

function telemetryMetrics(ledger: TelemetryLedger): NonNullable<AgentResult["metrics"]["telemetry"]> {
  return {
    ...ledger.getSummary(),
    events: ledger.getEvents()
  };
}

function elapsedMetrics(start: number, tokenInput: number, tokenOutput: number, toolStats: ToolStats): AgentResult["metrics"] {
  return {
    elapsedSeconds: (Date.now() - start) / 1000,
    tokenInput,
    tokenOutput,
    toolStats
  };
}

function recordToolStat(stats: ToolStats, bucket: ReturnType<typeof statsBucketForTool>): void {
  if (bucket === "read") stats.readCount += 1;
  if (bucket === "write") stats.writeCount += 1;
  if (bucket === "bash") stats.bashCount += 1;
  if (bucket === "search") stats.searchCount += 1;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("must be an integer")) return false;
  return (
    error.name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function flushTelemetry(workspace: import("./workspace").Workspace, ledger: TelemetryLedger): Promise<void> {
  const summary = ledger.getSummary();
  const events = ledger.getEvents();
  const payload = {
    ...summary,
    events
  };
  await workspace.writeFile(".autoforge-telemetry.json", JSON.stringify(payload, null, 2));
}
