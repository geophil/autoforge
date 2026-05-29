import { randomUUID } from "node:crypto";
import type { AgentTranscriptTurn } from "../executors/interface";
import type { TelemetryLedger } from "../executors/telemetry";
import type { ModelSelectionConfig } from "./model-selection";
import { selectUtilityModel } from "./model-selection";
import type { ModelMessage } from "./model-provider";
import type { Workspace } from "./workspace";
import { ConversationHistory } from "./conversation-history";
import { UtilityModelCaller } from "./utility-model-caller";
import { isTimeoutLikeError } from "./runtime-failure-classifier";

const DEFAULT_TRIGGER_RATIO = 0.75;
const DEFAULT_RETAIN_RECENT_MESSAGES = 6;
const HISTORY_COMPACTION_DIR = ".autoforge/history-compactions";

export interface CompactState {
  taskGoal: string;
  constraints: string[];
  keyDecisions: string[];
  filesInspected: string[];
  filesChanged: string[];
  commandsRun: string[];
  failedAttempts: string[];
  knownErrors: string[];
  unresolvedQuestions: string[];
  artifactRefs: string[];
  recommendedNextAction: string;
  rawHistoryArtifact: string;
}

export interface HistoryCompactionResult {
  compacted: boolean;
  transcriptTurn?: Extract<AgentTranscriptTurn, { kind: "compaction" }>;
}

export class HistoryCompactor {
  constructor(
    private readonly config: ModelSelectionConfig & {
      contextMaxChars?: number;
      compactionTriggerRatio?: number;
      compactionRetainRecentMessages?: number;
    },
    private readonly caller: UtilityModelCaller,
    private readonly ledger: TelemetryLedger
  ) {}

  async compactIfNeeded(args: {
    history: ConversationHistory;
    workspace: Workspace;
    taskGoal: string;
  }): Promise<HistoryCompactionResult> {
    try {
      return await this.compact(args);
    } catch {
      return { compacted: false };
    }
  }

  private async compact(args: {
    history: ConversationHistory;
    workspace: Workspace;
    taskGoal: string;
  }): Promise<HistoryCompactionResult> {
    const preHistoryChars = args.history.serializedChars();
    const maxChars = this.config.contextMaxChars ?? 120_000;
    const triggerRatio = this.config.compactionTriggerRatio ?? DEFAULT_TRIGGER_RATIO;
    if (preHistoryChars < maxChars * triggerRatio) {
      return { compacted: false };
    }

    const retainRecentTurns = this.config.compactionRetainRecentMessages ?? DEFAULT_RETAIN_RECENT_MESSAGES;
    const slice = args.history.compactableSlice(retainRecentTurns);
    if (!slice) return { compacted: false };

    const selection = { ...selectUtilityModel(this.config, "compaction"), purpose: "compaction" as const };
    const rawHistoryArtifact = `${HISTORY_COMPACTION_DIR}/${randomUUID()}.json`;
    const rawHistory = JSON.stringify({
      taskGoal: args.taskGoal,
      compactedAt: new Date().toISOString(),
      messages: slice.messages
    }, null, 2);
    await args.workspace.writeFile(".autoforge/.gitignore", "*\n");
    await args.workspace.writeFile(rawHistoryArtifact, rawHistory);

    const startedAt = Date.now();
    let state: CompactState;
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCost = 0;
    let latencyMs = 0;
    let usedFallback = false;
    let failureSubtype: string | undefined;
    try {
      const call = await this.caller.call({
        selection,
        prompt: buildCompactionPrompt({
          taskGoal: args.taskGoal,
          rawHistoryArtifact,
          messages: slice.messages
        })
      });
      inputTokens = call.inputTokens;
      outputTokens = call.outputTokens;
      estimatedCost = call.estimatedCost;
      latencyMs = call.latencyMs;
      state = parseCompactState(call.text, rawHistoryArtifact);
    } catch (error) {
      usedFallback = true;
      failureSubtype = error instanceof SyntaxError
        ? "compaction_invalid_json"
        : isTimeoutLikeError(error)
          ? "compaction_model_timeout"
          : "compaction_model_failed";
      latencyMs = Date.now() - startedAt;
      state = fallbackCompactState(args.taskGoal, rawHistoryArtifact, slice.messages);
    }

    const compactMemory = renderCompactMemory(state);
    args.history.replaceCompactableSlice(slice, compactMemory);
    const postHistoryChars = args.history.serializedChars();
    const summaryOutputCharCount = compactMemory.length;
    const summaryInputCharCount = rawHistory.length;
    this.ledger.recordCompaction({
      purpose: "compaction",
      provider: this.caller.providerName,
      model: selection.model,
      status: usedFallback ? "fallback" : "success",
      latencyMs,
      timestamp: startedAt,
      inputTokens,
      outputTokens,
      estimatedCost,
      preHistoryChars,
      postHistoryChars,
      droppedTurns: slice.droppedTurns,
      retainedRecentTurns: slice.retainedRecentTurns,
      summaryInputCharCount,
      summaryOutputCharCount,
      rawHistoryArtifact,
      usedFallback,
      failureSubtype
    });
    return {
      compacted: true,
      transcriptTurn: {
        kind: "compaction",
        droppedTurns: slice.droppedTurns,
        retainedRecentTurns: slice.retainedRecentTurns,
        triggerInputTokens: Math.ceil(preHistoryChars / 4),
        summaryInputCharCount,
        summaryOutputCharCount,
        summaryModel: selection.model,
        usedFallback,
        preHistoryChars,
        postHistoryChars,
        rawHistoryArtifact
      }
    };
  }
}

function buildCompactionPrompt(input: {
  taskGoal: string;
  rawHistoryArtifact: string;
  messages: ModelMessage[];
}): string {
  return [
    "Compact this Autoforge agent history into strict JSON with these keys:",
    "taskGoal, constraints, keyDecisions, filesInspected, filesChanged, commandsRun, failedAttempts, knownErrors, unresolvedQuestions, artifactRefs, recommendedNextAction, rawHistoryArtifact.",
    "Use arrays of strings except taskGoal, recommendedNextAction, and rawHistoryArtifact.",
    "Preserve implementation-critical details and known errors. Do not invent facts.",
    `rawHistoryArtifact: ${input.rawHistoryArtifact}`,
    `taskGoal: ${input.taskGoal}`,
    "messages:",
    JSON.stringify(input.messages)
  ].join("\n\n");
}

function parseCompactState(text: string, rawHistoryArtifact: string): CompactState {
  const parsed = JSON.parse(stripCodeFence(text)) as Partial<CompactState>;
  return {
    taskGoal: stringValue(parsed.taskGoal),
    constraints: stringArray(parsed.constraints),
    keyDecisions: stringArray(parsed.keyDecisions),
    filesInspected: stringArray(parsed.filesInspected),
    filesChanged: stringArray(parsed.filesChanged),
    commandsRun: stringArray(parsed.commandsRun),
    failedAttempts: stringArray(parsed.failedAttempts),
    knownErrors: stringArray(parsed.knownErrors),
    unresolvedQuestions: stringArray(parsed.unresolvedQuestions),
    artifactRefs: stringArray(parsed.artifactRefs),
    recommendedNextAction: stringValue(parsed.recommendedNextAction),
    rawHistoryArtifact: stringValue(parsed.rawHistoryArtifact) || rawHistoryArtifact
  };
}

function fallbackCompactState(taskGoal: string, rawHistoryArtifact: string, messages: ModelMessage[]): CompactState {
  const text = JSON.stringify(messages);
  return {
    taskGoal,
    constraints: [],
    keyDecisions: importantLines(text, /(decid|chosen|because|therefore)/i),
    filesInspected: uniqueMatches(text, /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g),
    filesChanged: uniqueMatches(text, /(?:write_file|edited|changed|modified).*?((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g),
    commandsRun: importantLines(text, /(bun|npm|git|tsc|test|lint)/i),
    failedAttempts: importantLines(text, /(failed|failure|exitCode|timeout|error)/i),
    knownErrors: importantLines(text, /(error|exception|failed|timeout|stderr)/i),
    unresolvedQuestions: importantLines(text, /\?/),
    artifactRefs: uniqueMatches(text, /\.autoforge\/tool-results\/[A-Za-z0-9._/-]+\.json/g),
    recommendedNextAction: "Continue from the retained recent history. Read the raw history artifact if missing context is needed.",
    rawHistoryArtifact
  };
}

function renderCompactMemory(state: CompactState): string {
  return [
    "## Compact Prior Context",
    JSON.stringify(state, null, 2),
    "",
    `Full dropped history is available at ${state.rawHistoryArtifact}.`
  ].join("\n");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueMatches(text: string, regex: RegExp): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(regex)) {
    out.add(match[1] ?? match[0]);
  }
  return [...out].slice(0, 20);
}

function importantLines(text: string, pattern: RegExp): string[] {
  return text
    .split(/\\n|\n/)
    .filter((line) => pattern.test(line))
    .map((line) => line.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 12);
}
