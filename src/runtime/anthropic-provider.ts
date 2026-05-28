import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelResponse,
  ModelSystemBlock,
  ToolDefinition
} from "./model-provider";

type MessageCreate = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { timeout: number; signal: AbortSignal }
) => Promise<{
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason: string | null;
  content: unknown[];
}>;

export interface AnthropicProviderOptions {
  apiKey: string;
  supportedModels?: string[];
  createMessage?: MessageCreate;
  client?: Anthropic;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly supportedModels: string[];

  private readonly client: Anthropic;
  private readonly createMessage?: MessageCreate;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.supportedModels = options.supportedModels ?? [];
    this.createMessage = options.createMessage;
  }

  async message(args: {
    model: string;
    systemPrompt?: string;
    system?: ModelSystemBlock[];
    history: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    timeoutSeconds?: number;
  }): Promise<ModelResponse> {
    const timeout = (args.timeoutSeconds ?? 120) * 1000;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: args.model,
      max_tokens: args.maxTokens ?? 8192,
      system: toAnthropicSystem(args),
      messages: args.history as unknown as Anthropic.MessageParam[],
      tools: args.tools.map(toAnthropicTool)
    };

    const response = this.createMessage
      ? await this.createMessage(params, { timeout, signal: AbortSignal.timeout(timeout) })
      : await this.client.messages.create(params, { timeout, signal: AbortSignal.timeout(timeout) });

    return {
      stopReason: normalizeStopReason(response.stop_reason),
      content: response.content as ModelContentBlock[],
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cached: response.usage.cache_read_input_tokens ?? 0,
        cacheCreation: response.usage.cache_creation_input_tokens ?? 0
      }
    };
  }
}

function toAnthropicSystem(args: { systemPrompt?: string; system?: ModelSystemBlock[] }): Anthropic.TextBlockParam[] {
  const blocks = args.system && args.system.length > 0
    ? args.system
    : [{ type: "text" as const, text: args.systemPrompt ?? "", cache: false, stable: false }];
  return blocks.map((block) => {
    const out: Anthropic.TextBlockParam = { type: "text", text: block.text };
    if (shouldCacheSystemBlock(block)) {
      return { ...out, cache_control: { type: "ephemeral" as const } };
    }
    return out;
  });
}

function shouldCacheSystemBlock(block: ModelSystemBlock): boolean {
  return block.stable === true && block.cache === true;
}

export function toToolDefinition(tool: Anthropic.Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.input_schema
  };
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
  };
}

function normalizeStopReason(stopReason: string | null): ModelResponse["stopReason"] {
  if (
    stopReason === "end_turn" ||
    stopReason === "tool_use" ||
    stopReason === "max_tokens" ||
    stopReason === "stop_sequence" ||
    stopReason === "pause_turn" ||
    stopReason === "refusal"
  ) {
    return stopReason;
  }
  return "error";
}
