# Cost and Token Telemetry Layer Design

## Overview
Implement a provider-agnostic cost and token telemetry layer for the agent harness. It records every model call and tool call under a single run/task ledger. At the end of the run, it produces a compact summary and writes it to `.autoforge-telemetry.json` in the workspace, as well as attaching it to the `AgentResult`. The primary success metric is reliable reporting of cost per successful task.

## Architecture
We use an Inline Tracker pattern within the `HarnessExecutor`. The executor will instantiate a `TelemetryLedger` at the start of a task. It will record events before/after model calls and tool calls.

### 1. Pricing Configuration
- **File**: `src/runtime/pricing.json`
- **Format**: Maps provider and model to cost per 1M tokens (input, output, and cached).
- **Behavior**: Loaded at runtime via a utility module (`src/runtime/pricing.ts`). If the file is missing or a model is unlisted, it falls back to hardcoded defaults or zero-costs to ensure the run doesn't fail.

### 2. Telemetry Ledger Data Structures
- **Location**: `src/executors/telemetry.ts` (new file).
- **ModelCallEvent**: 
  - `provider`: string
  - `model`: string
  - `agentType`: AgentType (from `task.type`)
  - `tokens`: `{ input: number, output: number, cached?: number }`
  - `latencyMs`: number
  - `timestamp`: number
  - `retryAttempt`: number
  - `estimatedCost`: number
- **ToolCallEvent**:
  - `toolName`: string
  - `status`: "success" | "error"
  - `latencyMs`: number
  - `rawOutputBytes`: number
  - `truncatedOutputBytes`: number
  - `artifactReference`?: string (if full output stored externally)
- **TelemetrySummary**:
  - `totalEstimatedCost`: number
  - `totalTokens`: `{ input: number, output: number, cached?: number }`
  - `retryCount`: number
  - `mostExpensiveModel`: string
  - `mostExpensivePhase`: string (AgentType)
  - `toolOutputContributionBytes`: number
- **TelemetryLedger**:
  - Class that maintains arrays of `ModelCallEvent` and `ToolCallEvent`.
  - Method `recordModelCall(event)`
  - Method `recordToolCall(event)`
  - Method `getSummary(): TelemetrySummary`

### 3. HarnessExecutor Integration
- **Initialization**: Create `const ledger = new TelemetryLedger()` at the top of `HarnessExecutor.execute`.
- **Model Calls**: 
  - Wrap `provider.message()` to track start and end time.
  - Calculate cost using the pricing utility (pass in the provider from `this.options.provider.name` and the model used).
  - Record the `ModelCallEvent`.
- **Tool Calls**:
  - Wrap tool execution to track start and end time.
  - Serialize the raw result to calculate `rawOutputBytes`.
  - Calculate `truncatedOutputBytes` from the result of `boundSerializedToolResult`.
  - Record `ToolCallEvent` with success/error status.
- **Retries**: 
  - The loop in `HarnessExecutor` represents iterations of agent thought, not necessarily retries of failures. If a provider fails and we retry, we can catch it. Currently, failures throw and end the turn. The `retryCount` will represent model errors that are recovered from (if any exist) or tool error iterations.

### 4. End of Run Delivery
- **Workspace File**: Write the serialized ledger and summary to `.autoforge-telemetry.json` in `task.workspace` just before returning the final `AgentResult`.
- **Agent Result**: 
  - Update `AgentResult.metrics` interface in `src/executors/interface.ts` to include a `telemetry?: TelemetrySummary & { events: { models: ModelCallEvent[], tools: ToolCallEvent[] } }` field.
  - Attach the summary and events to the final result returned by `finalize()`, `timeoutResult()`, or failure paths.

## Error Handling
- Telemetry gathering must not throw errors that interrupt the main agent loop.
- Pricing lookups should default to 0 if a model is not found, logging a warning instead of failing.
- Writing the `.autoforge-telemetry.json` file should be a best-effort operation (try/catch around `workspace.writeFile`).

## Testing
- Add unit tests for the pricing utility (`tests/unit/pricing.test.ts`).
- Add unit tests for the `TelemetryLedger` calculation logic (`tests/unit/telemetry.test.ts`).
- Update `tests/unit/harness-executor.test.ts` to verify telemetry file writing and metric attachments.