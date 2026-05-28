import type {
  AgentExecutor,
  AgentResult,
  AgentTask,
  AgentTranscript,
  AgentTranscriptTurn,
  ToolStats
} from "../executors/interface";
import { buildStatusReportingPrompt, loadSkillFiles, readStatusFileFromWorkspace } from "../executors/status-convention";
import type { ModelContentBlock, ModelMessage, ModelProvider, ModelResponse } from "./model-provider";
import { statsBucketForTool, ToolRegistry } from "./tool-registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TelemetryLedger } from "../executors/telemetry";
import { getModelCost } from "./pricing";
import { isExecResult, ToolResultShaper } from "./tool-output-shaping";
import { RunBudget } from "./run-budget";
import { AgentRunGuardrails, type AgentRunGuardrailConfig } from "./agent-run-guardrails";
import {
  isRuntimeFailureError,
  isTimeoutLikeError,
  RuntimeFailureError,
  type RuntimeFailureSubtype
} from "./runtime-failure-classifier";

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
  runtime?: AgentRunGuardrailConfig & {
    qmdTotalAllowanceSeconds?: number;
    qmdCallTimeoutSeconds?: number;
    modelCallTimeoutSeconds?: number;
    finalReserveSeconds?: number;
  };
  mcpClientFactory?: (url: string) => Promise<McpClient>;
}

interface McpClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: object }> }>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number }
  ): Promise<{ content?: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export class HarnessExecutor implements AgentExecutor {
  readonly name = "harness";

  constructor(private readonly options: HarnessExecutorOptions) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const budget = new RunBudget({
      budgetSeconds: task.budgetSeconds,
      qmdTotalAllowanceSeconds: this.options.runtime?.qmdTotalAllowanceSeconds,
      qmdCallTimeoutSeconds: this.options.runtime?.qmdCallTimeoutSeconds,
      modelCallTimeoutSeconds: this.options.runtime?.modelCallTimeoutSeconds,
      finalReserveSeconds: this.options.runtime?.finalReserveSeconds
    });
    const start = budget.startedAtMs;
    const systemPrompt = buildSystemPromptForTask(task);
    const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: task.prompt }] }];
    const turns: AgentTranscriptTurn[] = [];
    const loadedSkills: string[] = [];
    const toolStats: ToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0, iterations: 0 };
    let tokenInput = 0;
    let tokenOutput = 0;

    const ledger = new TelemetryLedger();
    const shaper = new ToolResultShaper();
    const guardrails = new AgentRunGuardrails(task, this.options.runtime);
    let mcpClient: McpClient | null = null;
    let availableTools = this.options.tools.definitions();
    const mcpToolNames = new Set<string>();

    if (task.environment.QMD_MCP_URL) {
      const setupStart = Date.now();
      const setupTimeout = budget.timeoutForQmdCall();
      let setupStatus: "success" | "error" = "success";
      let setupMessage = "";
      let setupFailureSubtype: RuntimeFailureSubtype | undefined = setupTimeout.failureSubtype;
      try {
        if (setupTimeout.timeoutMs <= 0 || setupFailureSubtype) {
          throw new RuntimeFailureError("qmd_allowance_exceeded", "QMD allowance exhausted before MCP setup");
        }
        const setup = await withTimeout((async () => {
          const client = await this.createMcpClient(task.environment.QMD_MCP_URL!);
          const listed = await client.listTools();
          return { client, mcpTools: listed.tools };
        })(), setupTimeout.timeoutMs, `QMD MCP setup timed out after ${setupTimeout.timeoutSeconds.toFixed(3)}s`);
        mcpClient = setup.client;
        const mcpTools = setup.mcpTools;
        const mcpDefs = mcpTools.map(t => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema
        }));
        for (const t of mcpDefs) mcpToolNames.add(t.name);
        availableTools = [...availableTools, ...mcpDefs];
        setupMessage = JSON.stringify({ tools: mcpDefs.map((tool) => tool.name) });
      } catch (err) {
        setupStatus = "error";
        if (isRuntimeFailureError(err)) {
          setupFailureSubtype = err.failureSubtype;
        } else if (isTimeoutLikeError(err)) {
          setupFailureSubtype = "qmd_call_timeout";
        }
        setupMessage = err instanceof Error ? err.message : String(err);
        console.warn(`[harness] Failed to connect to QMD_MCP_URL: ${err}`);
        try { await mcpClient?.close(); } catch {}
        mcpClient = null;
      } finally {
        const qmdElapsedMs = Date.now() - setupStart;
        budget.observeQmdElapsed(qmdElapsedMs);
        const setupBytes = Buffer.byteLength(setupMessage, "utf8");
        ledger.recordToolCall({
          toolName: "qmd_setup",
          status: setupStatus,
          latencyMs: qmdElapsedMs,
          rawOutputBytes: setupBytes,
          truncatedOutputBytes: setupBytes,
          returnedToModelBytes: 0,
          qmdElapsedMs,
          qmdAllowanceUsedMs: budget.qmdAllowanceUsedMs(),
          qmdAllowanceRemainingMs: budget.qmdAllowanceRemainingMs(),
          historyChars: serializedHistoryChars(history),
          transcriptChars: 0,
          failureSubtype: setupFailureSubtype
        });
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
        if (budget.isBaseExpired()) {
          return timeoutResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger);
        }

        const historyChars = serializedHistoryChars(history);
        const contextBlock = guardrails.checkContextSize(historyChars);
        if (contextBlock && !contextBlock.shouldContinue) {
          return failedResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger, contextBlock.message, contextBlock.failureSubtype);
        }

        const modelStart = Date.now();
        const modelTimeout = budget.timeoutForModelCall();
        let response: ModelResponse;
        try {
          response = await this.options.provider.message({
            model: task.model ?? this.options.defaultModel,
            systemPrompt,
            history: snapshotHistory(history),
            tools: availableTools,
            maxTokens: DEFAULT_MAX_TOKENS,
            timeoutSeconds: modelTimeout.timeoutSeconds
          });
        } catch (error) {
          if (isTimeoutLikeError(error)) {
            ledger.recordModelCall({
              provider: this.options.provider.name,
              model: task.model ?? this.options.defaultModel,
              agentType: task.type,
              tokens: { input: 0, output: 0, cached: 0 },
              latencyMs: Date.now() - modelStart,
              timestamp: modelStart,
              retryAttempt: 0,
              estimatedCost: 0,
              modelCallTimeoutSeconds: modelTimeout.timeoutSeconds,
              historyChars,
              transcriptChars: transcriptChars(transcript()),
              failureSubtype: "model_call_timeout"
            });
            throw new RuntimeFailureError("model_call_timeout", error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
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
          ) / 1_000_000,
          modelCallTimeoutSeconds: modelTimeout.timeoutSeconds,
          historyChars,
          transcriptChars: transcriptChars(transcript())
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
            let failureSubtype: RuntimeFailureSubtype | undefined;
            let isQmdTool = mcpClient !== null && mcpToolNames.has(toolUse.name);
            let qmdElapsedMs: number | undefined;
            try {
              const guardBlock = guardrails.beforeTool({ toolName: toolUse.name, isQmd: isQmdTool, budget });
              if (guardBlock) {
                toolStatus = "error";
                failureSubtype = guardBlock.failureSubtype;
                result = guardrailToolResult(guardBlock.message, guardBlock.failureSubtype);
              } else if (isQmdTool && mcpClient) {
                guardrails.recordTool({ isQmd: true });
                const qmdTimeout = budget.timeoutForQmdCall();
                if (qmdTimeout.failureSubtype || qmdTimeout.timeoutMs <= 0) {
                  toolStatus = "error";
                  failureSubtype = "qmd_allowance_exceeded";
                  result = guardrailToolResult("QMD allowance is exhausted. Use existing evidence and write the best available status now.", "qmd_allowance_exceeded");
                } else {
                  try {
                    const mcpResult = await mcpClient.callTool(
                      { name: toolUse.name, arguments: toolUse.input as Record<string, unknown> },
                      undefined,
                      { timeout: qmdTimeout.timeoutMs }
                    );
                    const contentArray = (mcpResult.content || []) as any[];
                    const text = contentArray.map(extractMcpText).join("\n");
                    if (mcpResult.isError) {
                      toolStatus = "error";
                      result = text;
                    } else {
                      result = text;
                    }
                  } catch (error) {
                    if (isTimeoutLikeError(error)) {
                      toolStatus = "error";
                      failureSubtype = "qmd_call_timeout";
                      result = `QMD tool '${toolUse.name}' timed out after ${qmdTimeout.timeoutSeconds.toFixed(3)}s`;
                    } else {
                      throw error;
                    }
                  } finally {
                    qmdElapsedMs = Date.now() - toolStart;
                    budget.observeQmdElapsed(qmdElapsedMs);
                  }
                }
              } else {
                guardrails.recordTool({ isQmd: false });
                const localTimeout = budget.timeoutForLocalTool();
                if (localTimeout.timeoutMs <= 0) {
                  const error = new Error("Task budget exhausted before tool execution");
                  error.name = "AbortError";
                  throw error;
                }
                tool = this.options.tools.get(toolUse.name);
                result = await tool.execute(toolUse.input, task.workspace, {
                  environment: task.environment,
                  deadlineMs: Date.now() + localTimeout.timeoutMs,
                  timeoutSeconds: localTimeout.timeoutSeconds,
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
            const shaped = toolUse.name === "exec" && isExecResult(result)
              ? await shaper.shapeExecResult({
                workspace: task.workspace,
                toolUseId: toolUse.id,
                input: toolUse.input,
                result
              })
              : isQmdTool && typeof result === "string"
                ? await shaper.shapeMcpResult({
                  workspace: task.workspace,
                  toolUseId: toolUse.id,
                  toolName: toolUse.name,
                  input: toolUse.input,
                  text: result,
                  isError: toolStatus === "error"
                })
              : null;
            const serialized = shaped
              ? { raw: shaped.content, bounded: shaped.content }
              : serializeToolResultDetailed(result);
            const currentHistoryChars = serializedHistoryChars(history);
            const currentTranscriptChars = transcriptChars(transcript());
            ledger.recordToolCall({
              toolName: toolUse.name,
              status: toolStatus,
              latencyMs: Date.now() - toolStart,
              rawOutputBytes: shaped?.rawOutputBytes ?? Buffer.byteLength(serialized.raw, "utf8"),
              truncatedOutputBytes: Buffer.byteLength(serialized.bounded, "utf8"),
              artifactBytes: shaped?.artifactBytes,
              summaryBytes: shaped?.summaryBytes,
              returnedToModelBytes: shaped?.returnedToModelBytes ?? Buffer.byteLength(serialized.bounded, "utf8"),
              outputMode: shaped?.outputMode,
              parser: shaped?.parser,
              artifactReference: shaped?.artifactReference,
              fullOutputReason: shaped?.fullOutputReason,
              qmdElapsedMs,
              qmdAllowanceUsedMs: isQmdTool ? budget.qmdAllowanceUsedMs() : undefined,
              qmdAllowanceRemainingMs: isQmdTool ? budget.qmdAllowanceRemainingMs() : undefined,
              historyChars: currentHistoryChars,
              transcriptChars: currentTranscriptChars,
              failureSubtype
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
          const contextBlock = guardrails.checkContextSize(serializedHistoryChars(history));
          if (contextBlock && !contextBlock.shouldContinue) {
            return failedResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger, contextBlock.message, contextBlock.failureSubtype);
          }
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
        diagnostics: { failureSubtype: "max_tool_iterations" },
        metrics: {
          ...elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
          telemetry: telemetryMetrics(ledger)
        },
        transcript: transcript()
      };
    } catch (error) {
      if (isRuntimeFailureError(error)) {
        return timeoutResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger, error.failureSubtype);
      }
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

  private async createMcpClient(url: string): Promise<McpClient> {
    if (this.options.mcpClientFactory) return this.options.mcpClientFactory(url);
    const client = new Client({ name: "autoforge-agent", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    return client as unknown as McpClient;
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
  ledger: TelemetryLedger,
  failureSubtype?: RuntimeFailureSubtype
): AgentResult {
  flushTelemetry(workspace, ledger).catch(() => {});
  return {
    status: "TIMEOUT",
    artifacts: [],
    diagnostics: failureSubtype ? { failureSubtype } : undefined,
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

function failedResult(
  workspace: import("./workspace").Workspace,
  start: number,
  tokenInput: number,
  tokenOutput: number,
  toolStats: ToolStats,
  transcript: AgentTranscript,
  ledger: TelemetryLedger,
  blockReason: string,
  failureSubtype: RuntimeFailureSubtype
): AgentResult {
  flushTelemetry(workspace, ledger).catch(() => {});
  return {
    status: "FAILED",
    artifacts: [],
    blockReason,
    diagnostics: { failureSubtype },
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
  if (isRuntimeFailureError(error)) return true;
  return isTimeoutLikeError(error);
}

function serializedHistoryChars(history: ModelMessage[]): number {
  return JSON.stringify(history).length;
}

function transcriptChars(transcript: AgentTranscript): number {
  return JSON.stringify(transcript.turns).length;
}

function guardrailToolResult(message: string, failureSubtype: RuntimeFailureSubtype): Record<string, unknown> {
  return {
    status: "blocked",
    failureSubtype,
    message,
    instruction: "Do not call more exploratory tools for this phase. Write .autoforge-status.json with the best available result now."
  };
}

function extractMcpText(content: any): string {
  if (content?.type === "text") return content.text ?? "";
  if (content?.type === "resource" && content.resource) return content.resource.text ?? "";
  return JSON.stringify(content);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(message);
          error.name = "AbortError";
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  await workspace.writeFile(".autoforge/.gitignore", "*\n");
  await workspace.writeFile(".autoforge/telemetry.json", JSON.stringify(payload, null, 2));
}
