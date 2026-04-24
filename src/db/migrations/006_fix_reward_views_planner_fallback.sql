-- 006: Spec A follow-up — tighten the planner_fallback subquery in
-- task_quality_score so it reads only the two event types that actually carry
-- the flag. Previously the subquery scanned ALL events and used
-- json_type(payload, '$.planner_fallback') IS NOT NULL as the only filter. That
-- works today but silently expands its scope if any new event type ever
-- emits the key. This migration narrows the filter to the intended sources.
--
-- Semantics preserved:
--   * `planned` events (service.ts) — set planner_fallback=true when the planner
--     fell back to the canned single-subtask plan. Fidelity penalty even on
--     success (tested in reward-views.test.ts).
--   * `failure_analysis` events — carry the flag on all failure paths.

DROP VIEW IF EXISTS task_quality_score;

CREATE VIEW task_quality_score AS
SELECT
  t.id AS task_id,
  t.project_id,
  t.tier,

  -- correctness: 1 if completed with no blocking findings, else 0
  CASE
    WHEN t.state = 'completed'
         AND COALESCE(o.blocking_finding_count, 0) = 0
    THEN 1.0 ELSE 0.0
  END AS r_correctness,

  -- simplicity: 1 / (1 + lines_changed / tier_baseline); 0.5 if stats missing
  CASE
    WHEN d.task_id IS NULL THEN 0.5
    ELSE 1.0 / (
      1.0 + (
        CAST(d.lines_added + d.lines_deleted AS REAL) /
        CASE t.tier
          WHEN 'EXPRESS' THEN 50.0
          WHEN 'STANDARD' THEN 200.0
          WHEN 'THOROUGH' THEN 800.0
          ELSE 200.0
        END
      )
    )
  END AS r_simplicity,

  -- alignment: 1 - (critical_findings / max(total_findings, 1))
  CASE
    WHEN COALESCE(o.finding_count, 0) = 0 THEN 1.0
    ELSE 1.0 - (CAST(o.blocking_finding_count AS REAL) / CAST(o.finding_count AS REAL))
  END AS r_alignment,

  -- fidelity: 0.5 * (1 - planner_fallback) + 0.5 * (1 - scope_drift)
  -- planner_fallback is drawn ONLY from `failure_analysis` and `planned` events.
  0.5 * (1.0 - COALESCE(fa.planner_fallback, 0))
    + 0.5 * (1.0 - COALESCE(sd.scope_drift, 0.0)) AS r_fidelity,

  -- efficiency: 0.5 * cost term + 0.5 * iteration term
  0.5 * (
    1.0 / (
      1.0 + COALESCE(o.total_cost, 0.0) /
      CASE t.tier
        WHEN 'EXPRESS' THEN 0.50
        WHEN 'STANDARD' THEN 2.00
        WHEN 'THOROUGH' THEN 8.00
        ELSE 2.00
      END
    )
  ) + 0.5 * (1.0 / (1.0 + t.iteration)) AS r_efficiency,

  t.created_at
FROM tasks t
LEFT JOIN task_outcomes o ON o.task_id = t.id
LEFT JOIN task_diff_stats d ON d.task_id = t.id
LEFT JOIN (
  SELECT
    task_id,
    MAX(
      CASE
        WHEN json_type(payload, '$.planner_fallback') IS NOT NULL
        THEN CAST(json_extract(payload, '$.planner_fallback') AS INTEGER)
        ELSE 0
      END
    ) AS planner_fallback
  FROM events
  WHERE event_type IN ('failure_analysis', 'planned')
  GROUP BY task_id
) fa ON fa.task_id = t.id
LEFT JOIN (
  SELECT
    t2.id AS task_id,
    CASE
      WHEN json_valid(t2.plan) AND json_type(t2.plan) = 'array'
      THEN CASE
        WHEN (SELECT COUNT(*) FROM subtasks WHERE task_id = t2.id) >
             1.3 * CAST(json_array_length(t2.plan) AS REAL)
        THEN 1.0 ELSE 0.0
      END
      ELSE 0.0
    END AS scope_drift
  FROM tasks t2
) sd ON sd.task_id = t.id
WHERE t.state IN ('completed', 'failed');
