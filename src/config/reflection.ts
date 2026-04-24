/**
 * Configuration for the reflector sub-agent invoked after every terminal task state.
 *
 * Kept deliberately small — no DB-backed overrides in MVP. Tuning is a code change.
 * Spec B §4.2 budget, §4.4 self-suppression cap, §4.5 skip rules, §5.1 retrieval defaults.
 */
export const REFLECTION_CONFIG = {
  /** Budget in seconds for a single reflector dispatch (LLM call). */
  budgetSeconds: 60,

  /** Max active lessons supplied to the reflector for self-suppression (§4.4). */
  maxActiveLessonsForContext: 20,

  /** Max words allowed in a lesson.body — over-limit outputs are rejected. */
  maxLessonBodyWords: 200,

  /** Skip reflection when task stalls with less than this elapsed time (§4.5). */
  skipFailedStalledBelowSeconds: 60,

  /** Defaults for retrieveLessonsForDispatch (§5.1). */
  retrieval: {
    maxLessons: 5,
    maxTokens: 1500
  }
} as const;
