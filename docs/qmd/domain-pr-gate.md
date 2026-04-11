# PR Gate and Version Control

This domain controls the quality gate that determines whether a task's output can become a pull request, manages isolated git worktrees so each task's changes never touch the main working tree, and handles all authenticated GitHub operations (push, PR create, merge, close). It also contains the test runner that detects and executes the target project's test suite. Agents never hold credentials and never push — all privileged operations run in the orchestrator process.

## Business Rules and Invariants

### 100% Test Pass Rate Required

The PR gate rejects if any test fails. This is the strictest condition — partial success is not accepted.

```typescript
// src/privileged/pr.ts
if (params.passRate < 1) {
  return { accepted: false, reason: "test_pass_rate_below_100" };
}
```

**Enforced in**: `src/privileged/pr.ts:24`
**Related config**: `TEST_PASS_THRESHOLD` in `configuration.md` (default 1.0; currently used for test detection fallback, not gate threshold)

### Review Score Below Threshold Blocks PR

```typescript
// src/privileged/pr.ts
if (params.reviewScore < params.thresholdScore) {
  return { accepted: false, reason: "review_score_below_threshold" };
}
```

`reviewScore` is calculated in the orchestrator: `1.0` if no unresolved findings, `0.5` if any exist.

**Enforced in**: `src/privileged/pr.ts:27`
**Related config**: `REVIEW_SCORE_THRESHOLD` (default 0.7). See `configuration.md`.

### Unresolved CRITICAL Findings Block PR

Even if review score passes threshold, any CRITICAL finding that wasn't resolved blocks the PR.

```typescript
// src/privileged/pr.ts
if (params.findings.some((f) => f.severity === "CRITICAL" && !f.resolved)) {
  return { accepted: false, reason: "critical_findings_unresolved" };
}
```

**Enforced in**: `src/privileged/pr.ts:30`

### Graceful Degradation When GitHub Is Unavailable

If `GITHUB_TOKEN` is unset or `gh` CLI is unavailable, `createPullRequest` returns a local placeholder URL instead of failing. This allows full pipeline testing without GitHub.

```typescript
// src/privileged/pr.ts
if (githubToken && ghAvailable) {
  return createPrViaGh(payload);
}
console.warn("[pr] GITHUB_TOKEN not set or `gh` CLI unavailable — skipping real PR creation.");
const mockId = randomUUID();
return `https://github.com/local/autoforge/pull/${mockId.slice(0, 8)}?branch=${encodeURIComponent(payload.branch)}`;
```

**Enforced in**: `src/privileged/pr.ts:43`

### PR Merge Is Squash with Branch Delete

```typescript
// src/privileged/pr.ts
spawnSync("gh", ["pr", "merge", prUrl, "--squash", "--auto", "--delete-branch"], { ... })
```

`--auto` waits for required checks; `--delete-branch` cleans up the `autoforge/{taskId}` branch post-merge.

**Enforced in**: `src/privileged/pr.ts:111`

### Git Worktree Isolation Per Task

Each task gets its own branch and worktree directory. Falls back to a plain directory if not inside a git repo.

```typescript
// src/git/worktrees.ts
create(taskId: string): WorktreeRef {
  const branch = `autoforge/${taskId}`;
  const path = join(this.rootDir, `${taskId}-${randomUUID().slice(0, 8)}`);

  if (this.isGitRepo()) {
    run("git", ["branch", branch], { ignore: true });
    spawnSync("git", ["worktree", "add", path, branch], { encoding: "utf8" });
  } else {
    mkdirSync(path, { recursive: true });
  }
  return { branch, path };
}
```

**Enforced in**: `src/git/worktrees.ts:20`

## Core Flows

### PR Gate Evaluation

Called at the end of `executeAndReview()` in the orchestrator.

1. **Test run**: `runAuthenticatedTests(worktreePath, projectId)` detects the package manager and runs tests.
2. **Review score**: `reviewScore = unresolvedFindings.length === 0 ? 1 : 0.5`
3. **Gate check**: `evaluatePrGate({ passRate, reviewScore, thresholdScore, findings })`
4. **Rejection**: If `!gate.accepted`, task transitions to `failed`.
5. **Acceptance**: `createPullRequest(payload)` pushes branch and opens PR.

### Test Runner Detection Logic

```typescript
// src/privileged/tests.ts
function detectTestRunner(cwd): { cmd, args } | null {
  // Bun: bun.lockb or bun.lock present
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")))
    return { cmd: "bun", args: ["test"] };

  // Node: package.json with non-placeholder test script
  // Prefers vitest, then jest, then npm test
  ...
  return null; // no test config → passRate: 1 (skip)
}
```

If no test configuration is found, `passRate` is returned as `1.0` (skip). This prevents false failures when working on non-JS projects.

**Enforced in**: `src/privileged/tests.ts:38`

### Test Output Parsing

Pass rate is extracted from the test runner output using regex patterns for bun, jest, and vitest:

```typescript
// bun test: "X pass, Y fail"
const bunMatch = output.match(/(\d+)\s+pass(?:ed)?.*?(\d+)\s+fail/i);

// jest/vitest: "Tests: X failed, Y passed, Z total"
const jestMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed.*?(\d+)\s+total/i);

// Fallback: trust exit code
return exitCode === 0 ? 1 : 0;
```

## Data Entities

```typescript
// src/privileged/pr.ts
export interface PrPayload {
  title: string;
  description: string;
  branch: string;
  findings: ReviewFinding[];
}

export interface PrGateResult {
  accepted: boolean;
  reason?: string;  // "test_pass_rate_below_100" | "review_score_below_threshold" | "critical_findings_unresolved"
}
```

```typescript
// src/git/worktrees.ts
export interface WorktreeRef {
  branch: string;  // "autoforge/{taskId}"
  path: string;    // absolute filesystem path
}
```

## Integration Points

- **Task Orchestration**: `evaluatePrGate`, `createPullRequest`, `mergePullRequest`, `closePullRequest`, `WorktreeManager`, and `runAuthenticatedTests` are all imported and called from `src/orchestrator/service.ts`. The orchestrator holds `GITHUB_TOKEN` in its environment.
- **Configuration**: `REVIEW_SCORE_THRESHOLD`, `GITHUB_TOKEN`, `TEST_PASS_THRESHOLD`. See `configuration.md`.

## File Map

| File | Purpose |
|------|---------|
| `src/privileged/pr.ts` | `evaluatePrGate`, `createPullRequest`, `mergePullRequest`, `closePullRequest` |
| `src/privileged/tests.ts` | `runAuthenticatedTests`, test runner detection, pass rate parsing |
| `src/git/worktrees.ts` | `WorktreeManager` — create, commit, findWorktreePath, remove |
