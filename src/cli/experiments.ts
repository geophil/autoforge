export interface PendingForkRow {
  experiment_id: string;
  proposed_specialty: unknown;
  parent_variant_id: unknown;
  hypothesis: string;
  evidence: Record<string, unknown>;
  proposed_content_preview: string;
  created_at: string;
}

export type ExperimentCliCommand =
  | { domain: "experiments"; command: "list-pending" }
  | {
    domain: "experiments";
    command: "approve-fork";
    id: string;
    approver: string;
    notes: string;
  }
  | {
    domain: "experiments";
    command: "reject-fork";
    id: string;
    reviewer: string;
    reason: string;
  };

export interface ExperimentCliResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text: () => Promise<string>;
}

export interface ExperimentCliDeps {
  baseUrl: string;
  fetch: (url: string, init?: RequestInit) => Promise<ExperimentCliResponse>;
  stdout: (text: string) => void;
}

const usage = "usage: autoforge experiments <list-pending|approve-fork|reject-fork>";
const approveUsage = "usage: autoforge experiments approve-fork <id> --approver <name> [--notes <notes>]";
const rejectUsage = "usage: autoforge experiments reject-fork <id> --reviewer <name> --reason <reason>";

export function formatPendingForks(rows: PendingForkRow[]): string {
  if (rows.length === 0) return "No pending fork experiments.\n";
  return rows.map((row) => [
    `Experiment: ${row.experiment_id}`,
    `Specialty: ${String(row.proposed_specialty ?? "")}`,
    `Parent: ${String(row.parent_variant_id ?? "")}`,
    `Proposal: ${String(row.evidence.fork_proposal_id ?? "")}`,
    `Tasks: ${Array.isArray(row.evidence.task_ids) ? row.evidence.task_ids.join(", ") : ""}`,
    `Hypothesis: ${row.hypothesis}`,
    ""
  ].join("\n")).join("\n");
}

export function parseExperimentCommand(args: string[]): ExperimentCliCommand {
  const [domain, command, id, ...rest] = args;
  if (domain !== "experiments") {
    throw new Error(usage);
  }
  if (command === "list-pending") {
    return { domain, command };
  }
  if (command === "approve-fork") {
    const approver = valueAfter(rest, "--approver");
    if (!id || !approver) {
      throw new Error(approveUsage);
    }
    return {
      domain,
      command,
      id,
      approver,
      notes: valueAfter(rest, "--notes") ?? ""
    };
  }
  if (command === "reject-fork") {
    const reviewer = valueAfter(rest, "--reviewer");
    const reason = valueAfter(rest, "--reason");
    if (!id || !reviewer || !reason) {
      throw new Error(rejectUsage);
    }
    return { domain, command, id, reviewer, reason };
  }
  throw new Error(usage);
}

export async function runExperimentCli(args: string[], deps: ExperimentCliDeps): Promise<void> {
  const parsed = parseExperimentCommand(args);
  if (parsed.command === "list-pending") {
    const res = await deps.fetch(`${deps.baseUrl}/api/experiments?status=proposed&operation=fork`);
    await assertOk(res);
    const body = await res.json?.() as { experiments: unknown[] } | undefined;
    deps.stdout(formatPendingForks((body?.experiments ?? []) as PendingForkRow[]));
    return;
  }
  if (parsed.command === "approve-fork") {
    const res = await deps.fetch(`${deps.baseUrl}/api/experiments/${parsed.id}/approve-fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approver: parsed.approver, notes: parsed.notes })
    });
    await assertOk(res);
    deps.stdout(`${await res.text()}\n`);
    return;
  }
  const res = await deps.fetch(`${deps.baseUrl}/api/experiments/${parsed.id}/reject-fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewer: parsed.reviewer, reason: parsed.reason })
  });
  await assertOk(res);
  deps.stdout(`${await res.text()}\n`);
}

async function assertOk(res: ExperimentCliResponse): Promise<void> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
