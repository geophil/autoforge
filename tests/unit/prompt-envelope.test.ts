import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromptEnvelopeForTask,
  promptEnvelopeSystemBlocks,
  renderPromptEnvelope
} from "../../src/runtime/prompt-envelope";

describe("PromptEnvelope", () => {
  test("keeps stable-prefix hash deterministic across volatile task context", () => {
    const base = buildPromptEnvelopeForTask({
      systemPrompt: "You are coder.",
      lessons: "Lesson from recent task.",
      skillFiles: [],
      budgetSeconds: 60
    });
    const changedDynamic = buildPromptEnvelopeForTask({
      systemPrompt: "You are coder.",
      lessons: "Different task-derived lesson, timestamp 2026-05-28, run id abc.",
      skillFiles: [],
      budgetSeconds: 60
    });

    expect(changedDynamic.stablePrefixHash).toBe(base.stablePrefixHash);
    expect(renderPromptEnvelope(changedDynamic)).toContain("Different task-derived lesson");
  });

  test("changes stable-prefix hash when stable instructions change", () => {
    const base = buildPromptEnvelopeForTask({
      systemPrompt: "You are coder.",
      skillFiles: [],
      budgetSeconds: 60
    });
    const changed = buildPromptEnvelopeForTask({
      systemPrompt: "You are reviewer.",
      skillFiles: [],
      budgetSeconds: 60
    });

    expect(changed.stablePrefixHash).not.toBe(base.stablePrefixHash);
  });

  test("renders stable sections before dynamic context and cache hints only stable blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-envelope-test-"));
    const skillPath = join(dir, "skill.md");
    writeFileSync(skillPath, "Stable skill content");
    const envelope = buildPromptEnvelopeForTask({
      systemPrompt: "Persona",
      lessons: "Dynamic lesson",
      skillFiles: [skillPath],
      budgetSeconds: 60
    });
    const rendered = renderPromptEnvelope(envelope);

    expect(rendered.indexOf("Persona")).toBeLessThan(rendered.indexOf("Dynamic lesson"));
    expect(rendered.indexOf("# Skills")).toBeLessThan(rendered.indexOf("Dynamic lesson"));
    expect(promptEnvelopeSystemBlocks(envelope)).toEqual([
      expect.objectContaining({ text: "Persona", cache: true, stable: true }),
      expect.objectContaining({ text: "# Skills\n\nStable skill content", cache: true, stable: true }),
      expect.objectContaining({ cache: true, stable: true, name: "status_contract" }),
      expect.objectContaining({ text: "Dynamic lesson", cache: false, stable: false })
    ]);
  });
});
