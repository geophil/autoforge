import type { DbClient } from "../db/client";

export interface RetrievedLesson {
  id: string;
  body: string;
  trigger_pattern: string;
  outcome_kind: "corrective" | "reinforcing";
}

export interface LessonRetrievalOptions {
  zeroOverlapFallback?: {
    enabled: boolean;
    maxLessons: number;
    maxTokens: number;
  };
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
  db: DbClient,
  variantId: string,
  agentType: string,
  taskDescription: string,
  maxLessons = 5,
  maxTokens = 1500,
  options: LessonRetrievalOptions = {}
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

  const fallbackEnabled = options.zeroOverlapFallback?.enabled === true;
  const fallbackMaxLessons = Math.max(0, options.zeroOverlapFallback?.maxLessons ?? 1);
  const fallbackMaxTokens = Math.max(0, options.zeroOverlapFallback?.maxTokens ?? maxTokens);
  const fallbackBudget = Math.min(maxTokens, fallbackMaxTokens);
  const selected =
    ranked.length > 0
      ? ranked
      : fallbackEnabled
        ? scored
          .sort((a, b) => {
            const createdOrder = b.row.created_at.localeCompare(a.row.created_at);
            return createdOrder === 0 ? b.row.id.localeCompare(a.row.id) : createdOrder;
          })
        : [];

  const out: RetrievedLesson[] = [];
  let tokenBudget = ranked.length > 0 ? maxTokens : fallbackBudget;
  for (const { row } of selected) {
    if (ranked.length === 0 && out.length >= fallbackMaxLessons) break;
    const cost = approxTokens(row.body);
    if (cost > tokenBudget) {
      if (ranked.length > 0) break;
      continue;
    }
    tokenBudget -= cost;
    out.push({
      id: row.id,
      body: row.body,
      trigger_pattern: row.trigger_pattern,
      outcome_kind: row.outcome_kind
    });
  }
  return out;
}
