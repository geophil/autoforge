import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ExecEvent, ExecOptions, Workspace } from "./workspace";

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
    const target = this.resolveInsideRoot(path);
    await this.assertRealPathInsideRoot(target, path);
    return readFile(target, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.resolveInsideRoot(path);
    await this.assertWritablePathInsideRoot(target, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async *exec(cmd: string, args: string[], opts: ExecOptions = {}): AsyncIterable<ExecEvent> {
    const cwd = opts.cwd ? this.resolveInsideRoot(opts.cwd) : this.rootPath;
    await this.assertRealPathInsideRoot(cwd, opts.cwd ?? ".");

    yield* spawnStreaming(cmd, args, {
      cwd,
      env: { ...process.env, ...opts.env },
      timeoutSeconds: opts.timeoutSeconds
    });
  }

  async destroy(): Promise<void> {
    // Local worktrees are owned by WorktreeManager; destroy is lifecycle-only.
  }

  private resolveInsideRoot(path: string): string {
    const target = resolve(this.rootPath, path);
    if (target !== this.rootPath && !target.startsWith(`${this.rootPath}${sep}`)) {
      throw new Error(`Path is outside workspace root: ${path}`);
    }
    return target;
  }

  private async assertRealPathInsideRoot(target: string, originalPath: string): Promise<void> {
    const [rootRealPath, targetRealPath] = await Promise.all([
      realpath(this.rootPath),
      realpath(target)
    ]);
    if (!isPathInside(targetRealPath, rootRealPath)) {
      throw new Error(`Path is outside workspace root: ${originalPath}`);
    }
  }

  private async assertWritablePathInsideRoot(target: string, originalPath: string): Promise<void> {
    const rootRealPath = await realpath(this.rootPath);

    try {
      const targetRealPath = await realpath(target);
      if (!isPathInside(targetRealPath, rootRealPath)) {
        throw new Error(`Path is outside workspace root: ${originalPath}`);
      }
      return;
    } catch (error) {
      if (error instanceof Error && !isMissingPathError(error)) {
        throw error;
      }
    }

    let ancestor = dirname(target);
    while (ancestor !== dirname(ancestor)) {
      try {
        const ancestorRealPath = await realpath(ancestor);
        if (!isPathInside(ancestorRealPath, rootRealPath)) {
          throw new Error(`Path is outside workspace root: ${originalPath}`);
        }
        return;
      } catch (error) {
        if (error instanceof Error && !isMissingPathError(error)) {
          throw error;
        }
        ancestor = dirname(ancestor);
      }
    }

    throw new Error(`Path is outside workspace root: ${originalPath}`);
  }
}

export function requireLocalWorkspaceRoot(workspace: Workspace): string {
  if (workspace instanceof LocalWorkspace) {
    return workspace.rootPath;
  }
  throw new Error(`Executor requires a local workspace, got provider: ${workspace.provider}`);
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isMissingPathError(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
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
