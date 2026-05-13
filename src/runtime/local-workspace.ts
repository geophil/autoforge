import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnAsExecEvents } from "./spawn-streaming";
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
  /**
   * Optional teardown callback invoked from `destroy()`. When set, the
   * workspace removes its underlying host resource — typically the git
   * worktree + branch via `WorktreeManager.remove`. This mirrors
   * `ContainerWorkspace.destroy`'s container-removal semantics, so both
   * providers honor the same "destroy removes the resource I own" rule.
   * Wiring lives in `WorkspaceFactory.create`; orchestrator-level callers
   * should not construct LocalWorkspace by hand.
   */
  onDestroy?: () => void | Promise<void>;
}

export class LocalWorkspace implements Workspace {
  readonly provider = "local";
  readonly id: string;
  readonly rootPath: string;
  readonly taskId: string;
  readonly dispatchId: string;
  private readonly onDestroy?: () => void | Promise<void>;
  private destroyed = false;

  constructor(options: LocalWorkspaceOptions) {
    this.rootPath = resolve(options.rootPath);
    this.taskId = options.taskId;
    this.dispatchId = options.dispatchId;
    this.id = options.id ?? `${options.taskId}:${options.dispatchId}`;
    this.onDestroy = options.onDestroy;
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

    yield* spawnAsExecEvents(cmd, args, {
      cwd,
      env: childProcessEnv(opts.env),
      timeoutSeconds: opts.timeoutSeconds
    });
  }

  async destroy(): Promise<void> {
    // Idempotent: a second call is a no-op even if the host worktree
    // teardown succeeded the first time.
    if (this.destroyed) return;
    this.destroyed = true;
    await this.onDestroy?.();
  }
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
