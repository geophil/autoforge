import type { ExecEvent } from "./workspace";

/**
 * Drain an `AsyncIterable<ExecEvent>` from `Workspace.exec` into a
 * spawnSync-shaped result. Used by callers that historically used
 * `spawnSync` and want a one-shot `{ stdout, stderr, exitCode }` object
 * without writing the same drain loop repeatedly. Adds a `timedOut` flag
 * derived from the exit code (124 is the conventional timeout exit code
 * used by `spawnDocker` and `spawnStreaming`).
 */
export async function collectExecEvents(events: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  timedOut: boolean;
}> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let signal: string | undefined;

  for await (const event of events) {
    if (event.kind === "stdout") stdout += event.chunk;
    if (event.kind === "stderr") stderr += event.chunk;
    if (event.kind === "exit") {
      exitCode = event.exitCode;
      signal = event.signal;
    }
  }

  return {
    stdout,
    stderr,
    exitCode,
    ...(signal ? { signal } : {}),
    timedOut: exitCode === 124 || signal === "SIGTERM"
  };
}
