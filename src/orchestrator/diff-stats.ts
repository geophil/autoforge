import { execFileSync } from "node:child_process";

export interface TaskDiffStats {
  files_changed: number;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
}

export interface TaskIterationDiff {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  test_files_changed: number;
  diff_summary: string | null;
}

const TEST_FILE_PATTERN = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;

function parseNumstat(numstat: string): {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  testFilesChanged: number;
} {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  let testFilesChanged = 0;

  const numstatRows = numstat
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const row of numstatRows) {
    const [added, deleted, path] = row.split("\t");
    filesChanged += 1;
    if (added !== "-" && deleted !== "-") {
      linesAdded += Number(added);
      linesDeleted += Number(deleted);
    }
    if (path && TEST_FILE_PATTERN.test(path)) {
      testFilesChanged += 1;
    }
  }

  return { filesChanged, linesAdded, linesDeleted, testFilesChanged };
}

/**
 * Runs git diff commands inside the worktree and parses the result into the
 * row shape stored in task_diff_stats. Returns null when git cannot produce
 * the diff so callers can skip persistence without failing task cleanup.
 */
export function computeDiffStats(worktreePath: string, baseRef: string): TaskDiffStats | null {
  try {
    const diffRange = `${baseRef}...HEAD`;
    const numstat = execFileSync("git", ["diff", "--numstat", diffRange], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const nameStatus = execFileSync("git", ["diff", "--name-status", diffRange], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    const {
      linesAdded,
      linesDeleted,
      testFilesChanged
    } = parseNumstat(numstat);

    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;

    const nameStatusRows = nameStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const row of nameStatusRows) {
      const [status] = row.split("\t");
      const kind = status?.charAt(0);
      if (kind === "A") filesAdded += 1;
      else if (kind === "M") filesModified += 1;
      else if (kind === "D") filesDeleted += 1;
    }

    return {
      files_changed: filesAdded + filesModified + filesDeleted,
      files_added: filesAdded,
      files_modified: filesModified,
      files_deleted: filesDeleted,
      lines_added: linesAdded,
      lines_deleted: linesDeleted,
      test_files_changed: testFilesChanged
    };
  } catch {
    return null;
  }
}

export function computeIterationDiff(
  worktreePath: string,
  fromRef: string,
  toRef: string
): TaskIterationDiff | null {
  try {
    const diffRange = `${fromRef}..${toRef}`;
    const numstat = execFileSync("git", ["diff", "--numstat", diffRange], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const diffSummary = execFileSync("git", ["diff", "--stat", diffRange], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const { filesChanged, linesAdded, linesDeleted, testFilesChanged } = parseNumstat(numstat);

    return {
      files_changed: filesChanged,
      lines_added: linesAdded,
      lines_deleted: linesDeleted,
      test_files_changed: testFilesChanged,
      diff_summary: diffSummary.length > 0 ? diffSummary.slice(0, 500) : null
    };
  } catch {
    return null;
  }
}
