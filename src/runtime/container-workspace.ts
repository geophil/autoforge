import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  dockerContainerName,
  DockerCliContainerRunner,
  type ContainerRunner
} from "./container-runner";
import type { ExecEvent, ExecOptions, Workspace } from "./workspace";
import {
  assertRealPathInsideRoot,
  assertWritablePathInsideRoot,
  resolveInsideRoot
} from "./workspace-paths";

export interface ContainerWorkspaceOptions {
  rootPath: string;
  taskId: string;
  dispatchId: string;
  image: string;
  network: string;
  cpus: string;
  memory: string;
  // Numeric uid/gid the container runs as. Must exist in the image, or match
  // the host worktree's owner if the image runs as root and we want bind-mount
  // writes to be owned by a non-root user. Defaults baked in for the
  // autoforge-agent image (1000:1000); see docker/autoforge-agent/Dockerfile.
  uid?: number;
  gid?: number;
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
      // Image-defined defaults rather than process.getuid/getgid: the host
      // user almost never exists inside the image (especially on macOS Docker
      // Desktop), and arbitrary `-u <hostUid>:<hostGid>` makes the container
      // run as a UID with no /etc/passwd entry, breaking many tools.
      uid: options.uid ?? 1000,
      gid: options.gid ?? 1000
    });
    try {
      await runner.start(containerId);
    } catch (startError) {
      try {
        await runner.destroy(containerId);
      } catch (destroyError) {
        console.warn(
          `[container-workspace] failed to clean up container ${containerId} after start failure: ${
            destroyError instanceof Error ? destroyError.message : String(destroyError)
          }`
        );
      }
      throw startError;
    }
    return new ContainerWorkspace({ ...options, rootPath }, runner, containerId);
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
    // Strict check: the cwd must EXIST when we exec. The previous version
    // used the writable-path check that tolerated missing leaves, which
    // would happily run `docker exec -w /workspace/does-not-exist` and hand
    // the user a confusing failure inside the container. Match LocalWorkspace.
    await assertRealPathInsideRoot(this.rootPath, cwd, opts.cwd ?? ".");
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
}
