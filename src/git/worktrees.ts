import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";

export interface WorktreeRef {
  branch: string;
  path: string;
  baseRef?: string;
}

const METADATA_FILE = ".autoforge-worktree.json";

export class WorktreeManager {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  /**
   * Create a git branch and worktree for a task.
   * Falls back to a plain directory if not inside a git repo.
   * Installs dependencies if a lock file is present in the worktree.
   */
  create(taskId: string): WorktreeRef {
    const branch = `autoforge/${taskId}`;
    const path = join(this.rootDir, `${taskId}-${randomUUID().slice(0, 8)}`);
    const baseRef = this.currentHead();

    if (this.isGitRepo()) {
      // Ensure branch exists from current HEAD.
      run("git", ["branch", branch], { ignore: true });
      // Add a worktree pointing at that branch.
      const result = spawnSync("git", ["worktree", "add", path, branch], { encoding: "utf8" });
      if (result.status !== 0) {
        // Fallback: plain directory (e.g. branch already has a worktree).
        console.warn(`[git] git worktree add failed (${result.stderr?.trim()}), using plain directory.`);
        mkdirSync(path, { recursive: true });
      }
    } else {
      mkdirSync(path, { recursive: true });
    }

    this.installDependencies(path);
    const ref = { branch, path, baseRef };
    this.writeMetadata(ref);
    return ref;
  }

  /**
   * Stage all changes in the worktree and create a commit.
   * No-op if there is nothing to commit.
   */
  commit(worktree: WorktreeRef, message: string): void {
    if (!this.isGitRepo()) return;
    // Stage everything in the worktree.
    run("git", ["add", "-A"], { cwd: worktree.path, ignore: false });
    // Commit (exit 1 with "nothing to commit" is not an error).
    run("git", ["commit", "--allow-empty-message", "-m", message || "autoforge: agent output"], {
      cwd: worktree.path,
      ignore: true
    });
  }

  /**
   * Find the worktree path for a given taskId by scanning the root directory.
   * Returns null if no matching worktree is found.
   */
  findWorktreePath(taskId: string): string | null {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const entries = readdirSync(this.rootDir);
      const match = entries.find((e) => e.startsWith(taskId));
      return match ? join(this.rootDir, match) : null;
    } catch {
      return null;
    }
  }

  get(taskId: string): WorktreeRef | null {
    const path = this.findWorktreePath(taskId);
    if (!path) {
      return null;
    }

    const metadataPath = join(path, METADATA_FILE);
    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<WorktreeRef>;
      if (!parsed.branch || !parsed.path || !parsed.baseRef) {
        return null;
      }
      return {
        branch: parsed.branch,
        path: parsed.path,
        baseRef: parsed.baseRef
      };
    } catch {
      return null;
    }
  }

  /**
   * Remove the worktree and delete the branch.
   */
  remove(worktree: WorktreeRef): void {
    if (!this.isGitRepo()) return;
    run("git", ["worktree", "remove", "--force", worktree.path], { ignore: true });
    run("git", ["branch", "-D", worktree.branch], { ignore: true });
  }

  /**
   * Detect package manager from lock files and install dependencies.
   * No-op if no lock file is found.
   */
  private installDependencies(worktreePath: string): void {
    const { existsSync } = require("node:fs") as typeof import("node:fs");

    const strategies: Array<{ lockFile: string; cmd: string; args: string[] }> = [
      { lockFile: "bun.lockb", cmd: "bun", args: ["install", "--frozen-lockfile"] },
      { lockFile: "bun.lock", cmd: "bun", args: ["install", "--frozen-lockfile"] },
      { lockFile: "package-lock.json", cmd: "npm", args: ["ci"] },
      { lockFile: "yarn.lock", cmd: "yarn", args: ["install", "--frozen-lockfile"] },
      { lockFile: "pnpm-lock.yaml", cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
    ];

    for (const strategy of strategies) {
      if (existsSync(join(worktreePath, strategy.lockFile))) {
        const result = spawnSync(strategy.cmd, strategy.args, {
          cwd: worktreePath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
        if (result.status !== 0) {
          console.warn(`[worktree] ${strategy.cmd} install failed in ${worktreePath}: ${result.stderr?.trim()}`);
        }
        return;
      }
    }
  }

  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --git-dir", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private currentHead(): string {
    if (!this.isGitRepo()) {
      return "HEAD";
    }

    try {
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "HEAD";
    }
  }

  private writeMetadata(worktree: WorktreeRef): void {
    try {
      writeFileSync(join(worktree.path, METADATA_FILE), JSON.stringify(worktree, null, 2));
    } catch {
      // Best-effort metadata: missing file only means downstream diff capture skips.
    }
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; ignore?: boolean } = {}
): void {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (!opts.ignore && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr?.trim()}`);
  }
}
