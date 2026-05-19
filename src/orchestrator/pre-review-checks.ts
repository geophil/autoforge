import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlanSubtask } from "../types/core";

export const PRE_REVIEW_IGNORED_PATHS = new Set([
  ".autoforge-status.json",
  ".autoforge-worktree.json"
]);

const DEBUG_SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|md|json)$/;

const BLOCKING_DEBUG_PATTERNS = [
  { label: "debugger statement", regex: /\bdebugger\s*;/ },
  { label: "TODO DEBUG", regex: /TODO\s+DEBUG/i }
] as const;

const ADVISORY_DEBUG_PATTERNS = [
  { label: "console.log", regex: /\bconsole\.log\s*\(/ }
] as const;

export function normalizeArtifactPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function artifactWithinScope(artifact: string, scope: string): boolean {
  const normalizedArtifact = normalizeArtifactPath(artifact);
  const normalizedScope = normalizeArtifactPath(scope);
  if (!normalizedArtifact || !normalizedScope) return false;
  if (normalizedScope === "." || normalizedScope === "./") return true;
  if (normalizedArtifact === normalizedScope) return true;
  const directoryScope = normalizedScope.endsWith("/") ? normalizedScope : `${normalizedScope}/`;
  return normalizedArtifact.startsWith(directoryScope);
}

/** Skip debug scans for test/fixture paths where logging is expected. */
export function shouldSkipDebugScanPath(artifact: string): boolean {
  const normalized = normalizeArtifactPath(artifact);
  if (!normalized) return true;
  if (/(^|\/)(tests?|__tests__|fixtures?|mocks?)(\/|$)/i.test(normalized)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)) return true;
  return false;
}

export interface PreReviewCheckResult {
  passed: boolean;
  scope_check: {
    status: "passed" | "failed" | "unavailable";
    unexpected_artifacts: string[];
  };
  debug_code_scan: {
    status: "passed" | "failed" | "unavailable";
    matches: Array<{ path: string; pattern: string }>;
    advisory_matches: Array<{ path: string; pattern: string }>;
  };
}

export function runCheapPreReviewChecks(input: {
  worktreePath: string;
  planSubtasks: PlanSubtask[];
  reportedArtifacts: string[];
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}): PreReviewCheckResult {
  const readFile = input.readFile ?? ((path) => readFileSync(path, "utf8"));
  const exists = input.exists ?? existsSync;

  const normalizedArtifacts = [...new Set(
    input.reportedArtifacts
      .map((path) => normalizeArtifactPath(path))
      .filter((path): path is string => path.length > 0 && !PRE_REVIEW_IGNORED_PATHS.has(path))
  )].sort();

  const allowedScopes = input.planSubtasks
    .flatMap((subtask) => subtask.filesInScope)
    .map((path) => normalizeArtifactPath(path))
    .filter((path): path is string => path.length > 0);

  const scopeUnavailable = allowedScopes.length === 0 || normalizedArtifacts.length === 0;
  const unexpectedArtifacts = scopeUnavailable
    ? []
    : normalizedArtifacts.filter((artifact) => !allowedScopes.some((scope) => artifactWithinScope(artifact, scope)));

  const blockingMatches: Array<{ path: string; pattern: string }> = [];
  const advisoryMatches: Array<{ path: string; pattern: string }> = [];
  const worktreeRoot = resolve(input.worktreePath);

  for (const artifact of normalizedArtifacts) {
    if (!DEBUG_SCAN_EXTENSIONS.test(artifact) || artifact.startsWith("/")) continue;
    if (shouldSkipDebugScanPath(artifact)) continue;
    const fullPath = resolve(worktreeRoot, artifact);
    if (!(fullPath === worktreeRoot || fullPath.startsWith(`${worktreeRoot}/`)) || !exists(fullPath)) continue;
    try {
      const text = readFile(fullPath).slice(0, 250_000);
      for (const pattern of BLOCKING_DEBUG_PATTERNS) {
        if (pattern.regex.test(text)) {
          blockingMatches.push({ path: artifact, pattern: pattern.label });
        }
      }
      for (const pattern of ADVISORY_DEBUG_PATTERNS) {
        if (pattern.regex.test(text)) {
          advisoryMatches.push({ path: artifact, pattern: pattern.label });
        }
      }
    } catch {
      // Unreadable artifacts are covered by artifact validation and review.
    }
  }

  const scopeStatus = scopeUnavailable
    ? "unavailable"
    : unexpectedArtifacts.length === 0 ? "passed" : "failed";
  const debugStatus = normalizedArtifacts.length === 0
    ? "unavailable"
    : blockingMatches.length === 0 ? "passed" : "failed";

  return {
    passed: scopeStatus !== "failed" && debugStatus !== "failed",
    scope_check: {
      status: scopeStatus,
      unexpected_artifacts: unexpectedArtifacts
    },
    debug_code_scan: {
      status: debugStatus,
      matches: blockingMatches,
      advisory_matches: advisoryMatches
    }
  };
}
