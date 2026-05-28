import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry";
import { createRuntimeToolRegistry } from "../../src/runtime/tools";
import { MockWorkspace } from "../../src/runtime/mock-workspace";
import type { ToolExecutionContext } from "../../src/runtime/tool-registry";

const context: ToolExecutionContext = {
  environment: { FROM_CONTEXT: "yes" },
  deadlineMs: Date.now() + 60_000,
  timeoutSeconds: 60
};

describe("runtime tools", () => {
  test("read_file and write_file operate through the provided workspace", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });
    const registry = createRuntimeToolRegistry();

    await registry.get("write_file").execute({ path: "src/example.ts", content: "hello" }, workspace, context);
    const result = await registry.get("read_file").execute({ path: "src/example.ts" }, workspace, context);

    expect(result).toEqual({ path: "src/example.ts", content: "hello" });
  });

  test("read_file rejects internal tool-result artifacts", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-internal-artifact",
      files: { ".autoforge/tool-results/exec-1.json": "{}" }
    });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("read_file").execute({
      path: ".autoforge/tool-results/exec-1.json"
    }, workspace, context)).rejects.toThrow("read with read_tool_artifact");
  });

  test("exec collects streamed stdout, stderr, exitCode, and signal", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-1",
      commands: [
        {
          cmd: "bun",
          args: ["test"],
          events: [
            { kind: "stdout", chunk: "ok\n" },
            { kind: "stderr", chunk: "warn\n" },
            { kind: "exit", exitCode: 7, signal: "SIGTERM" }
          ]
        }
      ]
    });
    const registry = createRuntimeToolRegistry();

    const result = await registry.get("exec").execute({ cmd: "bun", args: ["test"] }, workspace, context);

    expect(result).toEqual({
      stdout: "ok\n",
      stderr: "warn\n",
      exitCode: 7,
      signal: "SIGTERM"
    });
  });

  test("exec forwards environment and timeout context to the workspace", async () => {
    let observedEnv: Record<string, string> | undefined;
    let observedTimeout: number | undefined;
    const workspace = new MockWorkspace({
      id: "workspace-1",
      commands: [{ cmd: "env", args: [], events: [{ kind: "exit", exitCode: 0 }] }]
    });
    const originalExec = workspace.exec.bind(workspace);
    workspace.exec = (cmd, args, opts) => {
      observedEnv = opts?.env;
      observedTimeout = opts?.timeoutSeconds;
      return originalExec(cmd, args, opts);
    };
    const registry = createRuntimeToolRegistry();

    await registry.get("exec").execute({ cmd: "env" }, workspace, context);

    expect(observedEnv?.FROM_CONTEXT).toBe("yes");
    expect(observedTimeout).toBe(60);
  });

  test("read_tool_artifact returns excerpts and requires a reason for full output", async () => {
    const artifactReference = ".autoforge/tool-results/exec-1.json";
    const workspace = new MockWorkspace({
      id: "workspace-tool-artifact",
      files: {
        [artifactReference]: JSON.stringify({
          kind: "exec",
          toolUseId: "exec-1",
          command: "bun",
          args: ["test"],
          cwd: ".",
          exitCode: 1,
          stdout: "FAIL tests/unit/foo.test.ts\n",
          stderr: "src/foo.ts(1,1): error TS2304: Cannot find name 'x'.\n",
          createdAt: "2026-05-20T00:00:00.000Z"
        })
      }
    });
    const registry = createRuntimeToolRegistry();

    const excerpt = await registry.get("read_tool_artifact").execute({
      artifactReference,
      mode: "excerpt"
    }, workspace, context) as { outputMode: string; keyFindings: string[] };

    expect(excerpt.outputMode).toBe("excerpt");
    expect(excerpt.keyFindings).toContain("src/foo.ts(1,1): error TS2304: Cannot find name 'x'.");
    await expect(registry.get("read_tool_artifact").execute({
      artifactReference,
      mode: "full"
    }, workspace, context)).rejects.toThrow("requires a reason");
  });

  test("read_tool_artifact supports QMD artifacts", async () => {
    const artifactReference = ".autoforge/tool-results/qmd-1.json";
    const workspace = new MockWorkspace({
      id: "workspace-qmd-artifact",
      files: {
        [artifactReference]: JSON.stringify({
          kind: "qmd",
          toolUseId: "qmd-1",
          toolName: "get",
          input: { path: "docs/qmd/domain-agent-execution.md" },
          text: "# Agent Execution\n\nRelevant doc content in docs/qmd/domain-agent-execution.md\n",
          isError: false,
          createdAt: "2026-05-22T00:00:00.000Z"
        })
      }
    });
    const registry = createRuntimeToolRegistry();

    const summary = await registry.get("read_tool_artifact").execute({
      artifactReference,
      mode: "summary"
    }, workspace, context) as { toolKind: string; relevantPaths: string[]; excerpts: string[] };

    expect(summary.toolKind).toBe("qmd");
    expect(summary.relevantPaths).toContain("docs/qmd/domain-agent-execution.md");
    expect(summary.excerpts[0]).toContain("Agent Execution");
    await expect(registry.get("read_tool_artifact").execute({
      artifactReference,
      mode: "full"
    }, workspace, context)).rejects.toThrow("requires a reason");
  });

  test("read_tool_artifact rejects path traversal in artifact references", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-tool-artifact-traversal",
      files: {
        "etc/passwd": JSON.stringify({
          kind: "exec",
          toolUseId: "escaped",
          command: "cat",
          args: ["/etc/passwd"],
          cwd: ".",
          exitCode: 0,
          stdout: "root:x:0:0:root:/root:/bin/sh\n",
          stderr: "",
          createdAt: "2026-05-20T00:00:00.000Z"
        })
      }
    });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("read_tool_artifact").execute({
      artifactReference: ".autoforge/tool-results/../../etc/passwd",
      mode: "summary"
    }, workspace, context)).rejects.toThrow("Unsupported tool artifact reference");
  });

  test("done writes the Autoforge status file", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });
    const registry = createRuntimeToolRegistry();

    const result = await registry.get("done").execute({
      status: "DONE",
      artifacts: ["src/a.ts"],
      concerns: "none"
    }, workspace, context);

    expect(result).toEqual({ ok: true, status: "DONE" });
    expect(JSON.parse(await workspace.readFile(".autoforge-status.json"))).toEqual({
      status: "DONE",
      artifacts: ["src/a.ts"],
      concerns: "none"
    });
  });

  test("str_replace updates file when old_string occurs exactly once", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-str",
      files: { "a.txt": "alpha BETA gamma\n" }
    });
    const registry = createRuntimeToolRegistry();

    const result = await registry.get("str_replace").execute({
      path: "a.txt",
      old_string: "BETA",
      new_string: "delta"
    }, workspace, context);

    expect(result).toEqual({ path: "a.txt", ok: true, replacements: 1 });
    expect(await workspace.readFile("a.txt")).toBe("alpha delta gamma\n");
  });

  test("str_replace rejects zero occurrences", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-str-0",
      files: { "a.txt": "unchanged\n" }
    });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("str_replace").execute({
      path: "a.txt",
      old_string: "missing",
      new_string: "x"
    }, workspace, context)).rejects.toThrow("old_string was not found");
  });

  test("str_replace rejects ambiguous multiple occurrences", async () => {
    const workspace = new MockWorkspace({
      id: "workspace-str-n",
      files: { "a.txt": "foo foo foo\n" }
    });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("str_replace").execute({
      path: "a.txt",
      old_string: "foo",
      new_string: "bar"
    }, workspace, context)).rejects.toThrow("found 3 occurrences");
  });

  test("str_replace rejects empty old_string", async () => {
    const workspace = new MockWorkspace({ id: "workspace-str-empty", files: { "a.txt": "x" } });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("str_replace").execute({
      path: "a.txt",
      old_string: "",
      new_string: "y"
    }, workspace, context)).rejects.toThrow("old_string must not be empty");
  });

  test("str_replace rejects identical old_string and new_string", async () => {
    const workspace = new MockWorkspace({ id: "workspace-str-same", files: { "a.txt": "x" } });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("str_replace").execute({
      path: "a.txt",
      old_string: "x",
      new_string: "x"
    }, workspace, context)).rejects.toThrow("identical");
  });

  test("done rejects invalid status values", async () => {
    const workspace = new MockWorkspace({ id: "workspace-1" });
    const registry = createRuntimeToolRegistry();

    await expect(registry.get("done").execute({
      status: "NOT_A_STATUS",
      artifacts: []
    }, workspace, context)).rejects.toThrow("Invalid status");
  });

  test("lookup_skill and load_skill expose markdown skills by name", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "runtime-skills-"));
    writeFileSync(join(skillsDir, "tdd.md"), [
      "---",
      "name: tdd",
      "description: Write tests first",
      "---",
      "# TDD"
    ].join("\n"));
    writeFileSync(join(skillsDir, "debugging.md"), "# Debugging\nFind root causes.");
    const registry = createRuntimeToolRegistry({
      skillRegistry: new SkillRegistry(skillsDir)
    });
    const workspace = new MockWorkspace({ id: "workspace-1" });

    await expect(registry.get("lookup_skill").execute({ pattern: "td" }, workspace, context)).resolves.toEqual({
      skills: [{ name: "tdd", description: "Write tests first" }]
    });
    await expect(registry.get("load_skill").execute({ name: "tdd" }, workspace, context)).resolves.toEqual({
      name: "tdd",
      content: [
        "---",
        "name: tdd",
        "description: Write tests first",
        "---",
        "# TDD"
      ].join("\n")
    });
  });

  test("load_skill records a skill only after content is successfully read", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "runtime-skills-delete-"));
    const skillPath = join(skillsDir, "tdd.md");
    const originalContent = [
      "---",
      "name: tdd",
      "description: Write tests first",
      "---",
      "# TDD"
    ].join("\n");
    writeFileSync(skillPath, originalContent);
    const registry = createRuntimeToolRegistry({
      skillRegistry: new SkillRegistry(skillsDir)
    });
    const recorded: string[] = [];

    const result = await registry.get("load_skill").execute(
      { name: "tdd" },
      new MockWorkspace({ id: "workspace-1" }),
      {
        ...context,
        recordLoadedSkill: (name) => {
          recorded.push(name);
          writeFileSync(skillPath, "# Mutated after record");
        }
      }
    );

    expect(result).toEqual({ name: "tdd", content: originalContent });
    expect(recorded).toEqual(["tdd"]);
  });
});
