# Harness, Workspace, and Provider Design

## Why This Exists

Autoforge needs cloud-runtime support without moving model credentials into a sandbox. The design splits execution into three independent axes:

| Axis | Interface | Current implementation | Future implementation |
|---|---|---|---|
| Where files and commands run | `Workspace` | `LocalWorkspace`, `MockWorkspace` | `E2BWorkspace`, `AwsWorkspace`, `ModalWorkspace` |
| Which model API is called | `ModelProvider` | `AnthropicProvider` | OpenAI or Gemini providers |
| What the agent is | persona + skills | `PersonaRegistry`, `SkillRegistry`, lessons | same |

The important invariant is:

> The harness runs in the orchestrator process. The sandbox runs nothing the harness depends on.

That means model API keys remain with `ModelProvider` in the orchestrator process. `Workspace` implementations expose files and command execution only; they do not hold `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, or similar orchestrator credentials.

## `Workspace` Is the Sandbox Contract

`Workspace` is intentionally small: read a file, write a file, stream command execution, and destroy resources.

```typescript
export interface Workspace {
  readonly id: string;
  readonly provider: "local" | "mock" | "e2b" | "aws" | string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
  destroy(): Promise<void>;
}
```

`LocalWorkspace` backs this with a worktree path. It rejects path traversal, rejects symlink escapes, streams stdout/stderr/exit events from `spawn`, and sanitizes child process environment inheritance so tool calls cannot print orchestrator secrets.

Local destroy is a no-op beyond lifecycle event recording. `WorktreeManager` owns local worktree removal. Future remote workspaces should map `destroy()` to provider cleanup such as ending an E2B session or stopping a cloud task.

## `ModelProvider` Is the Model API Contract

`ModelProvider` normalizes message APIs and tool definitions.

```typescript
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
```

`AnthropicProvider` currently wraps `@anthropic-ai/sdk`. It owns the API client and key, maps normalized tool definitions to Anthropic schemas, preserves stop reasons, and maps usage into `{ input, output }`.

## `HarnessExecutor` Composes Both Axes

`HarnessExecutor` implements `AgentExecutor`. It builds the system prompt from persona, lessons, skills, and status instructions; sends normalized history and tool definitions to the provider; executes `tool_use` blocks through a `ToolRegistry`; and finalizes with `.autoforge-status.json`.

The harness deliberately does not know whether a workspace is local or remote. It only calls `task.workspace`.

Tool behavior:
- `read_file`, `write_file`, `exec`, and `done` are workspace-backed.
- `lookup_skill` and `load_skill` expose on-demand skill loading.
- Tool exceptions become recoverable `tool_result` strings unless they are timeout-style errors.
- Loaded skills are recorded in `AgentTranscript.loadedSkills` and a `loaded_skills` transcript turn.

## Event Log Instead of Runtime Tables

No `runtime_sessions` or `workspaces` SQL table is added. Workspace lifecycle is represented as ordinary events:

- `workspace_created`
- `workspace_destroyed`

`OrchestratorService.localWorkspace()` emits `workspace_created` for dispatch workspaces. Terminal cleanup emits `workspace_destroyed` for any created workspace not already destroyed. `pendingWorkspaceDestroyPayloads()` derives the pending set from event history, which makes repeated cleanup idempotent.

Active workspaces can be answered by querying event history: created workspace IDs minus destroyed workspace IDs.

## WORKSPACE Stream Is Future Plumbing

NATS now provisions a `WORKSPACE` JetStream stream with subjects under `autoforge.workspace.>`.

Reserved subject forms:

- `autoforge.workspace.<workspaceId>.tool.request`
- `autoforge.workspace.<workspaceId>.tool.response.<corrId>`
- `autoforge.workspace.<workspaceId>.tool.stream.<corrId>`

Local tool execution does not use this stream. `LocalWorkspace` still uses direct `fs` and `spawn`. The stream exists so future remote workspace providers can plug in without another eventing redesign.

## Compatibility Decisions

`AgentTask.workingDirectory` was replaced with `AgentTask.workspace`. Existing local executors remain functional through a transitional local-only adapter:

```typescript
const cwd = requireLocalWorkspaceRoot(task.workspace);
```

This makes non-local workspace use fail fast in Claude Code and current SDK executors while `HarnessExecutor` matures toward feature parity.

The `.autoforge-status.json` contract remains intact. The new `done` tool writes the same file and is optional; it does not replace the status-file convention yet.
