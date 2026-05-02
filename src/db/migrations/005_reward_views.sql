-- 005: Reward views — task_quality_score (per task), variant_performance (per variant),
-- niche_performance (per variant × dimension), population_health (per agent type).
-- View contracts per Spec A §6.

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
  WHERE event_type IN ('planned', 'failure_analysis')
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

DROP VIEW IF EXISTS variant_performance;

CREATE VIEW variant_performance AS
SELECT
  vs.variant_id,
  sv.skill_name AS variant_name,
  sv.specialty,
  sv.status,
  vs.agent_type,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity) AS avg_simplicity,
  AVG(tqs.r_alignment) AS avg_alignment,
  AVG(tqs.r_fidelity) AS avg_fidelity,
  AVG(tqs.r_efficiency) AS avg_efficiency
FROM (
  SELECT DISTINCT
    task_id,
    json_extract(payload, '$.selected_variant_id') AS variant_id,
    json_extract(payload, '$.agent_type') AS agent_type
  FROM events
  WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN skill_versions sv ON sv.id = vs.variant_id
GROUP BY vs.variant_id, vs.agent_type;

DROP VIEW IF EXISTS niche_performance;

CREATE VIEW niche_performance AS
-- By tier
SELECT
  vs.variant_id,
  vs.agent_type,
  'tier' AS dimension,
  t.tier AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity) AS avg_simplicity,
  AVG(tqs.r_alignment) AS avg_alignment,
  AVG(tqs.r_fidelity) AS avg_fidelity,
  AVG(tqs.r_efficiency) AS avg_efficiency
FROM (
  SELECT DISTINCT
    task_id,
    json_extract(payload, '$.selected_variant_id') AS variant_id,
    json_extract(payload, '$.agent_type') AS agent_type
  FROM events
  WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN tasks t ON t.id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, t.tier

UNION ALL

-- By project
SELECT
  vs.variant_id,
  vs.agent_type,
  'project' AS dimension,
  t.project_id AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity) AS avg_simplicity,
  AVG(tqs.r_alignment) AS avg_alignment,
  AVG(tqs.r_fidelity) AS avg_fidelity,
  AVG(tqs.r_efficiency) AS avg_efficiency
FROM (
  SELECT DISTINCT
    task_id,
    json_extract(payload, '$.selected_variant_id') AS variant_id,
    json_extract(payload, '$.agent_type') AS agent_type
  FROM events
  WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN tasks t ON t.id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, t.project_id

UNION ALL

-- By finding-category
SELECT
  vs.variant_id,
  vs.agent_type,
  'finding_category' AS dimension,
  rf.category AS dimension_value,
  COUNT(DISTINCT tqs.task_id) AS task_count,
  AVG(tqs.r_correctness) AS avg_correctness,
  AVG(tqs.r_simplicity) AS avg_simplicity,
  AVG(tqs.r_alignment) AS avg_alignment,
  AVG(tqs.r_fidelity) AS avg_fidelity,
  AVG(tqs.r_efficiency) AS avg_efficiency
FROM (
  SELECT DISTINCT
    task_id,
    json_extract(payload, '$.selected_variant_id') AS variant_id,
    json_extract(payload, '$.agent_type') AS agent_type
  FROM events
  WHERE event_type = 'variant_selected'
) vs
JOIN task_quality_score tqs ON tqs.task_id = vs.task_id
JOIN review_findings rf ON rf.task_id = vs.task_id
GROUP BY vs.variant_id, vs.agent_type, rf.category;

DROP VIEW IF EXISTS population_health;

CREATE VIEW population_health AS
SELECT
  vs.agent_type,
  COUNT(DISTINCT CASE WHEN sv.status IN ('baseline', 'active') THEN sv.id END) AS active_variant_count,
  COUNT(DISTINCT CASE WHEN sv.status = 'candidate' THEN sv.id END) AS candidate_variant_count,
  COUNT(DISTINCT CASE WHEN sv.status = 'retired' THEN sv.id END) AS retired_variant_count,
  SUM(CASE WHEN sv.status IN ('baseline', 'active') THEN sv.traffic_share ELSE 0 END) AS total_allocated_share,
  AVG(vp.avg_correctness) AS ensemble_avg_correctness,
  AVG(vp.avg_simplicity) AS ensemble_avg_simplicity,
  AVG(vp.avg_alignment) AS ensemble_avg_alignment,
  AVG(vp.avg_fidelity) AS ensemble_avg_fidelity,
  AVG(vp.avg_efficiency) AS ensemble_avg_efficiency
FROM (
  SELECT DISTINCT json_extract(payload, '$.agent_type') AS agent_type
  FROM events
  WHERE event_type = 'variant_selected'
) vs
LEFT JOIN skill_versions sv ON sv.skill_name = 'persona:' || vs.agent_type
LEFT JOIN variant_performance vp ON vp.agent_type = vs.agent_type AND vp.variant_id = sv.id
GROUP BY vs.agent_type;
