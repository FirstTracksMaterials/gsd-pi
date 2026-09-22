// Project/App: gsd-pi
// File Purpose: Cancel orchestration. Cleanup acknowledgement, then bound idle, before lease release.

import { DEFAULT_KILL_VERIFY_MS, DEFAULT_TERM_GRACE_MS } from "../resources/extensions/gsd/host-check-runner.ts";
import type { BackendBinding } from "./types.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { probeManagedIdle, type IdleProbeResult } from "./idle-probe.ts";
import { configureRecoveryStore, issueRecoveryId } from "./recovery.ts";
import type { Operation, ResolvedProject, StoredOperation } from "./types.ts";
import {
  missingWorkerCleanup,
  type WorkerCleanupEvidence,
} from "./worker-cleanup.ts";

export type CancelHost = {
  store: OperationStore;
  lease: ModelLease;
  clock: () => Date;
};

export const CANCEL_TERM_GRACE_MS = DEFAULT_TERM_GRACE_MS;
export const CANCEL_KILL_VERIFY_MS = DEFAULT_KILL_VERIFY_MS;
const IDLE_POLL_MS = 200;

export type OwnedWorkerAbort = (input: {
  projectCwd: string;
  operationId: string;
  jobId: string;
}) => Promise<WorkerCleanupEvidence>;

export type CancelNativeOps = {
  stopAuto?: (reason: string) => Promise<void>;
  abortTools?: () => Promise<{ cleaned: boolean }>;
  abortProvider?: () => Promise<void>;
  abortOwnedWorker?: OwnedWorkerAbort;
};

let cancelOps: CancelNativeOps = {};

export function registerCancelNativeOps(ops: CancelNativeOps | null): void {
  cancelOps = ops ?? {};
}

export function registerCancelNativeOpsForTest(ops: CancelNativeOps | null): void {
  registerCancelNativeOps(ops);
}

export function resetCancelNativeOpsForTest(): void {
  cancelOps = {};
}

type CancellationModule = {
  requestAutoCancellation: (phase?: string) => void;
  setAutoCancellationPhase: (phase: string) => void;
};

let cancellationModule: Promise<CancellationModule | null> | null = null;

function loadCancellation(): Promise<CancellationModule | null> {
  if (!cancellationModule) {
    cancellationModule = import(
      /* webpackIgnore: true */
      "../resources/extensions/gsd/auto-cancellation.ts"
    ).then((loaded) => loaded as CancellationModule).catch(() => null);
  }
  return cancellationModule;
}

async function signalCancellation(phase: string): Promise<void> {
  const loaded = await loadCancellation();
  if (!loaded) return;
  if (phase === "requested") loaded.requestAutoCancellation("requested");
  else loaded.setAutoCancellationPhase(phase);
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeIdleWithinTeardown(binding: BackendBinding | null | undefined): Promise<IdleProbeResult> {
  const deadline = Date.now() + CANCEL_TERM_GRACE_MS + CANCEL_KILL_VERIFY_MS;
  let idle = await probeManagedIdle(binding ?? null);
  while (!idle.idle && Date.now() < deadline) {
    await sleep(IDLE_POLL_MS);
    idle = await probeManagedIdle(binding ?? null);
  }
  return idle;
}

export async function acknowledgeOwnedWorker(input: {
  projectCwd: string;
  operationId: string;
  jobId: string;
}): Promise<WorkerCleanupEvidence> {
  if (!cancelOps.abortOwnedWorker) {
    return missingWorkerCleanup("no production cleanup acknowledgement");
  }
  try {
    const evidence = await cancelOps.abortOwnedWorker(input);
    if (
      !evidence.cleaned
      || !evidence.dispatch_quiesced
      || !evidence.request_closed
      || !evidence.tools_drained
      || evidence.operation_id !== input.operationId
      || evidence.job_id !== input.jobId
    ) {
      return {
        ...evidence,
        cleaned: false,
        reason: evidence.reason ?? "worker cleanup was not acknowledged",
      };
    }
    return evidence;
  } catch (error) {
    return missingWorkerCleanup(
      `abort response lost: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanupFromHooks(): Promise<{ evidence: WorkerCleanupEvidence; uncertain: boolean }> {
  let uncertain = false;
  if (cancelOps.abortProvider) {
    try {
      await cancelOps.abortProvider();
    } catch {
      uncertain = true;
    }
  }
  if (cancelOps.stopAuto) {
    try {
      await cancelOps.stopAuto("runtime-v1 cancel");
    } catch {
      uncertain = true;
    }
  }
  let toolsDrained = false;
  if (cancelOps.abortTools) {
    try {
      toolsDrained = (await cancelOps.abortTools()).cleaned === true;
    } catch {
      toolsDrained = false;
    }
  }
  const cleaned = !uncertain && toolsDrained && Boolean(cancelOps.abortTools);
  return {
    uncertain,
    evidence: {
      cleaned,
      dispatch_quiesced: !uncertain && Boolean(cancelOps.stopAuto || cancelOps.abortProvider || cancelOps.abortTools),
      request_closed: !uncertain,
      tools_drained: toolsDrained,
      operation_id: null,
      job_id: null,
      session_id: null,
      worker_generation: null,
      reason: cleaned ? null : uncertain
        ? "Provider abort did not complete; backend ownership remains uncertain"
        : "no production cleanup acknowledgement",
    },
  };
}

function cleanupResult(evidence: WorkerCleanupEvidence, targetId: string | null): Record<string, unknown> {
  return {
    kind: "cancel",
    target_operation_id: targetId,
    cancelled: evidence.cleaned,
    dispatch_quiesced: evidence.dispatch_quiesced,
    request_closed: evidence.request_closed,
    tools_drained: evidence.tools_drained,
    worker_generation: evidence.worker_generation,
    session_id: evidence.session_id,
    operation_id: evidence.operation_id,
  };
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

  await signalCancellation("requested");
  await signalCancellation("aborting-model");

  if (target) {
    target.operation.state = "cancelling";
    target.operation.updated_at = stamp;
    host.store.update(target);
  }
  cancelOperation.operation.state = "cancelling";
  cancelOperation.operation.updated_at = stamp;
  host.store.update(cancelOperation);

  let evidence: WorkerCleanupEvidence;
  let uncertain = false;
  if (cancelOps.abortOwnedWorker) {
    evidence = await acknowledgeOwnedWorker({
      projectCwd: project.target_realpath,
      operationId: target?.operation.operation_id ?? cancelOperation.operation.operation_id,
      jobId: target?.operation.job_id ?? cancelOperation.operation.job_id ?? "",
    });
    uncertain = !evidence.cleaned && (evidence.reason ?? "").includes("uncertain");
  } else if (cancelOps.abortProvider || cancelOps.stopAuto || cancelOps.abortTools) {
    const hooked = await cleanupFromHooks();
    evidence = hooked.evidence;
    if (target) {
      evidence = { ...evidence, operation_id: target.operation.operation_id, job_id: target.operation.job_id };
    }
    uncertain = hooked.uncertain;
  } else {
    evidence = missingWorkerCleanup("no production cleanup acknowledgement");
  }

  await signalCancellation("aborting-tools");
  await signalCancellation("draining");
  const stateDir = process.env.GSD_STATE_DIR?.trim();
  if (stateDir) configureRecoveryStore(stateDir);

  const binding = target?.backend_binding ?? null;
  const idle = evidence.cleaned ? await probeIdleWithinTeardown(binding) : null;
  if (!evidence.cleaned || !idle?.idle || uncertain) {
    const recovery = issueRecoveryId({
      operation_id: cancelOperation.operation.operation_id,
      job_id: cancelOperation.operation.job_id,
      reason: uncertain
        ? "Provider abort did not complete; backend ownership remains uncertain"
        : !evidence.cleaned
          ? (evidence.reason ?? "worker cleanup was not acknowledged")
          : (idle?.idle ? "Process-group cleanup did not complete within TERM/KILL budgets" : idle?.reason ?? "backend ownership remains uncertain"),
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
    cancelOperation.operation.result = {
      ...cleanupResult(evidence, targetId),
      recovery_id: recovery.recovery_id,
      kind: "cancel",
    };
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
  cancelOperation.operation.result = cleanupResult({ ...evidence, cleaned: true }, targetId);
  host.store.update(cancelOperation);
  await signalCancellation("cancelled");
  return { holdLease: false };
}

export function markCancelling(operation: Operation, updatedAt: string): Operation {
  return { ...operation, state: "cancelling", updated_at: updatedAt };
}
