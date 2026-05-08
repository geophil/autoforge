import type { ToolDefinition } from "./model-provider";
import type { Workspace } from "./workspace";

export type ToolStatsBucket = "read" | "write" | "bash" | "search";

export interface ToolExecutionContext {
  environment: Record<string, string>;
  deadlineMs: number;
  timeoutSeconds: number;
  recordLoadedSkill?: (name: string) => void;
}

export interface ToolImpl extends ToolDefinition {
  statsBucket?: ToolStatsBucket;
  execute(input: Record<string, unknown>, workspace: Workspace, context: ToolExecutionContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolImpl>();

  register(tool: ToolImpl): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }));
  }

  get(name: string): ToolImpl {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  }
}

export function statsBucketForTool(tool: Pick<ToolImpl, "name" | "statsBucket">): ToolStatsBucket | null {
  if (tool.statsBucket) return tool.statsBucket;
  if (tool.name.startsWith("read_") || tool.name.startsWith("list_")) return "read";
  if (tool.name.startsWith("write_") || tool.name === "done") return "write";
  if (tool.name === "bash" || tool.name.startsWith("exec_")) return "bash";
  if (tool.name.startsWith("search_") || tool.name.includes("skill")) return "search";
  return null;
}
