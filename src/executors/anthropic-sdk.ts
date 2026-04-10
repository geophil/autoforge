import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentExecutor, AgentResult, AgentTask } from "./interface";

const STATUS_FILE = ".autoforge-status.json";
const MAX_TOOL_ITERATIONS = 50;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        content: { type: "string", description: "Full file content to write." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory. Use '.' for root." }
      },
      required: ["path"]
    }
  },
  {
    name: "bash",
    description: "Run a shell command in the working directory. Prefer read_file/write_file for file operations.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." }
      },
      required: ["command"]
    }
  }
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function executeTool(name: string, input: Record<string, string>, cwd: string): string {
  try {
    switch (name) {
      case "read_file": {
        const abs = resolve(cwd, input.path);
        if (!existsSync(abs)) return `Error: file not found: ${input.path}`;
        return readFileSync(abs, "utf8");
      }
      case "write_file": {
        const abs = resolve(cwd, input.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.content, "utf8");
        return `Written: ${input.path}`;
      }
      case "list_directory": {
        const abs = resolve(cwd, input.path);
        if (!existsSync(abs)) return `Error: directory not found: ${input.path}`;
        return readdirSync(abs, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
      }
      case "bash": {
        const result = spawnSync("bash", ["-c", input.command], {
          cwd,
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return out || `(exit ${result.status ?? "signal"})`;
      }
      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class AnthropicSdkExecutor implements AgentExecutor {
  readonly name = "anthropic-sdk";

  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const client = new Anthropic({ apiKey: this.apiKey });

    const systemPrompt = buildSystemPrompt(task);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: task.prompt }
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let timedOut = false;
    const deadlineMs = Date.now() + task.budgetSeconds * 1000;

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (Date.now() >= deadlineMs) {
          timedOut = true;
          break;
        }

        const response = await client.messages.create({
          model: this.model,
          max_tokens: 8192,
          system: systemPrompt,
          tools: TOOLS,
          messages
        });

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;

        // Append the assistant turn.
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "end_turn") {
          break;
        }

        if (response.stop_reason === "tool_use") {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const result = executeTool(
              block.name,
              block.input as Record<string, string>,
              task.workingDirectory
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result
            });
          }

          messages.push({ role: "user", content: toolResults });
        }
      }
    } catch (err) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      return {
        status: "FAILED",
        artifacts: [],
        blockReason: err instanceof Error ? err.message : String(err),
        metrics: { elapsedSeconds, tokenInput: totalInputTokens, tokenOutput: totalOutputTokens }
      };
    }

    const elapsedSeconds = (Date.now() - start) / 1000;

    if (timedOut) {
      return {
        status: "TIMEOUT",
        artifacts: [],
        metrics: { elapsedSeconds: task.budgetSeconds, tokenInput: totalInputTokens, tokenOutput: totalOutputTokens }
      };
    }

    const statusFile = readStatusFile(task.workingDirectory);
    if (!statusFile) {
      return {
        status: "DONE_WITH_CONCERNS",
        artifacts: [],
        concerns: "Agent did not write .autoforge-status.json",
        metrics: { elapsedSeconds, tokenInput: totalInputTokens, tokenOutput: totalOutputTokens }
      };
    }

    return {
      status: statusFile.status,
      artifacts: statusFile.artifacts,
      concerns: statusFile.concerns,
      blockReason: statusFile.blockReason,
      metrics: { elapsedSeconds, tokenInput: totalInputTokens, tokenOutput: totalOutputTokens }
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = new Anthropic({ apiKey: this.apiKey });
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(task: AgentTask): string {
  const sections: string[] = [];

  const skillContents = loadSkillFiles(task.skillFiles);
  if (skillContents) {
    sections.push(`# Skills\n\n${skillContents}`);
  }

  sections.push(`# Role\n\nYou are an autonomous software agent. You have access to tools to read and write files and run shell commands in your working directory. Work methodically: read existing code before editing, verify your changes compile or pass tests before finishing.`);

  sections.push(`# Status Reporting (required)

When you have finished the task you MUST write \`${STATUS_FILE}\` in the working directory using the write_file tool with this exact JSON format:

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
- **"NEEDS_CONTEXT"** — missing information; add a "blockReason" field specifying what is needed

Time budget: ${task.budgetSeconds} seconds. Work efficiently.`);

  return sections.join("\n\n");
}

function loadSkillFiles(skillFiles: string[]): string {
  const parts: string[] = [];
  for (const filePath of skillFiles) {
    try {
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath, "utf8").trim());
      }
    } catch {
      // skip unreadable skill files
    }
  }
  return parts.join("\n\n---\n\n");
}

interface AgentStatusFile {
  status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
}

function readStatusFile(workingDirectory: string): AgentStatusFile | null {
  const statusPath = join(workingDirectory, STATUS_FILE);
  try {
    if (!existsSync(statusPath)) return null;
    return JSON.parse(readFileSync(statusPath, "utf8")) as AgentStatusFile;
  } catch {
    return null;
  }
}
