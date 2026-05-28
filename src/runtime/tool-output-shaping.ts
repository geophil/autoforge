import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Workspace } from "./workspace";

export type ToolOutputMode = "summary" | "excerpt" | "full";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export interface ExecArtifact {
  kind: "exec";
  toolUseId: string;
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  signal?: string;
  stdout: string;
  stderr: string;
  createdAt: string;
}

export interface McpArtifact {
  kind: "mcp" | "qmd";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  text: string;
  isError: boolean;
  createdAt: string;
}

export type ToolResultArtifact = ExecArtifact | McpArtifact;

export interface ShapedToolOutput {
  content: string;
  rawOutputBytes: number;
  artifactBytes?: number;
  summaryBytes?: number;
  returnedToModelBytes: number;
  outputMode?: ToolOutputMode;
  parser?: string;
  artifactReference?: string;
  fullOutputReason?: string;
  shaped?: boolean;
}

const TOOL_RESULT_DIR = ".autoforge/tool-results";
const AUTOFORGE_GITIGNORE = ".autoforge/.gitignore";
const SUMMARY_EXCERPT_CHARS = 1200;
const EXCERPT_CHARS = 6000;
const DEFAULT_MCP_SHAPE_THRESHOLD_CHARS = 8192;

export class ToolResultShaper {
  constructor(private readonly options: { mcpShapeThresholdChars?: number } = {}) {}

  shapeExecResult(args: {
    workspace: Workspace;
    toolUseId: string;
    input: Record<string, unknown>;
    result: ExecResult;
  }): Promise<ShapedToolOutput> {
    return shapeExecToolOutput(args);
  }

  shapeMcpResult(args: {
    workspace: Workspace;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    text: string;
    isError?: boolean;
  }): Promise<ShapedToolOutput> {
    return shapeMcpToolOutput({
      ...args,
      thresholdChars: this.options.mcpShapeThresholdChars ?? DEFAULT_MCP_SHAPE_THRESHOLD_CHARS
    });
  }

  readArtifact(args: {
    workspace: Workspace;
    artifactReference: string;
    mode: ToolOutputMode;
    reason?: string;
  }): Promise<ShapedToolOutput> {
    return readToolArtifact(args);
  }
}

export function isInternalToolResultPath(path: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(path);
  if (normalized === null) return false;
  return normalized === TOOL_RESULT_DIR || normalized.startsWith(`${TOOL_RESULT_DIR}/`);
}

export function isExecResult(value: unknown): value is ExecResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { stdout?: unknown }).stdout === "string" &&
    typeof (value as { stderr?: unknown }).stderr === "string" &&
    typeof (value as { exitCode?: unknown }).exitCode === "number"
  );
}

export async function shapeExecToolOutput(args: {
  workspace: Workspace;
  toolUseId: string;
  input: Record<string, unknown>;
  result: ExecResult;
}): Promise<ShapedToolOutput> {
  const mode = parseOutputMode(args.input.outputMode);
  const reason = optionalString(args.input.reason);
  const artifact = execArtifact(args);
  const artifactReference = `${TOOL_RESULT_DIR}/${safeName(args.toolUseId)}-${randomUUID()}.json`;
  const artifactJson = JSON.stringify(artifact, null, 2);
  await writeIgnoredInternalArtifact(args.workspace, artifactReference, artifactJson);

  const parsed = summarizeExecArtifact(artifact);
  const fullAllowed = mode !== "full" || (reason && reason.trim().length > 0);
  const returned = renderExecReturn({
    artifact,
    parser: parsed.parser,
    keyFindings: parsed.keyFindings,
    relevantPaths: parsed.relevantPaths,
    mode: fullAllowed ? mode : "summary",
    artifactReference,
    reason,
    fullDenied: mode === "full" && !fullAllowed
  });
  const content = JSON.stringify(returned, null, 2);

  return {
    content,
    rawOutputBytes: bytes(rawExecText(artifact)),
    artifactBytes: bytes(artifactJson),
    summaryBytes: bytes(JSON.stringify(renderExecReturn({
      artifact,
      parser: parsed.parser,
      keyFindings: parsed.keyFindings,
      relevantPaths: parsed.relevantPaths,
      mode: "summary",
      artifactReference,
      reason
    }))),
    returnedToModelBytes: bytes(content),
    outputMode: fullAllowed ? mode : "summary",
    parser: parsed.parser,
    artifactReference,
    fullOutputReason: mode === "full" ? reason ?? "" : undefined,
    shaped: true
  };
}

export async function shapeMcpToolOutput(args: {
  workspace: Workspace;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  text: string;
  isError?: boolean;
  thresholdChars?: number;
}): Promise<ShapedToolOutput> {
  const rawOutputBytes = bytes(args.text);
  const threshold = args.thresholdChars ?? DEFAULT_MCP_SHAPE_THRESHOLD_CHARS;
  if (args.text.length <= threshold) {
    return {
      content: args.text,
      rawOutputBytes,
      returnedToModelBytes: rawOutputBytes,
      parser: "mcp_passthrough",
      shaped: false
    };
  }

  const artifact = mcpArtifact(args);
  const artifactReference = `${TOOL_RESULT_DIR}/${safeName(args.toolUseId)}-${randomUUID()}.json`;
  const artifactJson = JSON.stringify(artifact, null, 2);
  await writeIgnoredInternalArtifact(args.workspace, artifactReference, artifactJson);

  const parsed = summarizeMcpArtifact(artifact);
  const returned = renderMcpReturn({
    artifact,
    parser: parsed.parser,
    keyFindings: parsed.keyFindings,
    relevantPaths: parsed.relevantPaths,
    mode: "summary",
    artifactReference
  });
  const content = JSON.stringify(returned, null, 2);

  return {
    content,
    rawOutputBytes,
    artifactBytes: bytes(artifactJson),
    summaryBytes: bytes(JSON.stringify(returned)),
    returnedToModelBytes: bytes(content),
    outputMode: "summary",
    parser: parsed.parser,
    artifactReference,
    shaped: true
  };
}

export async function readToolArtifact(args: {
  workspace: Workspace;
  artifactReference: string;
  mode: ToolOutputMode;
  reason?: string;
}): Promise<ShapedToolOutput> {
  const artifactReference = normalizeArtifactReference(args.artifactReference);
  const raw = await args.workspace.readFile(artifactReference);
  const artifact = JSON.parse(raw) as ToolResultArtifact;
  if (artifact.kind === "exec") {
    return readExecArtifact({ artifact, artifactReference, raw, mode: args.mode, reason: args.reason });
  }
  if (artifact.kind === "mcp" || artifact.kind === "qmd") {
    return readMcpArtifact({ artifact, artifactReference, raw, mode: args.mode, reason: args.reason });
  }
  throw new Error(`Unsupported tool artifact kind: ${(artifact as { kind?: unknown }).kind}`);
}

export async function readExecToolArtifact(args: {
  workspace: Workspace;
  artifactReference: string;
  mode: ToolOutputMode;
  reason?: string;
}): Promise<ShapedToolOutput> {
  return readToolArtifact(args);
}

function readExecArtifact(args: {
  artifact: ExecArtifact;
  artifactReference: string;
  raw: string;
  mode: ToolOutputMode;
  reason?: string;
}): ShapedToolOutput {
  if (args.artifact.kind !== "exec") {
    throw new Error(`Unsupported tool artifact kind: ${(args.artifact as { kind?: unknown }).kind}`);
  }
  if (args.mode === "full" && (!args.reason || args.reason.trim().length === 0)) {
    throw new Error("Reading a full tool artifact requires a reason");
  }
  const parsed = summarizeExecArtifact(args.artifact);
  const returned = renderExecReturn({
    artifact: args.artifact,
    parser: parsed.parser,
    keyFindings: parsed.keyFindings,
    relevantPaths: parsed.relevantPaths,
    mode: args.mode,
    artifactReference: args.artifactReference,
    reason: args.reason
  });
  const content = JSON.stringify(returned, null, 2);
  return {
    content,
    rawOutputBytes: bytes(rawExecText(args.artifact)),
    artifactBytes: bytes(args.raw),
    summaryBytes: bytes(JSON.stringify(renderExecReturn({
      artifact: args.artifact,
      parser: parsed.parser,
      keyFindings: parsed.keyFindings,
      relevantPaths: parsed.relevantPaths,
      mode: "summary",
      artifactReference: args.artifactReference,
      reason: args.reason
    }))),
    returnedToModelBytes: bytes(content),
    outputMode: args.mode,
    parser: parsed.parser,
    artifactReference: args.artifactReference,
    fullOutputReason: args.mode === "full" ? args.reason : undefined,
    shaped: true
  };
}

function readMcpArtifact(args: {
  artifact: McpArtifact;
  artifactReference: string;
  raw: string;
  mode: ToolOutputMode;
  reason?: string;
}): ShapedToolOutput {
  if (args.mode === "full" && (!args.reason || args.reason.trim().length === 0)) {
    throw new Error("Reading a full tool artifact requires a reason");
  }
  const parsed = summarizeMcpArtifact(args.artifact);
  const returned = renderMcpReturn({
    artifact: args.artifact,
    parser: parsed.parser,
    keyFindings: parsed.keyFindings,
    relevantPaths: parsed.relevantPaths,
    mode: args.mode,
    artifactReference: args.artifactReference,
    reason: args.reason
  });
  const content = JSON.stringify(returned, null, 2);
  return {
    content,
    rawOutputBytes: bytes(args.artifact.text),
    artifactBytes: bytes(args.raw),
    summaryBytes: bytes(JSON.stringify(renderMcpReturn({
      artifact: args.artifact,
      parser: parsed.parser,
      keyFindings: parsed.keyFindings,
      relevantPaths: parsed.relevantPaths,
      mode: "summary",
      artifactReference: args.artifactReference,
      reason: args.reason
    }))),
    returnedToModelBytes: bytes(content),
    outputMode: args.mode,
    parser: parsed.parser,
    artifactReference: args.artifactReference,
    fullOutputReason: args.mode === "full" ? args.reason : undefined,
    shaped: true
  };
}

function execArtifact(args: {
  toolUseId: string;
  input: Record<string, unknown>;
  result: ExecResult;
}): ExecArtifact {
  return {
    kind: "exec",
    toolUseId: args.toolUseId,
    command: typeof args.input.cmd === "string" ? args.input.cmd : "",
    args: Array.isArray(args.input.args) ? args.input.args.filter((arg): arg is string => typeof arg === "string") : [],
    cwd: typeof args.input.cwd === "string" ? args.input.cwd : undefined,
    exitCode: args.result.exitCode,
    signal: args.result.signal,
    stdout: args.result.stdout,
    stderr: args.result.stderr,
    createdAt: new Date().toISOString()
  };
}

function mcpArtifact(args: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  text: string;
  isError?: boolean;
}): McpArtifact {
  return {
    kind: "qmd",
    toolUseId: args.toolUseId,
    toolName: args.toolName,
    input: args.input,
    text: args.text,
    isError: args.isError === true,
    createdAt: new Date().toISOString()
  };
}

function summarizeExecArtifact(artifact: ExecArtifact): {
  parser: string;
  keyFindings: string[];
  relevantPaths: string[];
} {
  const combined = rawExecText(artifact);
  const parser = detectParser(artifact, combined);
  const relevantPaths = extractPaths(combined);
  const keyFindings = extractKeyFindings(combined, parser);
  if (keyFindings.length === 0) {
    const source = artifact.stderr.trim().length > 0 ? artifact.stderr : artifact.stdout;
    keyFindings.push(...importantLines(source).slice(0, 8));
  }
  return {
    parser,
    keyFindings: keyFindings.slice(0, 12),
    relevantPaths: relevantPaths.slice(0, 20)
  };
}

function renderExecReturn(args: {
  artifact: ExecArtifact;
  parser: string;
  keyFindings: string[];
  relevantPaths: string[];
  mode: ToolOutputMode;
  artifactReference: string;
  reason?: string;
  fullDenied?: boolean;
}): Record<string, unknown> {
  const raw = rawExecText(args.artifact);
  const base = {
    tool: "exec",
    command: [args.artifact.command, ...args.artifact.args].filter(Boolean).join(" "),
    cwd: args.artifact.cwd ?? ".",
    status: args.artifact.exitCode === 0 ? "success" : "failed",
    exitCode: args.artifact.exitCode,
    signal: args.artifact.signal ?? null,
    parser: args.parser,
    keyFindings: args.keyFindings,
    relevantPaths: args.relevantPaths,
    artifactReference: args.artifactReference,
    rawBytes: bytes(raw),
    stdoutBytes: bytes(args.artifact.stdout),
    stderrBytes: bytes(args.artifact.stderr),
    outputMode: args.mode,
    truncated: args.mode !== "full",
    fullOutputDenied: args.fullDenied === true,
    fullOutputReason: args.mode === "full" ? args.reason ?? null : null
  };
  if (args.mode === "full") {
    return { ...base, stdout: args.artifact.stdout, stderr: args.artifact.stderr };
  }
  const excerptSource = args.artifact.stderr.trim().length > 0 ? args.artifact.stderr : args.artifact.stdout;
  return {
    ...base,
    excerpts: excerpt(excerptSource, args.mode === "excerpt" ? EXCERPT_CHARS : SUMMARY_EXCERPT_CHARS)
  };
}

function summarizeMcpArtifact(artifact: McpArtifact): {
  parser: string;
  keyFindings: string[];
  relevantPaths: string[];
} {
  const relevantPaths = extractPaths(artifact.text);
  const headingLines = artifact.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,4}\s+\S/.test(line))
    .slice(0, 10);
  const keyFindings = headingLines.length > 0 ? headingLines : importantLines(artifact.text).slice(0, 8);
  return {
    parser: `qmd_${artifact.toolName}`,
    keyFindings: keyFindings.slice(0, 12),
    relevantPaths: relevantPaths.slice(0, 20)
  };
}

function renderMcpReturn(args: {
  artifact: McpArtifact;
  parser: string;
  keyFindings: string[];
  relevantPaths: string[];
  mode: ToolOutputMode;
  artifactReference: string;
  reason?: string;
}): Record<string, unknown> {
  const base = {
    tool: args.artifact.toolName,
    toolKind: args.artifact.kind,
    status: args.artifact.isError ? "error" : "success",
    parser: args.parser,
    keyFindings: args.keyFindings,
    relevantPaths: args.relevantPaths,
    artifactReference: args.artifactReference,
    rawBytes: bytes(args.artifact.text),
    outputMode: args.mode,
    truncated: args.mode !== "full",
    fullOutputReason: args.mode === "full" ? args.reason ?? null : null
  };
  if (args.mode === "full") {
    return { ...base, text: args.artifact.text };
  }
  return {
    ...base,
    excerpts: excerpt(args.artifact.text, args.mode === "excerpt" ? EXCERPT_CHARS : SUMMARY_EXCERPT_CHARS)
  };
}

async function writeIgnoredInternalArtifact(workspace: Workspace, path: string, content: string): Promise<void> {
  await workspace.writeFile(AUTOFORGE_GITIGNORE, "*\n");
  await workspace.writeFile(path, content);
}

function detectParser(artifact: ExecArtifact, text: string): string {
  const command = [artifact.command, ...artifact.args].join(" ");
  if (/\b(tsc|typescript)\b/i.test(command) || /\bTS\d{4}\b/.test(text)) return "typescript";
  if (/\b(eslint|lint)\b/i.test(command) || /ESLint/i.test(text)) return "lint";
  if (/\b(test|vitest|jest|bun test)\b/i.test(command) || /(FAIL|failed|pass|passed)/i.test(text)) return "test";
  if (/\b(build|vite|webpack|rollup)\b/i.test(command)) return "build";
  if (/\b(rg|grep)\b/i.test(command)) return "search";
  return artifact.exitCode === 0 ? "generic_success" : "generic_failure";
}

function extractKeyFindings(text: string, parser: string): string[] {
  const patterns: RegExp[] = [];
  if (parser === "typescript") patterns.push(/TS\d{4}/i, /error/i);
  if (parser === "lint") patterns.push(/error/i, /warning/i, /eslint/i);
  if (parser === "test") patterns.push(/fail/i, /error/i, /expected/i, /received/i);
  if (parser === "build") patterns.push(/error/i, /failed/i);
  if (parser === "search") patterns.push(/^[^:\n]+:\d+:/);
  if (patterns.length === 0) patterns.push(/error/i, /failed/i, /exception/i);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && patterns.some((pattern) => pattern.test(line)))
    .slice(0, 20);
}

function importantLines(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 10) return lines;
  return [...lines.slice(0, 5), `... ${lines.length - 10} lines omitted ...`, ...lines.slice(-5)];
}

function extractPaths(text: string): string[] {
  const paths = new Set<string>();
  const pathPattern = /(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yml|yaml|toml|sh))(?::\d+(?::\d+)?)?/g;
  for (const match of text.matchAll(pathPattern)) {
    const path = match[1]?.replace(/^\.?\//, "");
    if (path && !path.startsWith("node_modules/")) paths.add(path);
  }
  return [...paths].sort();
}

function excerpt(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length === 0 ? [] : [text];
  const half = Math.floor((maxChars - 80) / 2);
  return [
    text.slice(0, half),
    `... ${text.length - half * 2} chars omitted; use read_tool_artifact for more ...`,
    text.slice(text.length - half)
  ];
}

function rawExecText(artifact: Pick<ExecArtifact, "stdout" | "stderr">): string {
  return [`----- stdout -----`, artifact.stdout, `----- stderr -----`, artifact.stderr].join("\n");
}

function parseOutputMode(value: unknown): ToolOutputMode {
  return value === "excerpt" || value === "full" || value === "summary" ? value : "summary";
}

function normalizeArtifactReference(path: string): string {
  const normalized = normalizeWorkspaceRelativePath(path);
  if (!normalized || !isInternalToolResultPath(normalized)) {
    throw new Error(`Unsupported tool artifact reference: ${path}`);
  }
  return normalized;
}

function normalizeWorkspaceRelativePath(path: string): string | null {
  const normalized = posix.normalize(path).replace(/^\/+/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "tool";
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
