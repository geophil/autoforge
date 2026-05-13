import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  dockerContainerName,
  DockerCliContainerRunner,
  type ContainerRunner
} from "./container-runner";
import type { ExecEvent, ExecOptions, Workspace } from "./workspace";

export interface ContainerWorkspaceOptions {
  rootPath: string;
  taskId: string;
  dispatchId: string;
  image: string;
  network: string;
  cpus: string;
  memory: string;
  runner?: ContainerRunner;
}

export class ContainerWorkspace implements Workspace {
  readonly provider = "docker";
  readonly id: string;
  readonly rootPath: string;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly containerId: string;
  private destroyed = false;

  private constructor(
    options: ContainerWorkspaceOptions,
    private readonly runner: ContainerRunner,
    containerId: string
  ) {
    this.rootPath = resolve(options.rootPath);
    this.taskId = options.taskId;
    this.dispatchId = options.dispatchId;
    this.id = `${options.taskId}:${options.dispatchId}`;
    this.containerId = containerId;
  }

  static async create(options: ContainerWorkspaceOptions): Promise<ContainerWorkspace> {
    const runner = options.runner ?? new DockerCliContainerRunner();
    const rootPath = resolve(options.rootPath);
    const name = dockerContainerName(options.taskId, options.dispatchId);
    const containerId = await runner.create({
      name,
      image: options.image,
      rootPath,
      network: options.network,
      cpus: options.cpus,
      memory: options.memory,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000
    });
    await runner.start(containerId);
    return new ContainerWorkspace({ ...options, rootPath }, runner, containerId);
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
    await this.assertWritablePathInsideRoot(cwd, opts.cwd ?? ".");
    const containerCwd = `/workspace${cwd === this.rootPath ? "" : cwd.slice(this.rootPath.length).split(sep).join("/")}`;
    yield* this.runner.exec(this.containerId, cmd, args, {
      cwd: containerCwd,
      env: opts.env,
      timeoutSeconds: opts.timeoutSeconds
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.runner.destroy(this.containerId);
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

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isMissingPathError(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}
