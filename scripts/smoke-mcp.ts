/**
 * Smoke test for the client-side MCP wiring used by AnthropicSdkExecutor.
 *
 * Exercises the same code paths the executor uses — opens a Streamable HTTP
 * MCP client, lists tools, calls one, closes — so we can validate against a
 * running QMD container without burning Anthropic API tokens.
 *
 * Usage:
 *   QMD_MCP_URL=http://localhost:8181/mcp bun run scripts/smoke-mcp.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.QMD_MCP_URL ?? "http://localhost:8181/mcp";

console.log(`[smoke-mcp] Connecting to ${url}...`);

const client = new Client({ name: "autoforge-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));

try {
  await client.connect(transport);
  console.log("[smoke-mcp] Connected.");

  const { tools } = await client.listTools();
  console.log(`[smoke-mcp] Listed ${tools.length} tool(s):`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description ?? "(no description)"}`);
  }

  // Pick the most likely-safe tool to call (status / query / first tool).
  const candidate =
    tools.find((t) => t.name === "status") ??
    tools.find((t) => t.name === "query") ??
    tools[0];

  if (!candidate) {
    console.log("[smoke-mcp] No tools to call — done.");
  } else {
    // For `query`, send something minimal; for `status`, no args.
    const args =
      candidate.name === "query"
        ? { q: "architecture overview", limit: 1 }
        : candidate.name === "get"
          ? { id: "architecture-overview" }
          : {};
    console.log(`[smoke-mcp] Calling ${candidate.name} with`, args);
    const result = await client.callTool({ name: candidate.name, arguments: args });
    console.log(`[smoke-mcp] Result isError=${result.isError ?? false}`);
    const preview = JSON.stringify(result.content, null, 2).slice(0, 500);
    console.log(`[smoke-mcp] First 500 chars of content:\n${preview}`);
  }

  await client.close();
  console.log("[smoke-mcp] Closed cleanly. ✓");
  process.exit(0);
} catch (err) {
  console.error("[smoke-mcp] FAILED:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  try { await client.close(); } catch { /* ignore */ }
  process.exit(1);
}
