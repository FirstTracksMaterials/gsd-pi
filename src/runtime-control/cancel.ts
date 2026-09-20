// Project/App: gsd-pi
// File Purpose: R8 cancel orchestration. Immediate cancelling; idle probe before lease release.

import {
  requestAutoCancellation,
  setAutoCancellationPhase,
} from "../resources/extensions/gsd/auto-cancellation.ts";
import { DEFAULT_KILL_VERIFY_MS, DEFAULT_TERM_GRACE_MS } from "../resources/extensions/gsd/host-check-runner.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { probeBackendIdle } from "./idle-probe.ts";
import { issueRecoveryId } from "./recovery.ts";
import type { Operation, ResolvedProject, StoredOperation } from "./types.ts";

export type CancelHost = {
  store: OperationStore;
  lease: ModelLease;
  clock: () => Date;
};

export const CANCEL_TERM_GRACE_MS = DEFAULT_TERM_GRACE_MS;
export const CANCEL_KILL_VERIFY_MS = DEFAULT_KILL_VERIFY_MS;

export type CancelNativeOps = {
  stopAuto?: (reason: string) => Promise<void>;
  abortTools?: () => Promise<{ cleaned: boolean }>;
};

let cancelOps: CancelNativeOps = {};

export function registerCancelNativeOpsForTest(ops: CancelNativeOps | null): void {
  cancelOps = ops ?? {};
}

export function resetCancelNativeOpsForTest(): void {
  cancelOps = {};
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function executeCancel(input: {
  host: CancelHost;
  project: ResolvedProject;
  cancelOperation: StoredOperation;
}): Promise<{ holdLease: boolean }> {
  const { host, project, cancelOperation } = input;
  const targetId = cancelOperation.operation.target_operation_id;
  const target = targetId ? host.store.read(targetId) : undefined;
  const stamp = nowIso(host.clock);

  requestAutoCancellation("requested");
  setAutoCancellationPhase("aborting-model");

  if (target) {
    target.operation.state = "cancelling";
    target.operation.updated_at = stamp;
    host.store.update(target);
  }
  cancelOperation.operation.state = "cancelling";
  cancelOperation.operation.updated_at = stamp;
  host.store.update(cancelOperation);

  try {
    if (cancelOps.stopAuto) {
      await cancelOps.stopAuto("runtime-v1 cancel");
    } else {
      const { stopAuto } = await import("../resources/extensions/gsd/auto.ts");
      await stopAuto(undefined, undefined, "runtime-v1 cancel");
    }
  } catch {
    // stopAuto is safe when idle; continue cleanup.
  }

  setAutoCancellationPhase("aborting-tools");
  let cleaned = true;
  try {
    if (cancelOps.abortTools) {
      const result = await cancelOps.abortTools();
      cleaned = result.cleaned;
    }
  } catch {
    cleaned = false;
  }

  setAutoCancellationPhase("draining");
  const idle = await probeBackendIdle(project.backend_idle_probe);
  if (!cleaned || !idle.idle) {
    const recovery = issueRecoveryId({
      operation_id: cancelOperation.operation.operation_id,
      job_id: cancelOperation.operation.job_id,
      reason: idle.idle
        ? "Process-group cleanup did not complete within TERM/KILL budgets"
        : idle.reason,
      issued_at: nowIso(host.clock),
      next_state: "recovery_required",
    });
    const failStamp = nowIso(host.clock);
    if (target) {
      target.operation.state = "recovery_required";
      target.operation.updated_at = failStamp;
      target.operation.error = {
        code: "recovery_required",
        message: recovery.reason,
        retryable: false,
        operation_id: target.operation.operation_id,
      };
      target.operation.result = { recovery_id: recovery.recovery_id };
      host.store.update(target);
      host.lease.retainForRecovery(target.operation.operation_id);
    }
    cancelOperation.operation.state = "recovery_required";
    cancelOperation.operation.updated_at = failStamp;
    cancelOperation.operation.error = {
      code: "recovery_required",
      message: recovery.reason,
      retryable: false,
      operation_id: cancelOperation.operation.operation_id,
    };
    cancelOperation.operation.result = { recovery_id: recovery.recovery_id, kind: "cancel" };
    host.store.update(cancelOperation);
    return { holdLease: true };
  }

  const done = nowIso(host.clock);
  if (target) {
    target.operation.state = "cancelled";
    target.operation.updated_at = done;
    host.store.update(target);
    host.lease.release(target.operation.operation_id);
  }
  cancelOperation.operation.state = "succeeded";
  cancelOperation.operation.updated_at = done;
  cancelOperation.operation.result = {
    kind: "cancel",
    target_operation_id: targetId,
    cancelled: true,
  };
  host.store.update(cancelOperation);
  setAutoCancellationPhase("cancelled");
  return { holdLease: false };
}

export function markCancelling(operation: Operation, updatedAt: string): Operation {
  return { ...operation, state: "cancelling", updated_at: updatedAt };
}
