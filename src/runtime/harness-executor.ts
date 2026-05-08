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

const DEFAULT_MAX_TOKENS = 8192;
const MAX_TOOL_ITERATIONS = 50;

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
    const systemPrompt = buildSystemPrompt(task);
    const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: task.prompt }] }];
    const turns: AgentTranscriptTurn[] = [];
    const loadedSkills: string[] = [];
    const toolStats: ToolStats = { readCount: 0, writeCount: 0, bashCount: 0, searchCount: 0, iterations: 0 };
    let tokenInput = 0;
    let tokenOutput = 0;

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
          return timeoutResult(start, tokenInput, tokenOutput, toolStats, transcript());
        }

        const response = await this.options.provider.message({
          model: task.model ?? this.options.defaultModel,
          systemPrompt,
          history: snapshotHistory(history),
          tools: this.options.tools.definitions(),
          maxTokens: DEFAULT_MAX_TOKENS,
          timeoutSeconds: remainingMs / 1000
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
            let toolStarted = false;
            let result: unknown;
            try {
              tool = this.options.tools.get(toolUse.name);
              const toolRemainingMs = deadlineMs - Date.now();
              if (toolRemainingMs <= 0) {
                const error = new Error("Task budget exhausted before tool execution");
                error.name = "AbortError";
                throw error;
              }
              toolStarted = true;
              result = await tool.execute(toolUse.input, task.workspace, {
                environment: task.environment,
                deadlineMs,
                timeoutSeconds: toolRemainingMs / 1000,
                recordLoadedSkill: (name) => {
                  if (!loadedSkills.includes(name)) loadedSkills.push(name);
                }
              });
            } catch (error) {
              if (isTimeoutError(error)) throw error;
              result = error instanceof Error ? error : new Error(String(error));
            } finally {
              if (tool && toolStarted) recordToolStat(toolStats, statsBucketForTool(tool));
            }
            const serialized = serializeToolResult(result);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: serialized
            });
            turns.push({
              kind: "tool_result",
              toolUseId: toolUse.id,
              content: serialized
            });
          }
          history.push({ role: "user", content: toolResults });
          continue;
        }

        if (response.stopReason === "error") {
          throw new Error("Model provider returned error stop reason");
        }

        if (isTerminalStop(response.stopReason)) {
          return await finalize(task, start, tokenInput, tokenOutput, toolStats, transcript());
        }
      }

      return {
        status: "FAILED",
        artifacts: [],
        blockReason: `Exceeded maximum harness iterations (${MAX_TOOL_ITERATIONS})`,
        metrics: elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
        transcript: transcript()
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        return timeoutResult(start, tokenInput, tokenOutput, toolStats, transcript());
      }
      const message = error instanceof Error ? error.message : String(error);
      turns.push({
        kind: "error",
        name: error instanceof Error ? error.name : "UnknownError",
        message,
        stack: error instanceof Error ? error.stack : undefined
      });
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: message,
        metrics: elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
        transcript: transcript()
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function buildSystemPrompt(task: AgentTask): string {
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

function serializeToolResult(result: unknown): string {
  if (result === undefined || result === null) return "(empty result)";
  if (typeof result === "string") return result;
  if (result instanceof Error) return `Error: ${result.message}`;
  try {
    const json = JSON.stringify(result);
    return typeof json === "string" ? json : "[unserializable tool result]";
  } catch (error) {
    void error;
    return "[unserializable tool result]";
  }
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
  transcript: AgentTranscript
): Promise<AgentResult> {
  const statusFile = await readStatusFileFromWorkspace(task.workspace);
  if (!statusFile) {
    return {
      status: "DONE_WITH_CONCERNS",
      artifacts: [],
      concerns: "Agent did not write .autoforge-status.json",
      metrics: elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
      transcript
    };
  }
  return {
    status: statusFile.status,
    artifacts: statusFile.artifacts,
    concerns: statusFile.concerns,
    blockReason: statusFile.blockReason,
    output: statusFile,
    metrics: elapsedMetrics(start, tokenInput, tokenOutput, toolStats),
    transcript
  };
}

function timeoutResult(
  start: number,
  tokenInput: number,
  tokenOutput: number,
  toolStats: ToolStats,
  transcript: AgentTranscript
): AgentResult {
  return {
    status: "TIMEOUT",
    artifacts: [],
    metrics: {
      elapsedSeconds: (Date.now() - start) / 1000,
      tokenInput,
      tokenOutput,
      toolStats
    },
    transcript
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
