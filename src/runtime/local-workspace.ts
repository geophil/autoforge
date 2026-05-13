import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExecEvent, ExecOptions, Workspace } from "./workspace";
import {
  assertRealPathInsideRoot,
  assertWritablePathInsideRoot,
  resolveInsideRoot
} from "./workspace-paths";

export interface LocalWorkspaceOptions {
  rootPath: string;
  taskId: string;
  dispatchId: string;
  id?: string;
}

export class LocalWorkspace implements Workspace {
  readonly provider = "local";
  readonly id: string;
  readonly rootPath: string;
  readonly taskId: string;
  readonly dispatchId: string;

  constructor(options: LocalWorkspaceOptions) {
    this.rootPath = resolve(options.rootPath);
    this.taskId = options.taskId;
    this.dispatchId = options.dispatchId;
    this.id = options.id ?? `${options.taskId}:${options.dispatchId}`;
  }

  async readFile(path: string): Promise<string> {
    const target = resolveInsideRoot(this.rootPath, path);
    await assertRealPathInsideRoot(this.rootPath, target, path);
    return readFile(target, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = resolveInsideRoot(this.rootPath, path);
    await assertWritablePathInsideRoot(this.rootPath, target, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async *exec(cmd: string, args: string[], opts: ExecOptions = {}): AsyncIterable<ExecEvent> {
    const cwd = opts.cwd ? resolveInsideRoot(this.rootPath, opts.cwd) : this.rootPath;
    await assertRealPathInsideRoot(this.rootPath, cwd, opts.cwd ?? ".");

    yield* spawnStreaming(cmd, args, {
      cwd,
      env: childProcessEnv(opts.env),
      timeoutSeconds: opts.timeoutSeconds
    });
  }

  async destroy(): Promise<void> {
    // Local worktrees are owned by WorktreeManager; destroy is lifecycle-only.
  }
}

export function requireLocalWorkspaceRoot(workspace: Workspace): string {
  if (workspace instanceof LocalWorkspace) {
    return workspace.rootPath;
  }
  throw new Error(`Executor requires a local workspace, got provider: ${workspace.provider}`);
}

function childProcessEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const allowedFromParent = ["PATH", "HOME", "TMPDIR", "SHELL"];
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of allowedFromParent) {
    if (process.env[key] !== undefined) {
      childEnv[key] = process.env[key];
    }
  }
  return { ...childEnv, ...(env ?? {}) };
}

async function* spawnStreaming(
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds?: number }
): AsyncIterable<ExecEvent> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    yield { kind: "stderr", chunk: error instanceof Error ? error.message : String(error) };
    yield { kind: "exit", exitCode: 127 };
    return;
  }

  const events: ExecEvent[] = [];
  let closed = false;
  let timedOut = false;
  let terminalEmitted = false;
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

  if (options.timeoutSeconds && options.timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);
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
