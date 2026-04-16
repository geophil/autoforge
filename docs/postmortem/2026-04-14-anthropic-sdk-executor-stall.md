# Post-Mortem: Anthropic SDK Executor Stall on Multi-File Task

**Date**: 2026-04-14
**Task ID**: `fbaca654-efe0-41e8-87bf-3e6a6f1579a6`
**Executor**: `anthropic-sdk` (claude-sonnet-4-6)
**Outcome**: Task stalled indefinitely during coder stage; never produced source file changes

## Timeline

| Time (UTC) | Event | Notes |
|---|---|---|
| 15:05:22 | Task created | Tier: THOROUGH (scope: large, novelty: high) |
| 15:05:22 | Planning started | |
| 15:06:29 | Planning complete | 67s, 163K input / 3.7K output tokens |
| 15:06:29 | Coder started | Budget: 720s (THOROUGH tier) |
| ~15:07:24 | Test file written | `tests/unit/task-events.test.ts` (227 lines, 12 test cases) |
| 15:07:24+ | **Stall begins** | No further file writes for 16+ minutes |
| 15:22:00 | Manually killed | Coder had exceeded budget by ~5 minutes |

## What the agent produced before stalling

The coder wrote a comprehensive test file (`task-events.test.ts`) with 12 tests covering:
- The API endpoint `GET /api/tasks/:id/events` (8 tests)
- A `DbClient.listEvents` method (4 tests) — the agent used the method name `listTaskEvents` which was incorrect; the actual method is `listEvents`

The tests were well-structured with proper DB setup, timestamp ordering verification, field mapping checks, and isolation tests. The agent correctly identified the need for both a DB method and an API route.

**However, it never wrote any implementation code.** No changes to `src/db/client.ts`, `src/web/routes/tasks.ts`, `src/web/public/dashboard.js`, `src/web/public/styles.css`, or `src/web/server.ts`.

## Comparison: Same task with Claude Code executor

The same task description was resubmitted with the `claude-code` executor and completed successfully:

| Metric | Anthropic SDK (failed) | Claude Code (succeeded) |
|---|---|---|
| Planner duration | 67s | 134s |
| Coder duration | >960s (killed) | 278s |
| Reviewer duration | never reached | 128s |
| Total time | >16 min (killed) | ~9 min (complete) |
| Files modified | 1 (test only) | 6 (test + all implementation) |
| PR created | No | Yes (#2) |

## Root Causes

### 1. Limited tool surface area causes exploration loops

The Anthropic SDK executor provides only 4 tools: `read_file`, `write_file`, `list_directory`, `bash`. For a multi-file task touching a backend route, DB method, frontend JS, and CSS, the agent needs to:

1. `list_directory` to find files
2. `read_file` each relevant file to understand the codebase structure
3. `read_file` adjacent files for context (imports, types, patterns)
4. Only then `write_file` to make changes

Each read requires a full API roundtrip. For this task, the agent needed to read at minimum: `src/db/client.ts`, `src/web/routes/tasks.ts`, `src/web/server.ts`, `src/web/public/dashboard.js`, `src/web/public/styles.css`, `src/types/core.ts`, `src/db/schema.sql`, plus `list_directory` on several paths. That's 10+ API calls just for context gathering, each with the full system prompt + conversation history re-sent.

Claude Code, by contrast, has native filesystem access — it can grep, read multiple files, and work at filesystem speed without API roundtrips.

### 2. No timeout enforcement during API calls

The executor checks `Date.now() >= deadlineMs` only at the top of each iteration loop:

```typescript
for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
  if (Date.now() >= deadlineMs) {  // <-- only checked here
    timedOut = true;
    break;
  }
  const response = await client.messages.create(...);  // <-- can block indefinitely
```

If a single `messages.create()` call takes a long time (slow API, rate limiting, large context), the deadline check never fires. The Anthropic Node SDK doesn't have a per-request timeout by default.

### 3. Context window bloat from conversation history

Each tool-use iteration appends both the assistant's response and the tool results to the `messages` array. After 10+ iterations of file reading, the conversation history contains the full contents of every file read. This means:
- Each subsequent API call sends a larger payload
- The input token count grows linearly with exploration
- The planner alone used 163K input tokens; the coder likely exceeded this quickly
- API latency increases with context size

### 4. Tier classification amplified the problem

The task was classified as THOROUGH (scope: large, novelty: high) due to the heuristic keyword/length assessment. This gave it a 720s coder budget instead of 480s (STANDARD), which meant a longer stall before the deadline would have triggered — and the deadline check couldn't fire anyway due to cause #2.

### 5. Planner produced a generic fallback subtask

The planner's output didn't match the expected `{ subtasks: [...] }` format, so `parsePlanSubtasks()` fell back to:
```json
{
  "description": "Implement requested behavior with tests-first workflow.",
  "filesInScope": ["src/"],
  "testCriteria": ["All tests pass."]
}
```

This gave the coder zero guidance on which files to modify, forcing it to explore the entire `src/` tree via tool calls. A better plan with specific file targets would have reduced exploration cycles significantly.

## Recommended Fixes

### Immediate (unblock SDK executor for multi-file tasks)

1. **Add per-request timeout to Anthropic API calls**
   ```typescript
   const response = await client.messages.create({
     ...params,
     timeout: 120_000  // 2 minute per-call timeout
   });
   ```
   This prevents indefinite hangs on single API calls. The Anthropic SDK supports this via the `timeout` option.

2. **Add AbortController-based budget enforcement**
   Use `AbortSignal.timeout(remainingMs)` passed to the API client to enforce the budget deadline even during in-flight requests, rather than only checking between iterations.

3. **Truncate conversation history after N iterations**
   After 15-20 iterations, summarize the conversation history to reduce context bloat. Alternatively, use a sliding window that keeps only the last N tool results plus the original prompt.

### Medium-term (improve SDK executor reliability)

4. **Add a `search_files` tool (grep equivalent)**
   The biggest bottleneck is sequential file reads. Adding a grep/search tool would let the agent find relevant code in 1 call instead of reading entire files. Something like:
   ```json
   { "name": "search_files", "description": "Search file contents with regex, like grep" }
   ```

5. **Add a `read_multiple_files` tool**
   Allow reading multiple files in a single API call to reduce roundtrip overhead.

6. **Fix planner output parsing**
   The planner consistently falls back to a generic subtask. Either:
   - Fix the planner persona to output in the expected `{ subtasks: [...] }` JSON format
   - Parse the planner's natural language output more flexibly
   - Pre-populate `filesInScope` from the task description when specific file paths are mentioned

7. **Add progress monitoring / circuit breaker**
   Track the number of `read_file` calls vs `write_file` calls. If the agent has done >15 reads without a single write, inject a system message like: "You have read many files without writing any implementation. Please start implementing based on what you know."

### Long-term (make SDK executor competitive with Claude Code)

8. **Tool parallelism via batch API**
   Allow the agent to request multiple tool calls per turn (already supported by the API) and execute them in parallel rather than sequentially.

9. **Persistent context caching**
   Use prompt caching to avoid re-sending file contents on every iteration. The Anthropic API supports cache control headers.

10. **Executor selection routing**
    Route tasks to the appropriate executor based on complexity:
    - EXPRESS tier / single-file tasks → SDK executor (cheaper, sufficient)
    - STANDARD/THOROUGH / multi-file tasks → Claude Code executor (more capable)
    This gives you the cost benefits of the SDK executor where it works while falling back to Claude Code for complex tasks.

## Data Preserved

- Failed task events in SQLite: `task_id = 'fbaca654-efe0-41e8-87bf-3e6a6f1579a6'`
- Test file the agent wrote (preserved in git history of worktree before cleanup)
- Successful comparison task: `task_id = 'b18eeaf7-4476-4625-b07e-273371591bae'` (PR #2)
