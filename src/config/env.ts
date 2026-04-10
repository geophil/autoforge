import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  NATS_URL: z.string().default("nats://127.0.0.1:4222"),
  DATABASE_PATH: z.string().default("./data/autoforge.sqlite"),
  EXECUTOR_DEFAULT: z.string().default("claude-code"),
  EXECUTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEST_PASS_THRESHOLD: z.coerce.number().min(0).max(1).default(1),
  REVIEW_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Optional: required only for real PR creation. Agents do NOT receive this.
  GITHUB_TOKEN: z.string().optional(),
  // Override the claude binary path if needed.
  CLAUDE_COMMAND: z.string().default("claude"),
  // Path to skills directory (injected into agent prompts).
  SKILLS_DIR: z.string().default("./skills"),
  // Anthropic SDK executor settings (used when EXECUTOR_DEFAULT=anthropic-sdk).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6")
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(rawEnv: Record<string, string | undefined> = process.env): AppEnv {
  return EnvSchema.parse(rawEnv);
}
