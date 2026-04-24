import type { DbClient } from "../db/client";

export interface RetrievedLesson {
  id: string;
  body: string;
  trigger_pattern: string;
  outcome_kind: "corrective" | "reinforcing";
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "with", "is", "are", "be"
]);

/** Approximate token counter: 1 token per 4 characters. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function extractKeywords(text: string, maxTerms = 20): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([t]) => t);
}

/**
 * Retrieves active lessons for a given variant's lineage, ranked by keyword
 * overlap with the task description. Returns up to maxLessons, truncated
 * further to respect the approximate token budget (body length only).
 *
 * Requires that lineage root resolution is done upstream OR that this helper
 * resolves lineage itself — we choose the latter for caller convenience.
 */
export async function retrieveLessonsForDispatch(
  variantId: string,
  agentType: string,
  taskDescription: string,
  maxLessons = 5,
  maxTokens = 1500,
  db: DbClient
): Promise<RetrievedLesson[]> {
  const lineageRootId = db.resolveLineageRoot(variantId);
  if (!lineageRootId) return [];

  const allActive = db.retrieveActiveLessonsByLineage(lineageRootId, agentType, 200);
  if (allActive.length === 0) return [];

  const taskKeywords = new Set(extractKeywords(taskDescription));
  const scored = allActive.map((row) => {
    const lessonKeywords = (row.retrieval_keywords ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let overlap = 0;
    for (const k of lessonKeywords) if (taskKeywords.has(k)) overlap += 1;
    return { row, overlap };
  });

  const ranked = scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return b.row.created_at.localeCompare(a.row.created_at);
    })
    .slice(0, maxLessons);

  const out: RetrievedLesson[] = [];
  let tokenBudget = maxTokens;
  for (const { row } of ranked) {
    const cost = approxTokens(row.body);
    if (cost > tokenBudget) break;
    tokenBudget -= cost;
    out.push({
      id: row.id,
      body: row.body,
      trigger_pattern: row.trigger_pattern,
      outcome_kind: row.outcome_kind as "corrective" | "reinforcing"
    });
  }
  return out;
}
