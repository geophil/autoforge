# Cost and Token Telemetry Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a provider-agnostic cost and token telemetry layer that records every model call and tool call under a single task ledger, producing a summary at the end.

**Architecture:** Use an inline tracker within `HarnessExecutor` to capture start and end times around provider messages and tool executions. We'll introduce a configurable pricing table (JSON) and a `TelemetryLedger` object to aggregate and summarize cost/token data, returning it as part of `AgentResult.metrics` and writing it to `.autoforge-telemetry.json`.

**Tech Stack:** TypeScript, Node.js filesystem, Bun (for testing).

---

### Task 1: Pricing Configuration Loader

**Files:**
- Create: `src/runtime/pricing.json`
- Create: `src/runtime/pricing.ts`
- Create: `tests/unit/pricing.test.ts`

- [ ] **Step 1: Write the failing tests for pricing loader**

```typescript
// tests/unit/pricing.test.ts
import { describe, expect, test } from "bun:test";
import { getModelCost, loadPricingConfig } from "../../src/runtime/pricing";

describe("Pricing Configuration", () => {
  test("returns default costs if model is unlisted or json fails to load", () => {
    // Before load
    expect(getModelCost("unknown_provider", "unknown_model")).toEqual({ input: 0, output: 0, cached: 0 });
  });

  test("returns correct costs for a known model from config", () => {
    // Assuming we have a standard entry like Anthropic Claude 3.5 Sonnet
    const cost = getModelCost("anthropic", "claude-3-5-sonnet-20241022");
    // Ensure it's defined and has values
    expect(cost.input).toBeGreaterThan(0);
    expect(cost.output).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/pricing.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Write pricing implementation and json**

```json
// src/runtime/pricing.json
{
  "anthropic": {
    "claude-3-5-sonnet-20241022": {
      "input": 3.00,
      "output": 15.00,
      "cached": 0.30
    },
    "claude-3-haiku-20240307": {
      "input": 0.25,
      "output": 1.25,
      "cached": 0.03
    }
  }
}
```

```typescript
// src/runtime/pricing.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelCost {
  input: number; // cost per 1M tokens
  output: number; // cost per 1M tokens
  cached: number; // cost per 1M tokens
}

let pricingCache: Record<string, Record<string, ModelCost>> | null = null;

export function loadPricingConfig(): void {
  try {
    const filePath = join(__dirname, "pricing.json");
    const content = readFileSync(filePath, "utf-8");
    pricingCache = JSON.parse(content);
  } catch (error) {
    console.warn("[pricing] Failed to load pricing.json. Falling back to zero-costs.", error);
    pricingCache = {};
  }
}

export function getModelCost(provider: string, model: string): ModelCost {
  if (!pricingCache) loadPricingConfig();
  
  const providerData = pricingCache?.[provider];
  if (providerData && providerData[model]) {
    return providerData[model];
  }
  return { input: 0, output: 0, cached: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/pricing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/pricing.json src/runtime/pricing.ts tests/unit/pricing.test.ts
git commit -m "feat: add JSON-based pricing configuration loader"
```

### Task 2: Telemetry Data Structures and Ledger Logic

**Files:**
- Modify: `src/executors/interface.ts`
- Create: `src/executors/telemetry.ts`
- Create: `tests/unit/telemetry.test.ts`

- [ ] **Step 1: Write the failing tests for the ledger**

```typescript
// tests/unit/telemetry.test.ts
import { describe, expect, test } from "bun:test";
import { TelemetryLedger } from "../../src/executors/telemetry";

describe("TelemetryLedger", () => {
  test("aggregates model and tool events into a summary", () => {
    const ledger = new TelemetryLedger();
    
    ledger.recordModelCall({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      agentType: "coder",
      tokens: { input: 1000, output: 500, cached: 0 },
      latencyMs: 1500,
      timestamp: Date.now(),
      retryAttempt: 0,
      estimatedCost: 0.0105 // (1000*3 + 500*15) / 1000000 = 0.0105
    });

    ledger.recordToolCall({
      toolName: "read_file",
      status: "success",
      latencyMs: 50,
      rawOutputBytes: 1500,
      truncatedOutputBytes: 1500
    });

    const summary = ledger.getSummary();
    expect(summary.totalEstimatedCost).toBeCloseTo(0.0105);
    expect(summary.totalTokens.input).toBe(1000);
    expect(summary.totalTokens.output).toBe(500);
    expect(summary.mostExpensiveModel).toBe("claude-3-5-sonnet-20241022");
    expect(summary.mostExpensivePhase).toBe("coder");
    expect(summary.toolOutputContributionBytes).toBe(1500);
    expect(summary.retryCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/telemetry.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Update interface and create telemetry class**

```typescript
// Modify src/executors/interface.ts (Update AgentResult interface)
import type { TelemetrySummary, ModelCallEvent, ToolCallEvent } from "./telemetry";
// (Note: you may need to add the import and update the AgentResult interface's metrics object)

// inside AgentResult.metrics:
//    telemetry?: TelemetrySummary & { events: { models: ModelCallEvent[]; tools: ToolCallEvent[] } };
```
*Be sure to add the import correctly at the top of the file without breaking other imports.*

```typescript
// src/executors/telemetry.ts
import type { AgentType } from "../types/core";

export interface ModelCallEvent {
  provider: string;
  model: string;
  agentType: AgentType;
  tokens: { input: number; output: number; cached?: number };
  latencyMs: number;
  timestamp: number;
  retryAttempt: number;
  estimatedCost: number;
}

export interface ToolCallEvent {
  toolName: string;
  status: "success" | "error";
  latencyMs: number;
  rawOutputBytes: number;
  truncatedOutputBytes: number;
  artifactReference?: string;
}

export interface TelemetrySummary {
  totalEstimatedCost: number;
  totalTokens: { input: number; output: number; cached: number };
  retryCount: number;
  mostExpensiveModel: string;
  mostExpensivePhase: string;
  toolOutputContributionBytes: number;
}

export class TelemetryLedger {
  private modelEvents: ModelCallEvent[] = [];
  private toolEvents: ToolCallEvent[] = [];

  recordModelCall(event: ModelCallEvent) {
    this.modelEvents.push(event);
  }

  recordToolCall(event: ToolCallEvent) {
    this.toolEvents.push(event);
  }

  getEvents() {
    return { models: [...this.modelEvents], tools: [...this.toolEvents] };
  }

  getSummary(): TelemetrySummary {
    let totalCost = 0;
    const tokens = { input: 0, output: 0, cached: 0 };
    let totalToolBytes = 0;
    let retries = 0;

    const costByModel: Record<string, number> = {};
    const costByPhase: Record<string, number> = {};

    for (const m of this.modelEvents) {
      totalCost += m.estimatedCost;
      tokens.input += m.tokens.input;
      tokens.output += m.tokens.output;
      tokens.cached += m.tokens.cached ?? 0;
      retries += m.retryAttempt;

      costByModel[m.model] = (costByModel[m.model] || 0) + m.estimatedCost;
      costByPhase[m.agentType] = (costByPhase[m.agentType] || 0) + m.estimatedCost;
    }

    for (const t of this.toolEvents) {
      totalToolBytes += t.truncatedOutputBytes;
    }

    let mostExpensiveModel = "";
    let maxModelCost = -1;
    for (const [model, cost] of Object.entries(costByModel)) {
      if (cost > maxModelCost) {
        mostExpensiveModel = model;
        maxModelCost = cost;
      }
    }

    let mostExpensivePhase = "";
    let maxPhaseCost = -1;
    for (const [phase, cost] of Object.entries(costByPhase)) {
      if (cost > maxPhaseCost) {
        mostExpensivePhase = phase;
        maxPhaseCost = cost;
      }
    }

    return {
      totalEstimatedCost: totalCost,
      totalTokens: tokens,
      retryCount: retries,
      mostExpensiveModel,
      mostExpensivePhase,
      toolOutputContributionBytes: totalToolBytes
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/telemetry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/executors/interface.ts src/executors/telemetry.ts tests/unit/telemetry.test.ts
git commit -m "feat: define telemetry events and ledger aggregation logic"
```

### Task 3: Integration into HarnessExecutor

**Files:**
- Modify: `src/runtime/harness-executor.ts`
- Modify: `tests/unit/harness-executor.test.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
// Modify tests/unit/harness-executor.test.ts
// Add a test checking that the `.autoforge-telemetry.json` file is written and `metrics.telemetry` is populated.

// Within the HarnessExecutor describe block:
  test("generates and persists telemetry data to workspace and metrics", async () => {
    const workspace = new MockWorkspace({ id: "workspace-telemetry" });
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "tool-telemetry", name: "write_status", input: { status: "DONE" } }],
        usage: { input: 10, output: 20 }
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input: 30, output: 40 }
      }
    ]);
    
    // Use an identical write_status tool from the first test
    const tools = new ToolRegistry().register({
      name: "write_status",
      description: "Write the Autoforge status file.",
      inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
      execute: async (input, toolWorkspace: Workspace) => {
        await toolWorkspace.writeFile(".autoforge-status.json", JSON.stringify({ status: input.status, artifacts: [] }));
        return { ok: true };
      }
    });

    const executor = new HarnessExecutor({ provider, tools, defaultModel: "claude-3-5-sonnet-20241022" });

    const result = await executor.execute({
      id: "task-telemetry",
      type: "coder",
      systemPrompt: "system",
      prompt: "do work",
      workspace,
      budgetSeconds: 60,
      environment: {},
      skillFiles: []
    });

    expect(result.status).toBe("DONE");
    
    // Telemetry metric check
    expect(result.metrics.telemetry).toBeDefined();
    expect(result.metrics.telemetry?.totalTokens.input).toBe(40); // 10 + 30
    expect(result.metrics.telemetry?.totalTokens.output).toBe(60); // 20 + 40
    expect(result.metrics.telemetry?.events.models.length).toBe(2);
    expect(result.metrics.telemetry?.events.tools.length).toBe(1);

    // Workspace file check
    const telemetryFileContent = await workspace.readFile(".autoforge-telemetry.json").catch(() => null);
    expect(telemetryFileContent).not.toBeNull();
    const parsed = JSON.parse(telemetryFileContent!);
    expect(parsed.totalTokens.input).toBe(40);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/harness-executor.test.ts`
Expected: FAIL (Cannot find `.autoforge-telemetry.json` and `telemetry` is undefined)

- [ ] **Step 3: Implement Telemetry tracking in HarnessExecutor**

Modify `src/runtime/harness-executor.ts`:
1. Import `TelemetryLedger` and `getModelCost`.
2. In `HarnessExecutor.execute`, instantiate `const ledger = new TelemetryLedger()`.
3. Wrap `this.options.provider.message` to record start time. Once it resolves, calculate the cost and record the `ModelCallEvent`. Be careful with retries if your provider abstraction uses them, otherwise `retryAttempt` is 0.
4. Wrap tool execution to record start time. On success or error, track bytes. Use `Buffer.byteLength(String(result), 'utf8')` as an approximation of the raw output bytes and `Buffer.byteLength(serialized, 'utf8')` for truncated bytes.
5. Create a `flushTelemetry(workspace, ledger)` helper at the bottom.
6. Make sure `finalize`, `timeoutResult`, and the catch-all error return object call `flushTelemetry` and attach the ledger summary and events to the `AgentResult.metrics.telemetry`. Note that `finalize` should `await` writing the file before returning. `timeoutResult` does not have an `await`, so `workspace.writeFile` inside it should be fire-and-forget or `timeoutResult` should become async. Be mindful of types. If you make `timeoutResult` async, ensure it is awaited.

*Detailed instruction for Step 3 code modification is left to the inline execution, but make sure to capture:*
- `const modelStart = Date.now()`
- `ledger.recordModelCall({ ... })`
- `const toolStart = Date.now()`
- `ledger.recordToolCall({ ... })`
- Add `.catch(() => {})` when writing `.autoforge-telemetry.json` to prevent crashes.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/harness-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/harness-executor.ts tests/unit/harness-executor.test.ts
git commit -m "feat: track execution telemetry and write summary to workspace"
```
