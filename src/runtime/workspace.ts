export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export type ExecEvent =
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "exit"; exitCode: number; signal?: string };

// Closed union of workspace providers in this codebase. Add a string literal
// here when introducing a new Workspace implementation; do NOT add `| string`
// (the previous open form let `"docker"` slip in undeclared).
export type WorkspaceProvider = "local" | "mock" | "docker";

export interface Workspace {
  readonly id: string;
  readonly provider: WorkspaceProvider;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
  destroy(): Promise<void>;
}
