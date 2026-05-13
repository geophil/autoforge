import type { AppEnv } from "../config/env";
import type { WorktreeManager } from "../git/worktrees";
import { buildDockerPreflightChecks } from "./container-diagnostics";
import type { ContainerRunner } from "./container-runner";
import { DockerCliContainerRunner } from "./container-runner";
import { ContainerWorkspace } from "./container-workspace";
import { LocalWorkspace } from "./local-workspace";
import type { Workspace } from "./workspace";

export interface WorkspaceCreateInput {
  rootPath: string;
  taskId: string;
  dispatchId: string;
}

export interface WorkspaceFactoryOptions {
  runner?: ContainerRunner;
  runPreflight?: (cmd: string, args: string[]) => Promise<void>;
  /**
   * Optional WorktreeManager used to wire `LocalWorkspace.onDestroy` so a
   * local workspace's `destroy()` actually removes its host worktree +
   * branch (mirroring ContainerWorkspace's container removal). Omit in
   * tests that want destroy() to remain a no-op; production wires this
   * in `src/index.ts` and `OrchestratorService` so cleanup is symmetric.
   */
  worktreeManager?: WorktreeManager;
}

export class WorkspaceFactory {
  private preflightComplete = false;

  constructor(
    private readonly env: Pick<AppEnv,
      | "WORKSPACE_PROVIDER"
      | "WORKSPACE_DOCKER_IMAGE"
      | "WORKSPACE_DOCKER_NETWORK"
      | "WORKSPACE_DOCKER_CPUS"
      | "WORKSPACE_DOCKER_MEMORY"
      | "WORKSPACE_DOCKER_PRECHECK"
      | "WORKSPACE_DOCKER_UID"
      | "WORKSPACE_DOCKER_GID"
    >,
    private readonly options: WorkspaceFactoryOptions = {}
  ) {}

  async create(input: WorkspaceCreateInput): Promise<Workspace> {
    if (this.env.WORKSPACE_PROVIDER === "local") {
      const worktreeManager = this.options.worktreeManager;
      return new LocalWorkspace({
        ...input,
        onDestroy: worktreeManager
          ? () => worktreeManager.remove({
              branch: `autoforge/${input.taskId}`,
              path: input.rootPath
            })
          : undefined
      });
    }

    if (this.env.WORKSPACE_DOCKER_PRECHECK === "1") {
      await this.preflight();
    }

    return ContainerWorkspace.create({
      ...input,
      image: this.env.WORKSPACE_DOCKER_IMAGE,
      network: this.env.WORKSPACE_DOCKER_NETWORK,
      cpus: this.env.WORKSPACE_DOCKER_CPUS,
      memory: this.env.WORKSPACE_DOCKER_MEMORY,
      uid: this.env.WORKSPACE_DOCKER_UID,
      gid: this.env.WORKSPACE_DOCKER_GID,
      runner: this.options.runner ?? new DockerCliContainerRunner()
    });
  }

  private async preflight(): Promise<void> {
    if (this.preflightComplete) return;
    const run = this.options.runPreflight ?? defaultPreflight;
    for (const check of buildDockerPreflightChecks(this.env.WORKSPACE_DOCKER_IMAGE)) {
      await run(check.cmd, check.args);
    }
    this.preflightComplete = true;
  }
}

async function defaultPreflight(cmd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr.trim() || `${cmd} ${args.join(" ")} failed with exit ${exitCode}`);
  }
}
