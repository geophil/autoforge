import { spawn } from "node:child_process";
import type { ExecEvent } from "./workspace";

export interface SpawnAsExecEventsOptions {
  /** Process working directory. If omitted, the child inherits the parent's cwd. */
  cwd?: string;
  /**
   * Environment for the child process. Pass the full environment you want
   * exposed — this helper does not merge with `process.env` so callers can
   * scrub variables they don't want leaked (e.g. `LocalWorkspace` only forwards
   * `PATH`/`HOME`/`TMPDIR`/`SHELL`). Omit to inherit the parent environment.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Wall-clock guard. The child is SIGTERM'd on expiry and the resulting
   * exit event carries exitCode 124. Omit (or set to 0) for no timeout.
   */
  timeoutSeconds?: number;
}

/**
 * Spawn a child process and yield its stdout/stderr/exit as a stream of
 * `ExecEvent`s. Single source of truth for both `LocalWorkspace.exec` and
 * `DockerCliContainerRunner` (avoiding two near-identical ~80-line
 * implementations of the async-iterable + terminal-event-dedup logic).
 *
 * Semantics:
 * - A synchronous spawn failure (`ENOENT`, etc.) is reported via a `stderr`
 *   chunk plus a synthetic `exit` event with exitCode 127.
 * - Asynchronous `error` events behave the same way, but only the first
 *   terminal event (`error` or `close`) is emitted to keep callers simple.
 * - Timeout expiry kills the child with SIGTERM and reports exitCode 124 if
 *   the OS-reported exit code is null.
 */
export async function* spawnAsExecEvents(
  cmd: string,
  args: string[],
  options: SpawnAsExecEventsOptions = {}
): AsyncIterable<ExecEvent> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    yield { kind: "stderr", chunk: error instanceof Error ? error.message : String(error) };
    yield { kind: "exit", exitCode: 127 };
    return;
  }

  const events: ExecEvent[] = [];
  let closed = false;
  let timedOut = false;
  let terminalEmitted = false;
  let notify: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const push = (event: ExecEvent) => {
    events.push(event);
    notify?.();
    notify = undefined;
  };

  child.stdout?.on("data", (chunk: Buffer) => push({ kind: "stdout", chunk: chunk.toString() }));
  child.stderr?.on("data", (chunk: Buffer) => push({ kind: "stderr", chunk: chunk.toString() }));
  child.on("error", (error) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    push({ kind: "stderr", chunk: error.message });
    push({ kind: "exit", exitCode: 127 });
    closed = true;
    notify?.();
  });
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    if (!terminalEmitted) {
      terminalEmitted = true;
      push({ kind: "exit", exitCode: code ?? (timedOut ? 124 : 1), ...(signal ? { signal } : {}) });
    }
    closed = true;
    notify?.();
  });

  if (options.timeoutSeconds && options.timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);
  }

  while (!closed || events.length > 0) {
    const next = events.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}
