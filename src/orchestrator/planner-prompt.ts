import type { PlanSubtask, PlannerRequestedPhase, PlannerSpecArtifacts, Tier } from "../types/core";

const APPROVED_SPEC_CHAR_CAP_INITIAL = 3600;
const APPROVED_SPEC_CHAR_CAP_RETRY = 1600;
const RETRY_PLAN_CHAR_CAP = 2200;
const RETRY_SPEC_CHAR_CAP = 2200;

export const PLANNER_RETRY_PROMPT_TOKEN_CAP = 4500;

export function buildPlannerPrompt(params: {
  description: string;
  tier: Tier;
  phase: PlannerRequestedPhase;
  transcriptAttemptIndex: number;
  priorPlan?: PlanSubtask[];
  approvedSpec?: PlannerSpecArtifacts | null;
  priorSpecArtifacts?: PlannerSpecArtifacts | null;
  critique: string | null;
  currentBlockingQuestion?: string | null;
}): string {
  const lines: string[] = [];
  lines.push("## Phase");
  lines.push(params.phase);
  lines.push("");
  lines.push("## Task");
  lines.push(params.description);
  lines.push("");
  lines.push("## Constraints");
  lines.push(`Tier: ${params.tier}`);
  lines.push(
    "If QMD is configured (QMD_MCP_URL present), use it first and emit planningContext.qmdContext evidence in .autoforge-status.json."
  );

  if (params.phase === "execution_plan" && params.approvedSpec) {
    lines.push("");
    lines.push("## Approved Spec");
    lines.push(
      renderApprovedSpecForPrompt(
        params.approvedSpec,
        params.transcriptAttemptIndex > 0 ? APPROVED_SPEC_CHAR_CAP_RETRY : APPROVED_SPEC_CHAR_CAP_INITIAL
      )
    );
  }

  const attempt = params.transcriptAttemptIndex;
  const crit = params.critique?.trim() ?? "";

  if (params.phase === "execution_plan" && attempt > 0 && params.priorPlan && crit.length > 0) {
    lines.push("");
    lines.push(`## Prior plan (attempt ${attempt - 1})`);
    lines.push(compactJson(params.priorPlan, RETRY_PLAN_CHAR_CAP));
    lines.push("");
    lines.push("## Human feedback on prior plan");
    lines.push(crit);
    lines.push("");
    lines.push("## Instructions");
    lines.push("Revise the plan to address feedback with minimal, targeted changes.");
    return lines.join("\n");
  }

  if (params.phase === "spec" && attempt > 0 && params.priorSpecArtifacts && crit.length > 0) {
    lines.push("");
    lines.push(`## Prior discovery/spec (attempt ${attempt - 1})`);
    lines.push(compactJson(params.priorSpecArtifacts, RETRY_SPEC_CHAR_CAP));
    lines.push("");
    if (params.currentBlockingQuestion && params.currentBlockingQuestion.trim()) {
      lines.push("## Operator Answer To Question");
      lines.push(`> Q: ${params.currentBlockingQuestion}`);
      lines.push("");
      lines.push("A:");
      lines.push(crit);
    } else {
      lines.push("## Operator Critique");
      lines.push(crit);
    }
    lines.push("");
    lines.push("## Instructions");
    lines.push("Revise discovery/spec to address feedback while preserving validated intent.");
    return lines.join("\n");
  }

  return lines.join("\n");
}

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function retryPromptExceedsTokenCap(prompt: string, cap: number = PLANNER_RETRY_PROMPT_TOKEN_CAP): boolean {
  return estimatePromptTokens(prompt) > cap;
}

function renderApprovedSpecForPrompt(spec: PlannerSpecArtifacts, charCap: number): string {
  const full = compactJson(spec, charCap);
  if (full.length <= charCap) return full;
  return `${full.slice(0, Math.max(0, charCap - 42)).trimEnd()}\n... (compacted approved spec)`;
}

function compactJson(value: unknown, charCap: number): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= charCap) return json;
  return `${json.slice(0, Math.max(0, charCap - 28)).trimEnd()}\n... (compacted)`;
}
