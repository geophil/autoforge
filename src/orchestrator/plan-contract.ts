import type {
  PlanContractRepair,
  PlanContractSummary,
  PlanContractWarning,
  PlanSubtask,
  PlanningContext,
  Tier
} from "../types/core";

export interface ExecutionContract extends PlanContractSummary {
  wipLimit: 1;
  tier: Tier;
  validationHierarchy: string[];
  subtasks: Array<{
    id: string;
    sequence: number;
    behavior: string;
    filesInScope: string[];
    verificationCommands: string[];
    testCriteria: string[];
    completionEvidence: string[];
  }>;
  valid: boolean;
}

export function buildPlanContract(
  planSubtasks: PlanSubtask[],
  tier: Tier,
  planningContext?: PlanningContext | null
): PlanContractSummary {
  const invalidSubtasks = planSubtasks.map((subtask) => {
    const missing: string[] = [];
    const provided = subtask.contractProvided;

    if (!hasBehavior(subtask) && !repairableBehavior(subtask)) missing.push("behavior");
    if (!subtask.filesInScope.length || provided?.filesInScope === false) missing.push("filesInScope");
    if (!subtask.verificationCommands.length || provided?.verificationCommands === false) missing.push("verificationCommands");
    if (!subtask.testCriteria.length || provided?.testCriteria === false) missing.push("testCriteria");
    if (!subtask.completionEvidence.length || provided?.completionEvidence === false) missing.push("completionEvidence");

    return { id: subtask.id, missing };
  }).filter((row) => row.missing.length > 0);

  const repairs = planSubtasks.flatMap(repairsForSubtask);
  const warnings = buildWarnings(planSubtasks, planningContext);
  const hasDegraded = warnings.some((warning) => warning.level === "degraded");
  const status: PlanContractSummary["status"] =
    invalidSubtasks.length > 0
      ? "invalid"
      : repairs.length > 0
        ? "repaired"
        : hasDegraded
          ? "degraded"
          : "valid";

  return { status, invalidSubtasks, repairs, warnings };
}

export function buildExecutionContract(
  planSubtasks: PlanSubtask[],
  tier: Tier,
  planningContext?: PlanningContext | null
): ExecutionContract {
  const validationHierarchy = [
    "static_or_unit_checks",
    "affected_behavior_tests",
    ...(tier === "THOROUGH" ? ["runtime_or_end_to_end_verification"] : [])
  ];
  const summary = buildPlanContract(planSubtasks, tier, planningContext);
  return {
    wipLimit: 1,
    tier,
    validationHierarchy,
    subtasks: planSubtasks.map((subtask) => ({
      id: subtask.id,
      sequence: subtask.sequence,
      behavior: subtask.behavior,
      filesInScope: subtask.filesInScope,
      verificationCommands: subtask.verificationCommands,
      testCriteria: subtask.testCriteria,
      completionEvidence: subtask.completionEvidence
    })),
    ...summary,
    valid: summary.invalidSubtasks.length === 0 && !summary.repairs.some((repair) => repair.status === "available")
  };
}

export function repairPlanSubtasks(
  planSubtasks: PlanSubtask[],
  tier: Tier = "STANDARD",
  planningContext?: PlanningContext | null
): {
  repairedSubtasks: PlanSubtask[];
  repairs: PlanContractRepair[];
  before: PlanContractSummary;
  after: PlanContractSummary;
} {
  const before = buildPlanContract(planSubtasks, tier, planningContext);
  const repairs = before.repairs.filter((repair) => repair.status === "available");
  const repairedSubtasks = planSubtasks.map((subtask) => {
    const subtaskRepairs = repairs.filter((repair) => repair.subtaskId === subtask.id);
    if (subtaskRepairs.length === 0) return subtask;

    let next: PlanSubtask = {
      ...subtask,
      contractProvided: {
        behavior: subtask.contractProvided?.behavior ?? true,
        filesInScope: subtask.contractProvided?.filesInScope ?? true,
        verificationCommands: subtask.contractProvided?.verificationCommands ?? true,
        testCriteria: subtask.contractProvided?.testCriteria ?? true,
        completionEvidence: subtask.contractProvided?.completionEvidence ?? true
      },
      contractRepairs: [...(subtask.contractRepairs ?? [])]
    };

    for (const repair of subtaskRepairs) {
      if (repair.field === "behavior") {
        next = {
          ...next,
          behavior: repair.value,
          contractProvided: {
            ...next.contractProvided!,
            behavior: true
          },
          contractRepairs: [
            ...(next.contractRepairs ?? []),
            { field: "behavior", source: repair.source }
          ]
        };
      }
    }
    return next;
  });

  return {
    repairedSubtasks,
    repairs,
    before,
    after: buildPlanContract(repairedSubtasks, tier, planningContext)
  };
}

function hasBehavior(subtask: PlanSubtask): boolean {
  return subtask.behavior.trim().length > 0 && subtask.contractProvided?.behavior !== false;
}

function repairableBehavior(subtask: PlanSubtask): boolean {
  return subtask.description.trim().length > 0;
}

function repairsForSubtask(subtask: PlanSubtask): PlanContractRepair[] {
  const appliedBehavior = subtask.contractRepairs?.find((repair) => repair.field === "behavior");
  if (appliedBehavior) {
    return [{
      subtaskId: subtask.id,
      field: "behavior",
      source: appliedBehavior.source,
      status: "applied",
      value: subtask.behavior
    }];
  }

  if (subtask.contractProvided?.behavior === false && repairableBehavior(subtask)) {
    return [{
      subtaskId: subtask.id,
      field: "behavior",
      source: "description",
      status: "available",
      value: subtask.description
    }];
  }

  return [];
}

function buildWarnings(planSubtasks: PlanSubtask[], planningContext?: PlanningContext | null): PlanContractWarning[] {
  const warnings: PlanContractWarning[] = [];
  const qmd = planningContext?.qmdContext;
  if (qmd?.status === "fallback") {
    warnings.push({
      level: "degraded",
      code: "qmd_degraded",
      message: qmd.fallbackReason ?? "QMD evidence is degraded; planner used fallback context."
    });
  }

  for (const subtask of planSubtasks) {
    if (subtask.filesInScope.some((file) => file === "src" || file === "src/" || file === "." || file === "./")) {
      warnings.push({
        level: "advisory",
        code: "broad_scope",
        message: `Subtask ${subtask.id} has broad file scope.`
      });
    }
  }

  return warnings;
}
