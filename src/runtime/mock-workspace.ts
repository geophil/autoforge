import { posix } from "node:path";
import type { ExecEvent, ExecOptions, Workspace } from "./workspace";

export interface MockCommand {
  cmd: string;
  args?: string[];
  events: ExecEvent[];
}

export interface MockWorkspaceOptions {
  id: string;
  files?: Record<string, string>;
  commands?: MockCommand[];
}

export class MockWorkspace implements Workspace {
  readonly provider = "mock";
  readonly id: string;

  private readonly files = new Map<string, string>();
  private readonly commands: MockCommand[];
  private destroyed = false;

  constructor(options: MockWorkspaceOptions) {
    this.id = options.id;
    this.commands = options.commands ?? [];
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(normalizeWorkspacePath(path), content);
    }
  }

  async readFile(path: string): Promise<string> {
    this.assertActive();
    const normalized = normalizeWorkspacePath(path);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`Mock file not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertActive();
    this.files.set(normalizeWorkspacePath(path), content);
  }

  async *exec(cmd: string, args: string[], _opts: ExecOptions = {}): AsyncIterable<ExecEvent> {
    this.assertActive();
    const command = this.commands.find((candidate) => {
      return candidate.cmd === cmd && JSON.stringify(candidate.args ?? []) === JSON.stringify(args);
    });

    if (!command) {
      yield { kind: "stderr", chunk: `No mock command configured for: ${[cmd, ...args].join(" ")}` };
      yield { kind: "exit", exitCode: 127 };
      return;
    }

    for (const event of command.events) {
      yield event;
    }
    if (!command.events.some((event) => event.kind === "exit")) {
      yield { kind: "exit", exitCode: 0 };
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error(`Workspace ${this.id} has been destroyed`);
    }
  }
}

function normalizeWorkspacePath(path: string): string {
  const normalized = posix.normalize(path).replace(/^\/+/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path is outside workspace root: ${path}`);
  }
  return normalized === "." ? "" : normalized;
}
