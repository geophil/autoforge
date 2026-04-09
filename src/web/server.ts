import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { createTaskRoutes } from "./routes/tasks";
import { createApprovalRoutes } from "./routes/approvals";
import { createMetricsRoutes } from "./routes/metrics";
import type { OrchestratorService } from "../orchestrator/service";
import type { DbClient } from "../db/client";
import { LiveEventHub } from "./events";

export function createWebServer(service: OrchestratorService, db: DbClient): Hono {
  const app = new Hono();
  const events = new LiveEventHub();

  app.get("/", (ctx) => {
    return ctx.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Autoforge Dashboard</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
    code { background: #f2f2f2; padding: 0.1rem 0.2rem; }
  </style>
</head>
<body>
  <h1>Autoforge Task Queue</h1>
  <p>Use <code>POST /api/tasks</code> to submit tasks and this table will update.</p>
  <table>
    <thead><tr><th>ID</th><th>State</th><th>Tier</th><th>Description</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    async function refresh() {
      const response = await fetch('/api/tasks');
      const tasks = await response.json();
      const rows = document.getElementById('rows');
      rows.innerHTML = '';
      for (const task of tasks) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + task.id + '</td><td>' + task.state + '</td><td>' + task.tier + '</td><td>' + task.description + '</td>';
        rows.appendChild(tr);
      }
    }
    refresh();
    const stream = new EventSource('/api/events');
    stream.addEventListener('task.updated', refresh);
  </script>
</body>
</html>`);
  });

  app.route("/api/tasks", createTaskRoutes(service, events));
  app.route("/api/tasks", createApprovalRoutes(service, events));
  app.route("/api/metrics", createMetricsRoutes(db));

  app.get("/api/events", (ctx) => {
    return streamSSE(ctx, async (stream) => {
      const unsubscribe = events.subscribe((payload) => {
        void stream.write(payload);
      });
      await stream.write(`event: connected\ndata: {"ok":true}\n\n`);
      try {
        while (true) {
          await Bun.sleep(15_000);
          await stream.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
