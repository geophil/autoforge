import type { AppEnv } from "../config/env";
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
      return new LocalWorkspace(input);
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
