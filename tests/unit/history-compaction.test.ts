import { describe, expect, test } from "bun:test";
import { ConversationHistory } from "../../src/runtime/conversation-history";
import { HistoryCompactor } from "../../src/runtime/history-compactor";
import { UtilityModelCaller } from "../../src/runtime/utility-model-caller";
import { TelemetryLedger } from "../../src/executors/telemetry";
import { MockWorkspace } from "../../src/runtime/mock-workspace";
import type { ModelProvider, ModelResponse } from "../../src/runtime/model-provider";

class ScriptedProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly supportedModels = ["cheap-model"];
  readonly calls: Array<Parameters<ModelProvider["message"]>[0]> = [];

  constructor(private readonly responses: Array<ModelResponse | Error>) {}

  async message(args: Parameters<ModelProvider["message"]>[0]): Promise<ModelResponse> {
    this.calls.push(args);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    return response;
  }
}

class ArtifactWriteFailingWorkspace extends MockWorkspace {
  async writeFile(path: string, content: string): Promise<void> {
    if (path.startsWith(".autoforge/history-compactions/")) {
      throw new Error("history artifact write failed");
    }
    return super.writeFile(path, content);
  }
}

describe("ConversationHistory", () => {
  test("compacts only old complete exchanges and preserves recent messages", () => {
    const history = new ConversationHistory("do work");
    history.appendAssistant([{ type: "tool_use", id: "t1", name: "read_file", input: {} }]);
    history.appendToolResults([{ type: "tool_result", tool_use_id: "t1", content: "old result" }]);
    history.appendAssistant([{ type: "tool_use", id: "t2", name: "exec", input: {} }]);
    history.appendToolResults([{ type: "tool_result", tool_use_id: "t2", content: "recent result" }]);

    const slice = history.compactableSlice(2);
    expect(slice?.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "old result" }] }
    ]);

    history.replaceCompactableSlice(slice!, "compact memory");
    const snapshot = history.snapshot();
    expect(JSON.stringify(snapshot[0])).toContain("compact memory");
    expect(snapshot.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t2", name: "exec", input: {} }]
    });
    expect(snapshot.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "recent result" }]
    });
  });
});

describe("HistoryCompactor", () => {
  test("uses the cheap utility model and stores raw history on successful compaction", async () => {
    const provider = new ScriptedProvider([{
      stopReason: "end_turn",
      content: [{
        type: "text",
        text: JSON.stringify({
          taskGoal: "do work",
          constraints: ["keep tests passing"],
          keyDecisions: ["read src/a.ts"],
          filesInspected: ["src/a.ts"],
          filesChanged: [],
          commandsRun: ["bun test"],
          failedAttempts: [],
          knownErrors: [],
          unresolvedQuestions: [],
          artifactRefs: [],
          recommendedNextAction: "continue",
          rawHistoryArtifact: ".autoforge/history-compactions/test.json"
        })
      }],
      usage: { input: 20, output: 10 }
    }]);
    const ledger = new TelemetryLedger();
    const history = longHistory();
    const workspace = new MockWorkspace({ id: "workspace-compaction" });
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: "standard-model",
      MODEL_TIER_CHEAP: "cheap-model",
      contextMaxChars: 500,
      compactionTriggerRatio: 0.1,
      compactionRetainRecentMessages: 2
    }, new UtilityModelCaller(provider, ledger, "coder"), ledger);

    const result = await compactor.compactIfNeeded({ history, workspace, taskGoal: "do work" });

    expect(result.compacted).toBe(true);
    expect(provider.calls[0]).toMatchObject({
      model: "cheap-model",
      tools: [],
      maxTokens: 1200,
      timeoutSeconds: 30
    });
    expect(result.transcriptTurn?.usedFallback).toBe(false);
    expect(ledger.getEvents().compactions).toHaveLength(1);
    const artifact = ledger.getEvents().compactions[0].rawHistoryArtifact;
    expect(await workspace.readFile(artifact)).toContain("old output");
    expect(JSON.stringify(history.snapshot())).toContain("Compact Prior Context");
  });

  test("falls back deterministically when utility model output is invalid", async () => {
    const provider = new ScriptedProvider([{
      stopReason: "end_turn",
      content: [{ type: "text", text: "not json" }],
      usage: { input: 5, output: 2 }
    }]);
    const ledger = new TelemetryLedger();
    const history = longHistory();
    const workspace = new MockWorkspace({ id: "workspace-compaction-fallback" });
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: "standard-model",
      MODEL_TIER_CHEAP: "cheap-model",
      contextMaxChars: 500,
      compactionTriggerRatio: 0.1,
      compactionRetainRecentMessages: 2
    }, new UtilityModelCaller(provider, ledger, "coder"), ledger);

    const result = await compactor.compactIfNeeded({ history, workspace, taskGoal: "do work" });

    expect(result.compacted).toBe(true);
    expect(result.transcriptTurn?.usedFallback).toBe(true);
    expect(ledger.getEvents().compactions[0]).toMatchObject({
      status: "fallback",
      usedFallback: true,
      failureSubtype: "compaction_invalid_json"
    });
    expect(JSON.stringify(history.snapshot())).toContain("Read the raw history artifact");
  });

  test("falls back deterministically when utility model throws", async () => {
    const provider = new ScriptedProvider([new Error("offline")]);
    const ledger = new TelemetryLedger();
    const history = longHistory();
    const workspace = new MockWorkspace({ id: "workspace-compaction-error" });
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: "standard-model",
      MODEL_TIER_CHEAP: "cheap-model",
      contextMaxChars: 500,
      compactionTriggerRatio: 0.1,
      compactionRetainRecentMessages: 2
    }, new UtilityModelCaller(provider, ledger, "coder"), ledger);

    await compactor.compactIfNeeded({ history, workspace, taskGoal: "do work" });

    expect(ledger.getEvents().models[0]).toMatchObject({
      purpose: "compaction",
      failureSubtype: "utility_model_call_failed"
    });
    expect(ledger.getEvents().compactions[0].status).toBe("fallback");
  });

  test("falls back deterministically when utility model times out", async () => {
    const timeout = new Error("compaction timed out");
    timeout.name = "AbortError";
    const provider = new ScriptedProvider([timeout]);
    const ledger = new TelemetryLedger();
    const history = longHistory();
    const workspace = new MockWorkspace({ id: "workspace-compaction-timeout" });
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: "standard-model",
      MODEL_TIER_CHEAP: "cheap-model",
      contextMaxChars: 500,
      compactionTriggerRatio: 0.1,
      compactionRetainRecentMessages: 2
    }, new UtilityModelCaller(provider, ledger, "coder"), ledger);

    await compactor.compactIfNeeded({ history, workspace, taskGoal: "do work" });

    expect(ledger.getEvents().models[0]).toMatchObject({
      purpose: "compaction",
      failureSubtype: "utility_model_call_timeout"
    });
    expect(ledger.getEvents().compactions[0]).toMatchObject({
      status: "fallback",
      failureSubtype: "compaction_model_timeout"
    });
  });

  test("does not fail the run when raw history artifact storage fails", async () => {
    const provider = new ScriptedProvider([]);
    const ledger = new TelemetryLedger();
    const history = longHistory();
    const workspace = new ArtifactWriteFailingWorkspace({ id: "workspace-compaction-artifact-failure" });
    const compactor = new HistoryCompactor({
      ANTHROPIC_MODEL: "standard-model",
      MODEL_TIER_CHEAP: "cheap-model",
      contextMaxChars: 500,
      compactionTriggerRatio: 0.1,
      compactionRetainRecentMessages: 2
    }, new UtilityModelCaller(provider, ledger, "coder"), ledger);

    const result = await compactor.compactIfNeeded({ history, workspace, taskGoal: "do work" });

    expect(result.compacted).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(ledger.getEvents().compactions).toHaveLength(0);
    expect(JSON.stringify(history.snapshot())).not.toContain("Compact Prior Context");
  });
});

function longHistory(): ConversationHistory {
  const history = new ConversationHistory("do work in src/a.ts");
  for (let i = 0; i < 8; i++) {
    history.appendAssistant([{ type: "tool_use", id: `tool-${i}`, name: "exec", input: { cmd: "bun", args: ["test"] } }]);
    history.appendToolResults([{
      type: "tool_result",
      tool_use_id: `tool-${i}`,
      content: `old output ${i} from src/a.ts\nError line ${i}\n${"x".repeat(200)}`
    }]);
  }
  return history;
}
