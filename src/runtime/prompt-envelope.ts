import { createHash } from "node:crypto";
import type { AgentTask } from "../executors/interface";
import { buildStatusReportingPrompt, loadSkillFiles } from "../executors/status-convention";
import type { ModelSystemBlock } from "./model-provider";

export const STABLE_PREFIX_VERSION = "prompt-prefix-v1";

export interface PromptEnvelopeSection {
  name: string;
  text: string;
  stable: boolean;
  cache: boolean;
}

export interface PromptEnvelope {
  stablePrefix: string;
  dynamicContext: string;
  stablePrefixVersion: string;
  stablePrefixHash: string;
  sections: PromptEnvelopeSection[];
}

export function buildPromptEnvelopeForTask(
  task: Pick<AgentTask, "systemPrompt" | "lessons" | "skillFiles" | "budgetSeconds">
): PromptEnvelope {
  const stableSections: PromptEnvelopeSection[] = [];
  if (task.systemPrompt.trim().length > 0) {
    stableSections.push(section("persona", task.systemPrompt, true));
  }
  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    stableSections.push(section("skills", `# Skills\n\n${skillContents}`, true));
  }
  stableSections.push(section("status_contract", buildStatusReportingPrompt(task.budgetSeconds), true));

  const dynamicSections: PromptEnvelopeSection[] = [];
  if (task.lessons && task.lessons.trim().length > 0) {
    dynamicSections.push(section("lessons", task.lessons.trim(), false));
  }

  const stablePrefix = stableSections.map((s) => s.text).join("\n\n");
  const dynamicContext = dynamicSections.map((s) => s.text).join("\n\n");
  return {
    stablePrefix,
    dynamicContext,
    stablePrefixVersion: STABLE_PREFIX_VERSION,
    stablePrefixHash: hashStablePrefix({
      version: STABLE_PREFIX_VERSION,
      sections: stableSections.map(({ name, text }) => ({ name, text }))
    }),
    sections: [...stableSections, ...dynamicSections]
  };
}

export function renderPromptEnvelope(envelope: PromptEnvelope): string {
  return [envelope.stablePrefix, envelope.dynamicContext].filter((part) => part.trim().length > 0).join("\n\n");
}

export function promptEnvelopeSystemBlocks(envelope: PromptEnvelope): ModelSystemBlock[] {
  return envelope.sections.map((part) => ({
    type: "text",
    text: part.text,
    cache: part.cache,
    name: part.name,
    stable: part.stable
  }));
}

function section(name: string, text: string, stable: boolean): PromptEnvelopeSection {
  return { name, text: text.trim(), stable, cache: stable };
}

function hashStablePrefix(input: { version: string; sections: Array<{ name: string; text: string }> }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
