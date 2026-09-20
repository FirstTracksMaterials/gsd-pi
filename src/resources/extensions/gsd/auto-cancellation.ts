// Project/App: gsd-pi
// File Purpose: Native cancellation request gate for retry, compaction, dispatch, and late PASS.

import { autoSession } from "./auto-runtime-state.js";
import { writeUnitRuntimeRecord, readUnitRuntimeRecord, type CancellationPhase } from "./unit-runtime.js";

const cancelledAttemptIds = new Set<string>();

export function requestAutoCancellation(phase: CancellationPhase = "requested"): void {
  autoSession.cancellationRequested = true;
  autoSession.cancellationPhase = phase;
  const unit = autoSession.currentUnit;
  if (unit && autoSession.basePath) {
    writeUnitRuntimeRecord(autoSession.basePath, unit.type, unit.id, unit.startedAt, {
      cancellationPhase: phase,
    });
  }
}

export function setAutoCancellationPhase(phase: CancellationPhase): void {
  if (!autoSession.cancellationRequested && phase !== "none") {
    autoSession.cancellationRequested = true;
  }
  autoSession.cancellationPhase = phase;
  const unit = autoSession.currentUnit;
  if (unit && autoSession.basePath) {
    writeUnitRuntimeRecord(autoSession.basePath, unit.type, unit.id, unit.startedAt, {
      cancellationPhase: phase,
    });
  }
}

export function isAutoCancellationRequested(): boolean {
  return autoSession.cancellationRequested === true;
}

export function shouldRefuseNewWork(): boolean {
  return autoSession.cancellationRequested === true;
}

export function recordCancelledAttempt(attemptId: string | null | undefined): void {
  if (attemptId) cancelledAttemptIds.add(attemptId);
}

export function isCancelledAttempt(attemptId: string | null | undefined): boolean {
  return Boolean(attemptId && cancelledAttemptIds.has(attemptId));
}

export function publicationBlockedByCancellation(args: {
  basePath: string;
  attemptId: string;
  unitType?: string;
  unitId?: string;
}): boolean {
  if (isAutoCancellationRequested() || isCancelledAttempt(args.attemptId)) return true;
  if (!args.unitId) return false;
  const runtime = readUnitRuntimeRecord(args.basePath, args.unitType ?? "execute-task", args.unitId);
  return Boolean(runtime?.cancellationPhase && runtime.cancellationPhase !== "none");
}

export function resetAutoCancellationForTest(): void {
  autoSession.cancellationRequested = false;
  autoSession.cancellationPhase = "none";
  cancelledAttemptIds.clear();
}
