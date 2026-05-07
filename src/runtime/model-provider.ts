export type ModelContentBlock = Record<string, unknown> & { type: string };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ModelResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "pause_turn" | "refusal" | "error";
  content: ModelContentBlock[];
  usage: { input: number; output: number };
}

export interface ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];
  message(args: {
    model: string;
    systemPrompt: string;
    history: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    timeoutSeconds?: number;
  }): Promise<ModelResponse>;
}
