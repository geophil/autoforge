import { loadEnv, type AppEnv } from "../../src/config/env";

/**
 * Test-mode env baseline for route tests that build the web server without
 * going through `createTestService`. Route tests that omit the `env`
 * argument to `createWebServer(...)` fall through to `loadEnv()` which
 * reads `process.env` — and on developer machines that picks up the local
 * `.env` (gitignored), which may carry historically-valid values that
 * `EnvSchema.parse` now rejects (e.g. legacy executor names removed in
 * commit `645a376`). Passing this env explicitly keeps route tests
 * insulated from the developer's local config.
 */
export function testEnv(overrides: Partial<Record<string, string>> = {}): AppEnv {
  return loadEnv({
    NODE_ENV: "test",
    EXECUTOR_DEFAULT: "mock",
    ...overrides
  });
}
