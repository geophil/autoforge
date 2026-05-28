import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../runtime/workspace";

export const STATUS_FILE = ".autoforge-status.json";

export interface AgentStatusFile {
  status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  [key: string]: unknown;
}

export function loadSkillFiles(skillFiles: string[]): string {
  const parts: string[] = [];
  for (const filePath of skillFiles) {
    try {
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath, "utf8").trim());
      }
    } catch {
      // Skip unreadable skill files silently.
    }
  }
  return parts.join("\n\n---\n\n");
}

export function readStatusFile(workingDirectory: string): AgentStatusFile | null {
  const statusPath = join(workingDirectory, STATUS_FILE);
  try {
    if (!existsSync(statusPath)) return null;
    return JSON.parse(readFileSync(statusPath, "utf8")) as AgentStatusFile;
  } catch {
    return null;
  }
}

export async function readStatusFileFromWorkspace(workspace: Workspace): Promise<AgentStatusFile | null> {
  try {
    return JSON.parse(await workspace.readFile(STATUS_FILE)) as AgentStatusFile;
  } catch {
    return null;
  }
}

export function buildStatusReportingContractPrompt(): string {
  return `# Status Reporting (required)

When you have finished the task you MUST write \`${STATUS_FILE}\` in the working directory with this exact JSON format:

\`\`\`json
{
  "status": "DONE",
  "artifacts": ["relative/path/to/changed/file1", "relative/path/to/changed/file2"]
}
\`\`\`

Valid status values:
- **"DONE"** — completed successfully, all criteria met
- **"DONE_WITH_CONCERNS"** — completed but add a "concerns" field explaining what was imperfect
- **"BLOCKED"** — cannot proceed; add a "blockReason" field with a clear explanation
- **"NEEDS_CONTEXT"** — missing information; add a "blockReason" field specifying what is needed`;
}

export function buildRuntimeBudgetPrompt(budgetSeconds: number): string {
  return `# Runtime Budget

Time budget: ${budgetSeconds} seconds. Work efficiently.`;
}

export function buildStatusReportingPrompt(budgetSeconds: number): string {
  return `${buildStatusReportingContractPrompt()}\n\n${buildRuntimeBudgetPrompt(budgetSeconds)}`;
}
