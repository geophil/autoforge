export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export type ExecEvent =
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "exit"; exitCode: number; signal?: string };

export interface Workspace {
  readonly id: string;
  readonly provider: "local" | "mock" | "e2b" | "aws" | string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
  destroy(): Promise<void>;
}
