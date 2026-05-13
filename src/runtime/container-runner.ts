import { spawn } from "node:child_process";
import type { ContainerFailureCategory } from "./container-diagnostics";
import { classifyContainerFailure } from "./container-diagnostics";
import type { ExecEvent } from "./workspace";

export interface DockerCreateArgsInput {
  name: string;
  image: string;
  rootPath: string;
  network: string;
  cpus: string;
  memory: string;
  uid: number;
  gid: number;
}

export interface DockerExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface ContainerRunner {
  create(input: DockerCreateArgsInput): Promise<string>;
  start(containerId: string): Promise<void>;
  exec(containerId: string, cmd: string, args: string[], opts?: DockerExecOptions): AsyncIterable<ExecEvent>;
  destroy(containerId: string): Promise<void>;
}

export type RunDocker = (args: string[], opts?: { timeoutSeconds?: number }) => AsyncIterable<ExecEvent>;

export class ContainerRunnerError extends Error {
  constructor(
    readonly category: ContainerFailureCategory,
    readonly reason: string,
    readonly stderr: string
  ) {
    super(`${reason}: ${stderr.trim()}`);
  }
}

export class DockerCliContainerRunner implements ContainerRunner {
  constructor(private readonly options: { runDocker?: RunDocker } = {}) {}

  async create(input: DockerCreateArgsInput): Promise<string> {
    const result = await collect(this.runDocker(buildDockerCreateArgs(input)), "create");
    return result.stdout.trim() || input.name;
  }

  async start(containerId: string): Promise<void> {
    await collect(this.runDocker(["start", containerId]), "start");
  }

  exec(containerId: string, cmd: string, args: string[], opts: DockerExecOptions = {}): AsyncIterable<ExecEvent> {
    const dockerArgs = ["exec"];
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
    dockerArgs.push("-w", opts.cwd ?? "/workspace", containerId, cmd, ...args);
    return this.runDocker(dockerArgs, { timeoutSeconds: opts.timeoutSeconds });
  }

  async destroy(containerId: string): Promise<void> {
    const result = await collectAllowingMissing(this.runDocker(["rm", "-f", containerId]));
    if (result.exitCode !== 0 && !result.stderr.toLowerCase().includes("no such container")) {
      const classification = classifyContainerFailure("cleanup", result.stderr);
      throw new ContainerRunnerError("cleanup", classification.reason, result.stderr);
    }
  }

  private runDocker(args: string[], opts?: { timeoutSeconds?: number }): AsyncIterable<ExecEvent> {
    return (this.options.runDocker ?? spawnDocker)(args, opts);
  }
}

export function dockerContainerName(taskId: string, dispatchId: string): string {
  const suffix = `${taskId}-${dispatchId}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `autoforge-${suffix || "workspace"}`;
}

export function buildDockerCreateArgs(input: DockerCreateArgsInput): string[] {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    "autoforge.workspace=true",
    "--label",
    `autoforge.workspace.id=${input.name}`,
    "--cap-drop=ALL",
    "--network",
    input.network,
    "--cpus",
    input.cpus,
    "--memory",
    input.memory,
    "-u",
    `${input.uid}:${input.gid}`,
    "-v",
    `${input.rootPath}:/workspace`,
    input.image,
    "sleep infinity"
  ];
}

async function collect(
  events: AsyncIterable<ExecEvent>,
  category: ContainerFailureCategory
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await collectAllowingMissing(events);
  if (result.exitCode !== 0) {
    const classification = classifyContainerFailure(category, result.stderr);
    throw new ContainerRunnerError(category, classification.reason, result.stderr);
  }
  return result;
}

async function collectAllowingMissing(events: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for await (const event of events) {
    if (event.kind === "stdout") stdout += event.chunk;
    if (event.kind === "stderr") stderr += event.chunk;
    if (event.kind === "exit") exitCode = event.exitCode;
  }
  return { stdout, stderr, exitCode };
}

async function* spawnDocker(args: string[], opts: { timeoutSeconds?: number } = {}): AsyncIterable<ExecEvent> {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const events: ExecEvent[] = [];
  let closed = false;
  let terminalEmitted = false;
  let timedOut = false;
  let notify: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const push = (event: ExecEvent) => {
    events.push(event);
    notify?.();
    notify = undefined;
  };

  child.stdout?.on("data", (chunk: Buffer) => push({ kind: "stdout", chunk: chunk.toString() }));
  child.stderr?.on("data", (chunk: Buffer) => push({ kind: "stderr", chunk: chunk.toString() }));
  child.on("error", (error) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    push({ kind: "stderr", chunk: error.message });
    push({ kind: "exit", exitCode: 127 });
    closed = true;
    notify?.();
  });
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    if (!terminalEmitted) {
      terminalEmitted = true;
      push({ kind: "exit", exitCode: code ?? (timedOut ? 124 : 1), ...(signal ? { signal } : {}) });
    }
    closed = true;
    notify?.();
  });

  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutSeconds * 1000);
  }

  while (!closed || events.length > 0) {
    const next = events.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}
