// Per-token pricing used for cost estimates (Claude Sonnet-class)
const INPUT_COST_PER_TOKEN = 3 / 1_000_000; // $3 per 1M input tokens
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000; // $15 per 1M output tokens

export interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export function summarizeTokenUsage(
  events: Array<{ tokenUsage?: { input: number; output: number } | null }>
): TokenSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const ev of events) {
    if (ev.tokenUsage) {
      inputTokens += ev.tokenUsage.input;
      outputTokens += ev.tokenUsage.output;
    }
  }
  const estimatedCostUsd =
    inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
  return { inputTokens, outputTokens, estimatedCostUsd };
}
