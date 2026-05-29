import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  NATS_URL: z.string().default("nats://127.0.0.1:4222"),
  DATABASE_PATH: z.string().default("./data/autoforge.sqlite"),
  EXECUTOR_DEFAULT: z.enum(["harness", "mock"]).default("harness"),
  EXECUTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEST_PASS_THRESHOLD: z.coerce.number().min(0).max(1).default(1),
  REVIEW_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Optional: required only for real PR creation. Agents do NOT receive this.
  GITHUB_TOKEN: z.string().optional(),
  // Path to skills directory (injected into agent prompts).
  SKILLS_DIR: z.string().default("./skills"),
  // Anthropic provider settings used by harness runtime.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  MODEL_TIER_CHEAP: z.string().optional(),
  MODEL_TIER_STANDARD: z.string().optional(),
  MODEL_TIER_STRONG: z.string().optional(),
  QMD_MCP_TOTAL_ALLOWANCE_SECONDS: z.coerce.number().int().positive().default(90),
  QMD_MCP_CALL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  PLANNER_FINAL_RESERVE_SECONDS: z.coerce.number().int().positive().default(75),
  PLANNER_SPEC_MAX_QMD_CALLS: z.coerce.number().int().positive().default(6),
  PLANNER_SPEC_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(8),
  MODEL_CALL_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  HARNESS_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(120_000),
  HARNESS_COMPACTION_MODEL: z.string().optional(),
  HARNESS_SUMMARIZATION_MODEL: z.string().optional(),
  HARNESS_CLASSIFICATION_MODEL: z.string().optional(),
  HARNESS_EXTRACTION_MODEL: z.string().optional(),
  HARNESS_COMPACTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  HARNESS_SUMMARIZATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  HARNESS_CLASSIFICATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(15),
  HARNESS_EXTRACTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(20),
  HARNESS_COMPACTION_MAX_TOKENS: z.coerce.number().int().positive().default(1200),
  HARNESS_SUMMARIZATION_MAX_TOKENS: z.coerce.number().int().positive().default(1200),
  HARNESS_CLASSIFICATION_MAX_TOKENS: z.coerce.number().int().positive().default(400),
  HARNESS_EXTRACTION_MAX_TOKENS: z.coerce.number().int().positive().default(800),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["deterministic", "openai"]).default("deterministic"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // QMD MCP endpoint — passed to agent environments so agents can query the knowledge base.
  QMD_MCP_URL: z.string().optional(),
  PLANNER_MODEL_COMPLEX: z.string().default("claude-opus-4-7"),
  PLANNER_MODEL_EXPRESS: z.string().default("claude-sonnet-4-6"),
  PLANNER_MAX_ITERATIONS: z.coerce.number().int().min(0).max(10).default(3),
  PLANNER_SPEC_MAX_ITERATIONS: z.coerce.number().int().min(0).max(10).default(3),
  AUTOFORGE_RESUME_SUBTASK_ENABLED: z.enum(["0", "1"]).default("0"),
  AUTOFORGE_HOOK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  AUTOFORGE_ENABLE_TEST_HOOKS: z.enum(["0", "1"]).default("0"),
  WORKSPACE_PROVIDER: z.enum(["local", "docker"]).default("local"),
  WORKSPACE_DOCKER_IMAGE: z.string().min(1).default("autoforge-agent:local"),
  WORKSPACE_DOCKER_NETWORK: z.string().min(1).default("none"),
  WORKSPACE_DOCKER_CPUS: z.string().min(1).default("2"),
  WORKSPACE_DOCKER_MEMORY: z.string().min(1).default("2g"),
  WORKSPACE_DOCKER_PRECHECK: z.enum(["0", "1"]).default("1"),
  // The container is started with `-u <uid>:<gid>`. The defaults match the
  // `agent` user baked into docker/autoforge-agent/Dockerfile; override only
  // when running a custom image whose user has different numeric ids.
  WORKSPACE_DOCKER_UID: z.coerce.number().int().min(0).default(1000),
  WORKSPACE_DOCKER_GID: z.coerce.number().int().min(0).default(1000),
  // When set to "1", the orchestrator runs `docker rm -f` against every
  // container labeled autoforge.workspace=true at startup. Off by default
  // because it would clobber workspaces owned by another orchestrator
  // running on the same host. Safe to enable in single-instance setups.
  WORKSPACE_DOCKER_REAP_ON_START: z.enum(["0", "1"]).default("0")
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(rawEnv: Record<string, string | undefined> = process.env): AppEnv {
  return EnvSchema.parse(rawEnv);
}
