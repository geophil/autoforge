import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicSdkExecutor } from "../../src/executors/anthropic-sdk";
import { LocalWorkspace } from "../../src/runtime/local-workspace";

function workspace(rootPath: string): LocalWorkspace {
  return new LocalWorkspace({ rootPath, taskId: "test-task", dispatchId: "test-dispatch" });
}

function snapshotMessages(messages: unknown): Array<{ role: string; content: unknown }> {
  return JSON.parse(JSON.stringify(messages ?? [])) as Array<{ role: string; content: unknown }>;
}

function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_use");
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result");
}

function assertNoOrphanedToolPairs(messages: Array<{ role: string; content: unknown }>): void {
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant" || !hasToolUse(current.content)) continue;
    const next = messages[i + 1];
    expect(next).toBeDefined();
    expect(next.role).toBe("user");
    expect(hasToolResult(next.content)).toBe(true);
  }
}

describe("SDK compaction", () => {
  test("compacts by token budget and preserves tool-use/tool-result pairing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cmp-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const snapshots: Array<Array<{ role: string; content: unknown }>> = [];
    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testSummarize?: (input: { model: string; text: string }) => Promise<string> })
      ._testSummarize = async ({ text }) => `summary: ${text.slice(0, 120)}`;
    let calls = 0;
    (exec as unknown as { _testCreate?: (opts: { messages: unknown }) => Promise<unknown> })._testCreate = async (opts) => {
      snapshots.push(snapshotMessages(opts.messages));
      calls += 1;
      if (calls <= 4) {
        return {
          usage: { input_tokens: 80_000, output_tokens: 10 },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `tu_${calls}`, name: "read_file", input: { path: "hello.txt" } }]
        };
      }
      return {
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      };
    };

    const result = await exec.execute({
      id: "cmp-a", type: "planner", systemPrompt: "p", prompt: "u",
      workspace: workspace(dir), budgetSeconds: 60, environment: {}, skillFiles: []
    });

    for (const snapshot of snapshots) {
      assertNoOrphanedToolPairs(snapshot);
    }

    const compaction = result.transcript?.turns.find((turn) => turn.kind === "compaction");
    expect(compaction).toBeDefined();
    if (compaction && compaction.kind === "compaction") {
      expect(compaction.droppedTurns).toBeGreaterThan(0);
      expect(compaction.triggerInputTokens).toBeGreaterThan(0);
      expect(compaction.summaryInputCharCount).toBeGreaterThan(0);
      expect(compaction.summaryOutputCharCount).toBeGreaterThan(0);
      expect(compaction.summaryModel).toBe("claude-haiku-4");
      expect(compaction.usedFallback).toBe(false);
    }
  });

  test("preserves parallel tool-use/tool-result pairs across compaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cmp-parallel-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, "alt.txt"), "alt");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const snapshots: Array<Array<{ role: string; content: unknown }>> = [];
    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testSummarize?: (input: { model: string; text: string }) => Promise<string> })
      ._testSummarize = async ({ text }) => `summary: ${text.slice(0, 120)}`;
    let calls = 0;
    (exec as unknown as { _testCreate?: (opts: { messages: unknown }) => Promise<unknown> })._testCreate = async (opts) => {
      snapshots.push(snapshotMessages(opts.messages));
      calls += 1;
      if (calls <= 4) {
        return {
          usage: { input_tokens: 80_000, output_tokens: 10 },
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: `tu_${calls}_a`, name: "read_file", input: { path: "hello.txt" } },
            { type: "tool_use", id: `tu_${calls}_b`, name: "read_file", input: { path: "alt.txt" } },
            { type: "tool_use", id: `tu_${calls}_c`, name: "list_directory", input: { path: "." } }
          ]
        };
      }
      return {
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      };
    };

    const result = await exec.execute({
      id: "cmp-parallel", type: "planner", systemPrompt: "p", prompt: "u",
      workspace: workspace(dir), budgetSeconds: 60, environment: {}, skillFiles: []
    });

    for (const snapshot of snapshots) {
      assertNoOrphanedToolPairs(snapshot);
      // Every assistant message with >1 tool_use must be followed by a user
      // message whose tool_result ids cover all the tool_use ids in the same
      // group — never a partial split.
      for (let i = 0; i < snapshot.length; i++) {
        const current = snapshot[i];
        if (current.role !== "assistant" || !Array.isArray(current.content)) continue;
        const toolUseIds = (current.content as Array<{ type: string; id?: string }>)
          .filter((b) => b.type === "tool_use")
          .map((b) => b.id!);
        if (toolUseIds.length === 0) continue;
        const next = snapshot[i + 1];
        expect(next).toBeDefined();
        const resultIds = (next.content as Array<{ type: string; tool_use_id?: string }>)
          .filter((b) => b.type === "tool_result")
          .map((b) => b.tool_use_id!);
        for (const id of toolUseIds) {
          expect(resultIds).toContain(id);
        }
      }
    }

    const compaction = result.transcript?.turns.find((turn) => turn.kind === "compaction");
    expect(compaction).toBeDefined();
    if (compaction && compaction.kind === "compaction") {
      expect(compaction.droppedTurns).toBeGreaterThan(0);
    }
  });

  test("falls back to bounded extractive memory when summarizer fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-cmp-fallback-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testSummarize?: (input: { model: string; text: string }) => Promise<string> })
      ._testSummarize = async () => {
        throw new Error("synthetic summarizer failure");
      };
    let calls = 0;
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => {
      calls += 1;
      if (calls <= 4) {
        return {
          usage: { input_tokens: 80_000, output_tokens: 10 },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `tu_${calls}`, name: "read_file", input: { path: "hello.txt" } }]
        };
      }
      return {
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      };
    };

    const result = await exec.execute({
      id: "cmp-b", type: "planner", systemPrompt: "p", prompt: "u",
      workspace: workspace(dir), budgetSeconds: 60, environment: {}, skillFiles: []
    });

    const compaction = result.transcript?.turns.find((turn) => turn.kind === "compaction");
    expect(compaction).toBeDefined();
    if (compaction && compaction.kind === "compaction") {
      expect(compaction.usedFallback).toBe(true);
      expect(compaction.summaryModel).toBeNull();
      expect(compaction.summaryOutputCharCount).toBeLessThanOrEqual(8 * 1024);
    }
  });
});
