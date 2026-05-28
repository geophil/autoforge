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

export interface ModelSystemBlock {
  type: "text";
  text: string;
  /**
   * Provider-specific prompt-cache hint. Providers should only honor this
   * when the block is also marked stable.
   */
  cache?: boolean;
  name?: string;
  stable?: boolean;
}

export interface ModelResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "pause_turn" | "refusal" | "error";
  content: ModelContentBlock[];
  usage: {
    input: number;
    output: number;
    /** Input tokens served from prompt cache. */
    cached?: number;
    /** Input tokens written into prompt cache. */
    cacheCreation?: number;
  };
}

export interface ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];
  message(args: {
    model: string;
    systemPrompt?: string;
    system?: ModelSystemBlock[];
    history: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    timeoutSeconds?: number;
  }): Promise<ModelResponse>;
}
