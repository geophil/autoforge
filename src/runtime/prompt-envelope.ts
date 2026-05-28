import { createHash } from "node:crypto";
import type { AgentTask } from "../executors/interface";
import {
  buildRuntimeBudgetPrompt,
  buildStatusReportingContractPrompt,
  loadSkillFiles
} from "../executors/status-convention";
import type { ModelSystemBlock } from "./model-provider";

export const STABLE_PREFIX_VERSION = "prompt-prefix-v2";

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
    stableSections.push(stableSection("persona", task.systemPrompt));
  }
  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    stableSections.push(stableSection("skills", `# Skills\n\n${skillContents}`));
  }
  stableSections.push(stableSection("status_contract", buildStatusReportingContractPrompt()));

  const dynamicSections: PromptEnvelopeSection[] = [];
  dynamicSections.push(dynamicSection("runtime_budget", buildRuntimeBudgetPrompt(task.budgetSeconds)));
  if (task.lessons && task.lessons.trim().length > 0) {
    dynamicSections.push(dynamicSection("lessons", task.lessons.trim()));
  }

  const stablePrefix = joinSectionText(stableSections);
  const dynamicContext = joinSectionText(dynamicSections);
  return {
    stablePrefix,
    dynamicContext,
    stablePrefixVersion: STABLE_PREFIX_VERSION,
    stablePrefixHash: hashStablePrefix(STABLE_PREFIX_VERSION, stableSections),
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

function stableSection(name: string, text: string): PromptEnvelopeSection {
  return section(name, text, true);
}

function dynamicSection(name: string, text: string): PromptEnvelopeSection {
  return section(name, text, false);
}

function section(name: string, text: string, stable: boolean): PromptEnvelopeSection {
  return { name, text: text.trim(), stable, cache: stable };
}

function joinSectionText(sections: PromptEnvelopeSection[]): string {
  return sections.map((s) => s.text).join("\n\n");
}

function hashStablePrefix(version: string, sections: PromptEnvelopeSection[]): string {
  return createHash("sha256").update(JSON.stringify({
    version,
    sections: sections.map(({ name, text }) => ({ name, text }))
  })).digest("hex");
}
