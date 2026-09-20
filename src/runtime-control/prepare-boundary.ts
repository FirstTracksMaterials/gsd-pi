// Project/App: gsd-pi
// File Purpose: Prepare dispatch policy. Research/plan only; stop before implementation.

export const PREPARE_ALLOWED_UNIT_TYPES = new Set([
  "research-project",
  "research-milestone",
  "research-slice",
  "research-decision",
  "plan-milestone",
  "plan-slice",
  "discuss-milestone",
  "discuss-project",
  "discuss-requirements",
  "refine-slice",
]);

export const IMPLEMENTATION_UNIT_TYPES = new Set([
  "execute-task",
  "complete-slice",
  "complete-milestone",
  "validate-milestone",
  "run-uat",
]);

export type PrepareDispatchAction = {
  action: string;
  unitType?: string;
  unitId?: string;
  reason?: string;
  level?: string;
  matchedRule?: string;
};

export type PrepareBoundaryResult =
  | { kind: "allow"; action: PrepareDispatchAction }
  | { kind: "prepared"; reason: string; unitType: string; unitId?: string }
  | { kind: "refuse"; reason: string; unitType: string; unitId?: string };

const activePrepare = new Map<string, { jobId: string; milestoneId: string; operationId: string }>();

export function beginPrepareMode(basePath: string, record: { jobId: string; milestoneId: string; operationId: string }): void {
  activePrepare.set(canonicalKey(basePath), record);
}

export function endPrepareMode(basePath: string): void {
  activePrepare.delete(canonicalKey(basePath));
}

export function isPrepareMode(basePath: string): boolean {
  return activePrepare.has(canonicalKey(basePath));
}

export function getPrepareMode(basePath: string): { jobId: string; milestoneId: string; operationId: string } | undefined {
  return activePrepare.get(canonicalKey(basePath));
}

export function isPrepareAllowedUnit(unitType: string): boolean {
  return PREPARE_ALLOWED_UNIT_TYPES.has(unitType);
}

export function isImplementationUnit(unitType: string): boolean {
  return IMPLEMENTATION_UNIT_TYPES.has(unitType) || unitType.startsWith("execute-");
}

/**
 * Existing auto dispatch continues into execute-task after planning.
 * Prepare must halt at that boundary instead of implementing.
 */
export function applyPrepareDispatchBoundary(
  dispatch: PrepareDispatchAction,
  options: { prepareMode: boolean; milestoneLock?: string | null },
): PrepareBoundaryResult {
  if (!options.prepareMode) {
    return { kind: "allow", action: dispatch };
  }
  if (dispatch.action !== "dispatch") {
    return { kind: "allow", action: dispatch };
  }
  const unitType = dispatch.unitType ?? "";
  const unitId = dispatch.unitId;
  if (options.milestoneLock && unitId && !unitId.startsWith(`${options.milestoneLock}/`) && unitId !== options.milestoneLock) {
    const milestone = unitId.split("/")[0] ?? unitId;
    if (milestone !== options.milestoneLock) {
      return {
        kind: "refuse",
        reason: `Prepare is locked to milestone ${options.milestoneLock}; refusing ${unitType} ${unitId}`,
        unitType,
        unitId,
      };
    }
  }
  if (isImplementationUnit(unitType)) {
    return {
      kind: "prepared",
      reason: `Prepare reached the implementation boundary at ${unitType}${unitId ? ` ${unitId}` : ""}; stopping before product implementation`,
      unitType,
      unitId,
    };
  }
  if (!isPrepareAllowedUnit(unitType)) {
    return {
      kind: "refuse",
      reason: `Prepare cannot dispatch ${unitType}; only research/plan units are allowed`,
      unitType,
      unitId,
    };
  }
  return { kind: "allow", action: dispatch };
}

function canonicalKey(basePath: string): string {
  return basePath.replace(/\/+$/, "");
}

export function resetPrepareModeForTest(): void {
  activePrepare.clear();
}
