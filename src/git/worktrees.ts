import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreeRef {
  branch: string;
  path: string;
}

export class WorktreeManager {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  create(taskId: string): WorktreeRef {
    const branch = `autoforge/${taskId}`;
    const path = join(this.rootDir, `${taskId}-${randomUUID().slice(0, 8)}`);
    mkdirSync(path, { recursive: true });
    return { branch, path };
  }

  remove(_worktree: WorktreeRef): void {
    // Placeholder for full git worktree lifecycle; local milestone keeps this explicit.
  }
}
