// Project/App: gsd-pi
// File Purpose: R8 cancel orchestration. Immediate cancelling; idle probe before lease release.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  requestAutoCancellation,
  setAutoCancellationPhase,
} from "../resources/extensions/gsd/auto-cancellation.ts";
import { DEFAULT_KILL_VERIFY_MS, DEFAULT_TERM_GRACE_MS } from "../resources/extensions/gsd/host-check-runner.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { probeBackendIdle } from "./idle-probe.ts";
import { configureRecoveryStore, issueRecoveryId } from "./recovery.ts";
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
  abortProvider?: () => Promise<void>;
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

async function abortBridgeGeneration(projectCwd: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = process.env.GSD_WEB_PACKAGE_ROOT?.trim();
  const candidates = [
    packaged ? join(packaged, "src", "web", "bridge-service.ts") : "",
    join(here, "..", "web", "bridge-service.ts"),
  ].filter((path) => path && existsSync(path));
  let lastError: unknown = new Error("bridge-service was not found beside the runtime or GSD_WEB_PACKAGE_ROOT");
  for (const candidate of candidates) {
    try {
      const loaded = await import(/* webpackIgnore: true */ pathToFileURL(candidate).href) as {
        sendBridgeInput: (command: { type: "abort" }, cwd?: string) => Promise<{ success?: boolean; error?: unknown } | null>;
      };
      const response = await loaded.sendBridgeInput({ type: "abort" }, projectCwd);
      if (response && response.success === false) {
        throw new Error(typeof response.error === "string" ? response.error : "bridge abort failed");
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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

  let providerAbortUncertain = false;
  try {
    if (cancelOps.abortProvider) {
      await cancelOps.abortProvider();
    } else if (!cancelOps.stopAuto && process.env.GSD_WEB_DAEMON_MODE === "1") {
      await abortBridgeGeneration(project.target_realpath);
    }
  } catch {
    providerAbortUncertain = true;
  }

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
  const stateDir = process.env.GSD_STATE_DIR?.trim();
  if (stateDir) configureRecoveryStore(stateDir);
  const idle = await probeBackendIdle(project.backend_idle_probe);
  if (!cleaned || !idle.idle || providerAbortUncertain) {
    const recovery = issueRecoveryId({
      operation_id: cancelOperation.operation.operation_id,
      job_id: cancelOperation.operation.job_id,
      reason: providerAbortUncertain
        ? "Provider abort did not complete; backend ownership remains uncertain"
        : idle.idle
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
