import { z } from "zod";

const Evidence = z.object({
  task_ids: z.array(z.string()).min(1),
  finding_categories: z.array(z.string()).optional(),
  transcript_excerpts: z.array(z.object({
    task_id: z.string(),
    stage: z.string(),
    lines: z.string()
  })).optional(),
  metric_name: z.string().optional(),
  metric_before: z.number().optional(),
  fork_proposal_id: z.string().optional()
});

const RetireLessonEntry = z.object({ id: z.string(), reason: z.string() });

const EditOp = z.object({
  kind: z.literal("edit"),
  target_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  proposed_content_file: z.string(),
  retire_lessons: z.array(RetireLessonEntry).max(3).optional(),
  specialty: z.undefined().optional()
}).strict();

const ForkOp = z.object({
  kind: z.literal("fork"),
  parent_variant_id: z.string(),
  specialty: z.string().min(1),
  hypothesis: z.string(),
  evidence: Evidence,
  proposed_content_file: z.string(),
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

const MergeOp = z.object({
  kind: z.literal("merge"),
  target_variant_id: z.string(),
  merge_source_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

const PromoteDemoteRetireOp = z.object({
  kind: z.enum(["promote", "demote", "retire"]),
  target_variant_id: z.string(),
  hypothesis: z.string(),
  evidence: Evidence,
  traffic_share: z.number().min(0).max(1).optional(),
  retire_lessons: z.array(RetireLessonEntry).max(3).optional()
}).strict();

export const OperationSchema = z.discriminatedUnion("kind", [
  EditOp, ForkOp, MergeOp, PromoteDemoteRetireOp
]);

export const MetaOutputSchema = z.object({
  status: z.string(),
  artifacts: z.array(z.string()).default([]),
  operation: OperationSchema
});

export type MetaOutput = z.infer<typeof MetaOutputSchema>;
export type MetaOperation = z.infer<typeof OperationSchema>;

export interface ValidationResult {
  ok: boolean;
  value?: MetaOutput;
  error?: string;
}

/**
 * Safe-parse wrapper. Returns the first error path + message as a short string
 * suitable for embedding into the meta_rejected event payload.
 */
export function validateMetaOutput(raw: unknown): ValidationResult {
  const result = MetaOutputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const path = issue.path.join(".") || "<root>";
  return { ok: false, error: `${path}: ${issue.message}` };
}
