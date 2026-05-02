import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type LifecycleHookPhase = "post_coder_pre_review" | "pre_pr_gate";

const ALLOWED_SCRIPTS_BY_PHASE: Record<LifecycleHookPhase, string[]> = {
  post_coder_pre_review: ["format", "lint:fix", "lint", "test"],
  pre_pr_gate: ["lint", "test"]
};

const READ_ONLY_PHASES: ReadonlySet<LifecycleHookPhase> = new Set(["pre_pr_gate"]);
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_STREAM_EXCERPT_BYTES = 16 * 1024;
const HOOK_LOG_DIR = ".autoforge/hooks";
const HOOK_COMMIT_AUTHOR_NAME = "Autoforge Hook";
const HOOK_COMMIT_AUTHOR_EMAIL = "hooks@autoforge.local";

export interface LifecycleHookRun {
  phase: LifecycleHookPhase;
  script: string | null;
  command: string | null;
  skipped: boolean;
  skipReason: string | null;
  result: "completed" | "failed";
  failureReason: string | null;
  exitCode: number | null;
  timedOut: boolean;
  elapsedSeconds: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  logPath: string | null;
  changedFileCount: number;
  linesAdded: number;
  linesDeleted: number;
  committed: boolean;
  commitSha: string | null;
}

export interface LifecycleHooksResult {
  phase: LifecycleHookPhase;
  runs: LifecycleHookRun[];
  failedRun: LifecycleHookRun | null;
}

export function discoverLifecycleHookScripts(
  phase: LifecycleHookPhase,
  workingDirectory: string
): { scripts: string[]; skipReason: string | null } {
  const packageJsonPath = join(workingDirectory, "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return { scripts: [], skipReason: "package_json_missing_or_invalid" };
  }

  const scriptsRecord =
    packageJson &&
    typeof packageJson === "object" &&
    "scripts" in packageJson &&
    typeof (packageJson as { scripts?: unknown }).scripts === "object" &&
    (packageJson as { scripts?: unknown }).scripts !== null
      ? ((packageJson as { scripts: Record<string, unknown> }).scripts)
      : {};

  const selected = ALLOWED_SCRIPTS_BY_PHASE[phase].filter(
    (script) =>
      typeof scriptsRecord[script] === "string" &&
      String(scriptsRecord[script]).trim().length > 0
  );

  if (selected.length === 0) {
    return { scripts: [], skipReason: "no_allowlisted_scripts_defined" };
  }
  return { scripts: selected, skipReason: null };
}

export function runLifecycleHooks(input: {
  phase: LifecycleHookPhase;
  workingDirectory: string;
  timeoutSeconds?: number;
}): LifecycleHooksResult {
  const timeoutSeconds = Math.max(1, input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const discovery = discoverLifecycleHookScripts(input.phase, input.workingDirectory);

  if (discovery.scripts.length === 0) {
    return {
      phase: input.phase,
      failedRun: null,
      runs: [
        {
          phase: input.phase,
          script: null,
          command: null,
          skipped: true,
          skipReason: discovery.skipReason,
          result: "completed",
          failureReason: null,
          exitCode: 0,
          timedOut: false,
          elapsedSeconds: 0,
          stdoutExcerpt: "",
          stderrExcerpt: "",
          logPath: null,
          changedFileCount: 0,
          linesAdded: 0,
          linesDeleted: 0,
          committed: false,
          commitSha: null
        }
      ]
    };
  }

  const runs: LifecycleHookRun[] = [];
  for (const script of discovery.scripts) {
    const run = runSingleHook({
      phase: input.phase,
      script,
      workingDirectory: input.workingDirectory,
      timeoutSeconds
    });
    runs.push(run);
    if (run.result === "failed") {
      return { phase: input.phase, runs, failedRun: run };
    }
  }

  return { phase: input.phase, runs, failedRun: null };
}

function runSingleHook(input: {
  phase: LifecycleHookPhase;
  script: string;
  workingDirectory: string;
  timeoutSeconds: number;
}): LifecycleHookRun {
  const command = `bun run ${input.script}`;
  const startMs = Date.now();
  const result = spawnSync("bun", ["run", input.script], {
    cwd: input.workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: input.timeoutSeconds * 1000
  });
  const elapsedSeconds = (Date.now() - startMs) / 1000;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const logPath = writeHookLog({
    workingDirectory: input.workingDirectory,
    phase: input.phase,
    script: input.script,
    command,
    stdout,
    stderr,
    elapsedSeconds,
    exitCode: result.status
  });

  const timedOut = isTimeoutResult(result);
  const baseRun: LifecycleHookRun = {
    phase: input.phase,
    script: input.script,
    command,
    skipped: false,
    skipReason: null,
    result: "completed",
    failureReason: null,
    exitCode: result.status ?? (timedOut ? 124 : 1),
    timedOut,
    elapsedSeconds,
    stdoutExcerpt: truncateForEvent(stdout),
    stderrExcerpt: truncateForEvent(stderr),
    logPath,
    changedFileCount: 0,
    linesAdded: 0,
    linesDeleted: 0,
    committed: false,
    commitSha: null
  };

  if (timedOut) {
    return {
      ...baseRun,
      result: "failed",
      failureReason: "timeout"
    };
  }
  if (result.status !== 0) {
    return {
      ...baseRun,
      result: "failed",
      failureReason: "non_zero_exit"
    };
  }

  if (isGitRepo(input.workingDirectory)) {
    const workingStats = collectWorkingTreeDiffStats(input.workingDirectory);
    if (READ_ONLY_PHASES.has(input.phase) && workingStats.changedFileCount > 0) {
      return {
        ...baseRun,
        result: "failed",
        failureReason: "mutated_files_in_readonly_phase",
        changedFileCount: workingStats.changedFileCount,
        linesAdded: workingStats.linesAdded,
        linesDeleted: workingStats.linesDeleted
      };
    }

    if (input.phase === "post_coder_pre_review" && workingStats.changedFileCount > 0) {
      const committed = commitHookChanges(input.workingDirectory, input.phase, input.script);
      if (!committed.ok) {
        return {
          ...baseRun,
          result: "failed",
          failureReason: committed.errorReason,
          changedFileCount: committed.changedFileCount,
          linesAdded: committed.linesAdded,
          linesDeleted: committed.linesDeleted,
          stderrExcerpt: truncateForEvent([stderr, committed.errorDetail].filter(Boolean).join("\n"))
        };
      }
      return {
        ...baseRun,
        changedFileCount: committed.changedFileCount,
        linesAdded: committed.linesAdded,
        linesDeleted: committed.linesDeleted,
        committed: committed.committed,
        commitSha: committed.commitSha
      };
    }
  }

  return baseRun;
}

function writeHookLog(input: {
  workingDirectory: string;
  phase: LifecycleHookPhase;
  script: string;
  command: string;
  stdout: string;
  stderr: string;
  elapsedSeconds: number;
  exitCode: number | null;
}): string {
  const logDir = join(input.workingDirectory, HOOK_LOG_DIR);
  mkdirSync(logDir, { recursive: true });
  // Self-ignoring `.gitignore` so the orchestrator's hook log files don't show
  // up as worktree mutations during the post-run dirty check, and don't get
  // swept into post_coder_pre_review commits via `git add -A`.
  const ignoreMarker = join(input.workingDirectory, ".autoforge", ".gitignore");
  try {
    writeFileSync(ignoreMarker, "*\n", { flag: "wx" });
  } catch {
    // Already exists — fine.
  }
  const safeScript = input.script.replace(/[^A-Za-z0-9._-]/g, "_");
  const logPath = join(logDir, `${input.phase}-${safeScript}.log`);
  const lines = [
    `phase=${input.phase}`,
    `script=${input.script}`,
    `command=${input.command}`,
    `exit_code=${input.exitCode ?? "null"}`,
    `elapsed_seconds=${input.elapsedSeconds.toFixed(3)}`,
    "",
    "----- stdout -----",
    input.stdout,
    "",
    "----- stderr -----",
    input.stderr
  ];
  writeFileSync(logPath, lines.join("\n"));
  return logPath;
}

function truncateForEvent(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_STREAM_EXCERPT_BYTES) {
    return value;
  }
  const clipped = bytes.subarray(0, MAX_STREAM_EXCERPT_BYTES).toString("utf8");
  return `${clipped}\n...[truncated ${bytes.length - MAX_STREAM_EXCERPT_BYTES} bytes]`;
}

function isTimeoutResult(result: ReturnType<typeof spawnSync>): boolean {
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return true;
  }
  return result.signal === "SIGTERM" && result.status === null;
}

function isGitRepo(workingDirectory: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  return result.status === 0;
}

function collectWorkingTreeDiffStats(workingDirectory: string): {
  changedFileCount: number;
  linesAdded: number;
  linesDeleted: number;
} {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const changedFiles = (status.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .length;

  const unstaged = parseNumstat(
    spawnSync("git", ["diff", "--numstat"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).stdout ?? ""
  );
  const staged = parseNumstat(
    spawnSync("git", ["diff", "--cached", "--numstat"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).stdout ?? ""
  );
  return {
    changedFileCount: changedFiles,
    linesAdded: unstaged.linesAdded + staged.linesAdded,
    linesDeleted: unstaged.linesDeleted + staged.linesDeleted
  };
}

function commitHookChanges(
  workingDirectory: string,
  phase: LifecycleHookPhase,
  script: string
): {
  ok: boolean;
  errorReason: string | null;
  errorDetail: string | null;
  changedFileCount: number;
  linesAdded: number;
  linesDeleted: number;
  committed: boolean;
  commitSha: string | null;
} {
  const before = collectWorkingTreeDiffStats(workingDirectory);
  if (before.changedFileCount === 0) {
    return {
      ok: true,
      errorReason: null,
      errorDetail: null,
      changedFileCount: 0,
      linesAdded: 0,
      linesDeleted: 0,
      committed: false,
      commitSha: null
    };
  }

  const addResult = spawnSync("git", ["add", "-A"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (addResult.status !== 0) {
    return {
      ok: false,
      errorReason: "git_add_failed",
      errorDetail: addResult.stderr ?? addResult.stdout ?? "",
      changedFileCount: before.changedFileCount,
      linesAdded: before.linesAdded,
      linesDeleted: before.linesDeleted,
      committed: false,
      commitSha: null
    };
  }

  const staged = parseNumstat(
    spawnSync("git", ["diff", "--cached", "--numstat"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).stdout ?? ""
  );

  const commitResult = spawnSync(
    "git",
    [
      "-c", `user.name=${HOOK_COMMIT_AUTHOR_NAME}`,
      "-c", `user.email=${HOOK_COMMIT_AUTHOR_EMAIL}`,
      "commit",
      "-m",
      `autoforge: lifecycle hook ${phase} (${script})`
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (commitResult.status !== 0) {
    return {
      ok: false,
      errorReason: "git_commit_failed",
      errorDetail: commitResult.stderr ?? commitResult.stdout ?? "",
      changedFileCount: staged.changedFileCount,
      linesAdded: staged.linesAdded,
      linesDeleted: staged.linesDeleted,
      committed: false,
      commitSha: null
    };
  }

  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ok: true,
    errorReason: null,
    errorDetail: null,
    changedFileCount: staged.changedFileCount,
    linesAdded: staged.linesAdded,
    linesDeleted: staged.linesDeleted,
    committed: true,
    commitSha: sha.status === 0 ? (sha.stdout ?? "").trim() : null
  };
}

function parseNumstat(output: string): {
  changedFileCount: number;
  linesAdded: number;
  linesDeleted: number;
} {
  let linesAdded = 0;
  let linesDeleted = 0;
  let changedFileCount = 0;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    changedFileCount += 1;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (Number.isFinite(added)) linesAdded += added;
    if (Number.isFinite(deleted)) linesDeleted += deleted;
  }

  return { changedFileCount, linesAdded, linesDeleted };
}
