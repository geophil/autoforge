import type {
  AgentExecutor,
  AgentResult,
  AgentTask,
  AgentTranscript,
  AgentTranscriptTurn,
  ToolStats
} from "../executors/interface";
import { readStatusFileFromWorkspace } from "../executors/status-convention";
import type { ModelContentBlock, ModelProvider, ModelResponse } from "./model-provider";
import { ToolRegistry, type ToolStatsBucket } from "./tool-registry";
import { TelemetryLedger } from "../executors/telemetry";
import { getModelCost } from "./pricing";
import { isExecResult } from "./tool-output-shaping";
import { RuntimeControls, type RuntimeControlsConfig } from "./runtime-controls";
import {
  isRuntimeFailureError,
  isTimeoutLikeError,
  RuntimeFailureError,
  type RuntimeFailureSubtype
} from "./runtime-failure-classifier";
import { McpToolAdapter, type McpClient } from "./mcp-tool-adapter";
import {
  buildPromptEnvelopeForTask,
  promptEnvelopeSystemBlocks,
  renderPromptEnvelope
} from "./prompt-envelope";
import { executeToolUse } from "./tool-execution";
import { ConversationHistory } from "./conversation-history";
import { UtilityModelCaller } from "./utility-model-caller";
import { HistoryCompactor } from "./history-compactor";

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
  runtime?: RuntimeControlsConfig;
  mcpClientFactory?: (url: string) => Promise<McpClient>;
}

export class HarnessExecutor implements AgentExecutor {
  readonly name = "harness";

  constructor(private readonly options: HarnessExecutorOptions) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const controls = new RuntimeControls(task, this.options.runtime);
    const { budget, guardrails, shaper } = controls;
    const start = budget.startedAtMs;
    const promptEnvelope = buildPromptEnvelopeForTask(task);
    const systemPrompt = renderPromptEnvelope(promptEnvelope);
    const history = new ConversationHistory(task.prompt);
    const turns: AgentTranscriptTurn[] = [];
    const loadedSkills: string[] = [];
    const toolStats: ToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0, iterations: 0 };
    let tokenInput = 0;
    let tokenOutput = 0;

    const ledger = new TelemetryLedger();
    const utilityCaller = new UtilityModelCaller(this.options.provider, ledger, task.type);
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: this.options.defaultModel,
      ...this.options.runtime
    }, utilityCaller, ledger);
    const mcpAdapter = new McpToolAdapter(this.options.mcpClientFactory);
    let availableTools = this.options.tools.definitions();

    if (task.environment.QMD_MCP_URL) {
      const setupTimeout = budget.timeoutForQmdCall();
      const setup = await mcpAdapter.setup(task.environment.QMD_MCP_URL, setupTimeout);
      budget.observeQmdElapsed(setup.elapsedMs);
      if (setup.status === "error") {
        console.warn(`[harness] Failed to connect to QMD_MCP_URL: ${setup.message}`);
      }
      availableTools = [...availableTools, ...setup.toolDefinitions];
      const setupBytes = Buffer.byteLength(setup.message, "utf8");
      ledger.recordToolCall({
        toolName: "qmd_setup",
        status: setup.status,
        latencyMs: setup.elapsedMs,
        rawOutputBytes: setupBytes,
        truncatedOutputBytes: setupBytes,
        returnedToModelBytes: 0,
        qmdElapsedMs: setup.elapsedMs,
        qmdAllowanceUsedMs: budget.qmdAllowanceUsedMs(),
        qmdAllowanceRemainingMs: budget.qmdAllowanceRemainingMs(),
        historyChars: history.serializedChars(),
        transcriptChars: 0,
        failureSubtype: setup.failureSubtype
      });
    }

    const transcript = (): AgentTranscript => ({
      systemPrompt,
      userPrompt: task.prompt,
      turns: loadedSkills.length > 0
        ? [...turns, { kind: "loaded_skills", skills: [...loadedSkills] }]
        : turns,
      promptEnvelope: {
        stablePrefixVersion: promptEnvelope.stablePrefixVersion,
        stablePrefixHash: promptEnvelope.stablePrefixHash
      },
      ...(loadedSkills.length > 0 ? { loadedSkills: [...loadedSkills] } : {})
    });

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (budget.isBaseExpired()) {
          return timeoutResult(task.workspace, start, tokenInput, tokenOutput, toolStats, transcript(), ledger);
        }

        const compaction = await compactor.compactIfNeeded({
          history,
          workspace: task.workspace,
          taskGoal: task.prompt
        });
        if (compaction.transcriptTurn) {
          turns.push(compaction.transcriptTurn);
        }

        const historyChars = history.serializedChars();
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
            system: promptEnvelopeSystemBlocks(promptEnvelope),
            history: history.snapshot(),
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
              purpose: "agent_turn",
              tokens: { input: 0, output: 0, cached: 0 },
              latencyMs: Date.now() - modelStart,
              timestamp: modelStart,
              retryAttempt: 0,
              estimatedCost: 0,
              stablePrefixVersion: promptEnvelope.stablePrefixVersion,
              stablePrefixHash: promptEnvelope.stablePrefixHash,
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
        const cacheCreationTokens = response.usage.cacheCreation ?? 0;
        const billableInputTokens = Math.max(response.usage.input - cachedTokens, 0);
        ledger.recordModelCall({
          provider: this.options.provider.name,
          model: task.model ?? this.options.defaultModel,
          agentType: task.type,
          purpose: "agent_turn",
          tokens: {
            input: response.usage.input,
            output: response.usage.output,
            cached: cachedTokens,
            cacheCreation: cacheCreationTokens
          },
          latencyMs: modelEnd - modelStart,
          timestamp: modelStart,
          retryAttempt: 0,
          estimatedCost: (
            (billableInputTokens * cost.input) +
            (cachedTokens * cost.cached) +
            (response.usage.output * cost.output)
          ) / 1_000_000,
          stablePrefixVersion: promptEnvelope.stablePrefixVersion,
          stablePrefixHash: promptEnvelope.stablePrefixHash,
          modelCallTimeoutSeconds: modelTimeout.timeoutSeconds,
          historyChars,
          transcriptChars: transcriptChars(transcript())
        });

        tokenInput += response.usage.input;
        tokenOutput += response.usage.output;
        toolStats.iterations += 1;
        const responseContent = snapshotContent(response.content);
        history.appendAssistant(responseContent);
        turns.push({ kind: "assistant", content: snapshotContent(responseContent) });

        if (response.stopReason === "tool_use") {
          const toolResults: ModelContentBlock[] = [];
          for (const toolUse of toolUsesIn(responseContent)) {
            const outcome = await executeToolUse({
              toolUse,
              task,
              tools: this.options.tools,
              mcpAdapter,
              budget,
              guardrails,
              recordLoadedSkill: (name) => {
                if (!loadedSkills.includes(name)) loadedSkills.push(name);
              }
            });
            recordToolStat(toolStats, outcome.statsBucket);
            const shaped = outcome.toolName === "exec" && isExecResult(outcome.result)
              ? await shaper.shapeExecResult({
                workspace: task.workspace,
                toolUseId: toolUse.id,
                input: outcome.input,
                result: outcome.result
              })
              : outcome.isQmdTool && typeof outcome.result === "string"
                ? await shaper.shapeMcpResult({
                  workspace: task.workspace,
                  toolUseId: toolUse.id,
                  toolName: outcome.toolName,
                  input: outcome.input,
                  text: outcome.result,
                  isError: outcome.status === "error"
                })
              : null;
            const serialized = shaped
              ? { raw: shaped.content, bounded: shaped.content }
              : serializeToolResultDetailed(outcome.result);
            const currentHistoryChars = history.serializedChars();
            const currentTranscriptChars = transcriptChars(transcript());
            ledger.recordToolCall({
              toolName: outcome.toolName,
              status: outcome.status,
              latencyMs: outcome.latencyMs,
              rawOutputBytes: shaped?.rawOutputBytes ?? Buffer.byteLength(serialized.raw, "utf8"),
              truncatedOutputBytes: Buffer.byteLength(serialized.bounded, "utf8"),
              artifactBytes: shaped?.artifactBytes,
              summaryBytes: shaped?.summaryBytes,
              returnedToModelBytes: shaped?.returnedToModelBytes ?? Buffer.byteLength(serialized.bounded, "utf8"),
              outputMode: shaped?.outputMode,
              parser: shaped?.parser,
              artifactReference: shaped?.artifactReference,
              fullOutputReason: shaped?.fullOutputReason,
              qmdElapsedMs: outcome.qmdElapsedMs,
              qmdAllowanceUsedMs: outcome.qmdAllowanceUsedMs,
              qmdAllowanceRemainingMs: outcome.qmdAllowanceRemainingMs,
              historyChars: currentHistoryChars,
              transcriptChars: currentTranscriptChars,
              failureSubtype: outcome.failureSubtype
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
          history.appendToolResults(toolResults);
          const postToolCompaction = await compactor.compactIfNeeded({
            history,
            workspace: task.workspace,
            taskGoal: task.prompt
          });
          if (postToolCompaction.transcriptTurn) {
            turns.push(postToolCompaction.transcriptTurn);
          }
          const contextBlock = guardrails.checkContextSize(history.serializedChars());
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
      try { await mcpAdapter.close(); } catch {}
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

}

export function buildSystemPromptForTask(task: Pick<AgentTask, "systemPrompt" | "lessons" | "skillFiles" | "budgetSeconds">): string {
  return renderPromptEnvelope(buildPromptEnvelopeForTask(task));
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

function recordToolStat(stats: ToolStats, bucket: ToolStatsBucket | null | undefined): void {
  if (bucket === "read") stats.readCount += 1;
  if (bucket === "write") stats.writeCount += 1;
  if (bucket === "bash") stats.bashCount += 1;
  if (bucket === "search") stats.searchCount += 1;
}

function isTimeoutError(error: unknown): boolean {
  if (isRuntimeFailureError(error)) return true;
  return isTimeoutLikeError(error);
}

function transcriptChars(transcript: AgentTranscript): number {
  return JSON.stringify(transcript.turns).length;
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
