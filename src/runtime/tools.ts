import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SkillRegistry } from "../skills/registry";
import { STATUS_FILE } from "../executors/status-convention";
import { ToolRegistry } from "./tool-registry";
import type { ExecEvent } from "./workspace";

interface RuntimeToolRegistryOptions {
  skillRegistry?: SkillRegistry;
}

export function createRuntimeToolRegistry(options: RuntimeToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();

  registry
    .register({
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to read." }
        },
        required: ["path"]
      },
      statsBucket: "read",
      execute: async (input, workspace) => {
        const path = requireString(input.path, "path");
        return { path, content: await workspace.readFile(path) };
      }
    })
    .register({
      name: "write_file",
      description: "Write a UTF-8 text file into the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to write." },
          content: { type: "string", description: "Full file content." }
        },
        required: ["path", "content"]
      },
      statsBucket: "write",
      execute: async (input, workspace) => {
        const path = requireString(input.path, "path");
        await workspace.writeFile(path, requireString(input.content, "content"));
        return { path, ok: true };
      }
    })
    .register({
      name: "str_replace",
      description:
        "Replace exactly one occurrence of old_string with new_string in a workspace file. old_string must match verbatim (including whitespace) and occur exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the file to edit." },
          old_string: { type: "string", description: "Exact snippet to replace (must occur exactly once)." },
          new_string: { type: "string", description: "Replacement text." }
        },
        required: ["path", "old_string", "new_string"]
      },
      statsBucket: "write",
      execute: async (input, workspace) => {
        const path = requireString(input.path, "path");
        const oldString = requireString(input.old_string, "old_string");
        const newString = requireString(input.new_string, "new_string");
        if (oldString.length === 0) {
          throw new Error("old_string must not be empty (ambiguous match)");
        }
        if (oldString === newString) {
          throw new Error("old_string and new_string are identical; nothing to do");
        }
        const content = await workspace.readFile(path);
        let count = 0;
        let idx = 0;
        while (idx <= content.length - oldString.length) {
          const at = content.indexOf(oldString, idx);
          if (at === -1) break;
          count += 1;
          idx = at + oldString.length;
        }
        if (count === 0) {
          throw new Error("old_string was not found in the file");
        }
        if (count > 1) {
          throw new Error(`old_string is ambiguous: found ${count} occurrences; include more context so the match is unique`);
        }
        const at = content.indexOf(oldString);
        const updated = content.slice(0, at) + newString + content.slice(at + oldString.length);
        await workspace.writeFile(path, updated);
        return { path, ok: true, replacements: 1 };
      }
    })
    .register({
      name: "exec",
      description: "Run a command in the workspace and collect stdout, stderr, and exit status.",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Executable name or path." },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments."
          },
          cwd: { type: "string", description: "Optional workspace-relative working directory." }
        },
        required: ["cmd"]
      },
      statsBucket: "bash",
      execute: async (input, workspace, context) => {
        const events = workspace.exec(requireString(input.cmd, "cmd"), optionalStringArray(input.args, "args"), {
          cwd: optionalString(input.cwd, "cwd"),
          env: context.environment,
          timeoutSeconds: context.timeoutSeconds
        });
        return collectExec(events);
      }
    })
    .register({
      name: "done",
      description: "Write the Autoforge status file to complete the task.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"]
          },
          artifacts: { type: "array", items: { type: "string" } },
          concerns: { type: "string" },
          blockReason: { type: "string" }
        },
        required: ["status"]
      },
      statsBucket: "write",
      execute: async (input, workspace) => {
        const status = requireStatus(input.status);
        const payload = {
          status,
          artifacts: optionalStringArray(input.artifacts, "artifacts"),
          ...optionalField(input.concerns, "concerns"),
          ...optionalField(input.blockReason, "blockReason")
        };
        await workspace.writeFile(STATUS_FILE, JSON.stringify(payload, null, 2));
        return { ok: true, status };
      }
    });

  if (options.skillRegistry) {
    registry
      .register({
        name: "lookup_skill",
        description: "Find available skills by optional name or description pattern.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Optional case-insensitive search pattern." }
          }
        },
        statsBucket: "search",
        execute: async (input) => {
          const pattern = optionalString(input.pattern, "pattern")?.toLowerCase();
          const skills = await listSkillSummaries(options.skillRegistry!);
          return {
            skills: skills
              .filter((skill) => {
                if (!pattern) return true;
                return skill.name.toLowerCase().includes(pattern) || skill.description.toLowerCase().includes(pattern);
              })
              .map(({ name, description }) => ({ name, description }))
          };
        }
      })
      .register({
        name: "load_skill",
        description: "Load the full markdown content for a named skill.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name without .md extension." }
          },
          required: ["name"]
        },
        statsBucket: "search",
        execute: async (input, _workspace, context) => {
          const name = requireString(input.name, "name");
          const skill = (await listSkillSummaries(options.skillRegistry!)).find((candidate) => candidate.name === name);
          if (!skill) {
            throw new Error(`Skill not found: ${name}`);
          }
          const content = await readFile(skill.path, "utf8");
          context.recordLoadedSkill?.(name);
          return { name, content };
        }
      });
  }

  return registry;
}

async function collectExec(events: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let signal: string | undefined;

  for await (const event of events) {
    if (event.kind === "stdout") stdout += event.chunk;
    if (event.kind === "stderr") stderr += event.chunk;
    if (event.kind === "exit") {
      exitCode = event.exitCode;
      signal = event.signal;
    }
  }

  return { stdout, stderr, exitCode, ...(signal ? { signal } : {}) };
}

async function listSkillSummaries(registry: SkillRegistry): Promise<Array<{
  name: string;
  description: string;
  path: string;
}>> {
  return Promise.all(registry.listAll().map(async (path) => {
    const content = await readFile(path, "utf8");
    const name = parseFrontmatterField(content, "name") ?? basename(path, ".md");
    const description = parseFrontmatterField(content, "description") ?? firstMarkdownLine(content);
    return { name, description, path };
  }));
}

function parseFrontmatterField(content: string, field: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  return line ? line.slice(field.length + 1).trim().replace(/^["']|["']$/g, "") : null;
}

function firstMarkdownLine(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== "---" && !line.includes(":")) ?? "";
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function requireStatus(value: unknown): "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT" {
  const status = requireString(value, "status");
  if (
    status !== "DONE" &&
    status !== "DONE_WITH_CONCERNS" &&
    status !== "BLOCKED" &&
    status !== "NEEDS_CONTEXT"
  ) {
    throw new Error(`Invalid status: ${status}`);
  }
  return status;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${field} to be an array of strings`);
  }
  return value;
}

function optionalField(value: unknown, field: string): Record<string, string> {
  return value === undefined ? {} : { [field]: requireString(value, field) };
}
