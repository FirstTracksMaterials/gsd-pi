// Project/App: gsd-pi
// File Purpose: Prepare dispatch policy. Research/plan only; stop before implementation.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function prepareMarkerPath(basePath: string): string {
  return join(basePath, ".gsd", "runtime", "prepare-mode.json");
}

function readPrepareMarker(basePath: string): { jobId: string; milestoneId: string; operationId: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(prepareMarkerPath(basePath), "utf-8")) as {
      jobId?: string;
      milestoneId?: string;
      operationId?: string;
    };
    if (!parsed.jobId || !parsed.milestoneId || !parsed.operationId) return undefined;
    return { jobId: parsed.jobId, milestoneId: parsed.milestoneId, operationId: parsed.operationId };
  } catch {
    return undefined;
  }
}

export function beginPrepareMode(basePath: string, record: { jobId: string; milestoneId: string; operationId: string }): void {
  const key = canonicalKey(basePath);
  activePrepare.set(key, record);
  const marker = prepareMarkerPath(key);
  mkdirSync(join(key, ".gsd", "runtime"), { recursive: true });
  writeFileSync(marker, JSON.stringify(record) + "\n", "utf-8");
}

export function endPrepareMode(basePath: string): void {
  const key = canonicalKey(basePath);
  activePrepare.delete(key);
  rmSync(prepareMarkerPath(key), { force: true });
  rmSync(join(key, ".gsd", "runtime", "prepare-boundary.json"), { force: true });
}

export function isPrepareMode(basePath: string): boolean {
  const key = canonicalKey(basePath);
  const marker = readPrepareMarker(key);
  if (!marker) {
    activePrepare.delete(key);
    return false;
  }
  activePrepare.set(key, marker);
  return true;
}

export function recordPrepareBoundaryStop(basePath: string, unitType: string, unitId?: string): void {
  const key = canonicalKey(basePath);
  const record = activePrepare.get(key) ?? readPrepareMarker(key);
  if (!record) return;
  mkdirSync(join(key, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(key, ".gsd", "runtime", "prepare-boundary.json"), JSON.stringify({
    ...record,
    unitType,
    unitId: unitId ?? null,
  }) + "\n", "utf-8");
}

export function readPrepareBoundaryStop(basePath: string): { operationId: string; unitType: string; unitId?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(canonicalKey(basePath), ".gsd", "runtime", "prepare-boundary.json"), "utf-8")) as {
      operationId?: string;
      unitType?: string;
      unitId?: string | null;
    };
    if (!parsed.operationId || !parsed.unitType) return undefined;
    return { operationId: parsed.operationId, unitType: parsed.unitType, unitId: parsed.unitId ?? undefined };
  } catch {
    return undefined;
  }
}

export function getPrepareMode(basePath: string): { jobId: string; milestoneId: string; operationId: string } | undefined {
  const key = canonicalKey(basePath);
  return activePrepare.get(key) ?? readPrepareMarker(key);
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
