import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "./model-provider";
import type { TimeoutDecision } from "./run-budget";
import {
  isRuntimeFailureError,
  isTimeoutLikeError,
  RuntimeFailureError,
  type RuntimeFailureSubtype
} from "./runtime-failure-classifier";

export interface McpClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: object }> }>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number }
  ): Promise<{ content?: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export interface McpSetupOutcome {
  status: "success" | "error";
  toolDefinitions: ToolDefinition[];
  message: string;
  elapsedMs: number;
  failureSubtype?: RuntimeFailureSubtype;
}

export interface McpCallOutcome {
  status: "success" | "error";
  text: string;
  elapsedMs: number;
  failureSubtype?: RuntimeFailureSubtype;
}

export class McpToolAdapter {
  private client: McpClient | null = null;
  private readonly toolNames = new Set<string>();

  constructor(private readonly factory: (url: string) => Promise<McpClient> = createDefaultMcpClient) {}

  hasTool(name: string): boolean {
    return this.client !== null && this.toolNames.has(name);
  }

  async setup(url: string, timeout: TimeoutDecision): Promise<McpSetupOutcome> {
    const start = Date.now();
    let status: "success" | "error" = "success";
    let message = "";
    let failureSubtype: RuntimeFailureSubtype | undefined = timeout.failureSubtype;
    let toolDefinitions: ToolDefinition[] = [];
    await this.close();
    let setupCancelled = false;
    let setupClient: McpClient | null = null;
    let setupClientClosed = false;
    const closeSetupClient = async () => {
      const client = setupClient;
      setupClient = null;
      if (client && !setupClientClosed) {
        setupClientClosed = true;
        await client.close();
      }
    };
    try {
      if (timeout.timeoutMs <= 0 || failureSubtype) {
        throw new RuntimeFailureError("qmd_allowance_exceeded", "QMD allowance exhausted before MCP setup");
      }
      const setup = await withTimeout((async () => {
        const client = await this.factory(url);
        setupClient = client;
        if (setupCancelled) {
          await closeSetupClient();
          throw new RuntimeFailureError("qmd_call_timeout", "QMD MCP setup completed after timeout");
        }
        const listed = await client.listTools();
        if (setupCancelled) {
          await closeSetupClient();
          throw new RuntimeFailureError("qmd_call_timeout", "QMD MCP setup completed after timeout");
        }
        return { client, tools: listed.tools };
      })(), timeout.timeoutMs, `QMD MCP setup timed out after ${timeout.timeoutSeconds.toFixed(3)}s`);
      this.client = setup.client;
      setupClient = null;
      toolDefinitions = setup.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema
      }));
      this.toolNames.clear();
      for (const tool of toolDefinitions) this.toolNames.add(tool.name);
      message = JSON.stringify({ tools: toolDefinitions.map((tool) => tool.name) });
    } catch (err) {
      status = "error";
      if (isRuntimeFailureError(err)) {
        failureSubtype = err.failureSubtype;
      } else if (isTimeoutLikeError(err)) {
        failureSubtype = "qmd_call_timeout";
      }
      message = err instanceof Error ? err.message : String(err);
      setupCancelled = true;
      try { await closeSetupClient(); } catch {}
      try { await this.close(); } catch {}
    }
    return {
      status,
      toolDefinitions,
      message,
      elapsedMs: Date.now() - start,
      failureSubtype
    };
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    timeout: TimeoutDecision
  ): Promise<McpCallOutcome> {
    const start = Date.now();
    if (!this.client) {
      return { status: "error", text: `QMD tool '${name}' is unavailable`, elapsedMs: 0 };
    }
    try {
      if (timeout.failureSubtype || timeout.timeoutMs <= 0) {
        return {
          status: "error",
          text: "QMD allowance is exhausted. Use existing evidence and write the best available status now.",
          elapsedMs: 0,
          failureSubtype: "qmd_allowance_exceeded"
        };
      }
      const result = await this.client.callTool(
        { name, arguments: input },
        undefined,
        { timeout: timeout.timeoutMs }
      );
      const text = ((result.content || []) as unknown[]).map(extractMcpText).join("\n");
      return {
        status: result.isError ? "error" : "success",
        text,
        elapsedMs: Date.now() - start
      };
    } catch (error) {
      if (!isTimeoutLikeError(error)) throw error;
      return {
        status: "error",
        text: `QMD tool '${name}' timed out after ${timeout.timeoutSeconds.toFixed(3)}s`,
        elapsedMs: Date.now() - start,
        failureSubtype: "qmd_call_timeout"
      };
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.toolNames.clear();
    if (client) await client.close();
  }
}

async function createDefaultMcpClient(url: string): Promise<McpClient> {
  const client = new Client({ name: "autoforge-agent", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client as unknown as McpClient;
}

function extractMcpText(content: unknown): string {
  if (!isRecord(content)) return JSON.stringify(content);
  if (content.type === "text") return typeof content.text === "string" ? content.text : "";
  if (content.type === "resource" && isRecord(content.resource)) {
    return typeof content.resource.text === "string" ? content.resource.text : "";
  }
  return JSON.stringify(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(message);
          error.name = "AbortError";
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
