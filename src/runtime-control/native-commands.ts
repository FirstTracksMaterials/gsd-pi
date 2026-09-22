// Project/App: gsd-pi
// File Purpose: Typed runtime-v1 command adapters over existing GSD domain functions.

import { evaluateCompulsoryPolicy } from "../resources/extensions/gsd/required-policy.ts";
import { beginPrepareMode, endPrepareMode, isImplementationUnit } from "./prepare-boundary.ts";
import { acknowledgeOwnedWorker, executeCancel, probeIdleWithinTeardown } from "./cancel.ts";
import { applyRecovery, getRecovery, issueRecoveryId } from "./recovery.ts";
import type { CommandAction, CommandRequest, JobRecord, Operation, ResolvedProject, StoredOperation } from "./types.ts";
import type { JobCatalog } from "./job-catalog.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { setWorkspacePhase } from "./workspace-profile.ts";
import { dispatchNativeScopedAuto, NativeDispatchError } from "./native-auto-dispatch.ts";

export type CommandHost = {
  store: OperationStore;
  lease: ModelLease;
  jobs: JobCatalog;
  clock: () => Date;
};

export type NativeCommandContext = {
  operation: Operation;
  request: CommandRequest;
  job: JobRecord;
  project: ResolvedProject;
  host: CommandHost;
};

export type NativeCommandResult = {
  dispatch?: boolean;
  holdLease?: boolean;
};

export type NativeStartResult = {
  started: boolean;
  milestoneLock: string;
  dispatch?: Promise<void>;
};

export type NativeReviewResult = {
  findings: unknown[];
  productMutated: boolean;
  executed?: boolean;
};

export type NativeReplanResult = {
  preservedCompleted: boolean;
  evidenceInvalidated: string[];
  revision?: number;
};

export type NativeWorkflowOps = {
  startScopedAuto?: (input: { basePath: string; milestoneId: string; resume: boolean }) => Promise<NativeStartResult>;
  publishReviewFindings?: (input: {
    basePath: string;
    milestoneId: string;
    operationId: string;
    jobId: string;
    revision: number;
  }) => Promise<NativeReviewResult>;
  replanMilestone?: (input: {
    basePath: string;
    milestoneId: string;
    reason: string;
    operationId: string;
    jobId: string;
    revision: number;
  }) => Promise<NativeReplanResult>;
  dispatchWouldSelect?: (input: { basePath: string; milestoneId: string }) => Promise<{ unitType: string; unitId: string } | null>;
};

const lastMilestoneLock = new Map<string, string>();
let nativeOps: NativeWorkflowOps = {};

export function registerNativeWorkflowOps(ops: NativeWorkflowOps): void {
  nativeOps = { ...nativeOps, ...ops };
}

export function registerNativeWorkflowOpsForTest(ops: NativeWorkflowOps | null): void {
  nativeOps = ops ?? {};
}

export function resetNativeWorkflowOpsForTest(): void {
  nativeOps = {};
  lastMilestoneLock.clear();
}

export function getLastMilestoneLock(basePath: string): string | undefined {
  return lastMilestoneLock.get(basePath);
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function storedFromContext(context: NativeCommandContext): StoredOperation | undefined {
  return context.host.store.read(context.operation.operation_id);
}

async function defaultStart(input: { basePath: string; milestoneId: string; resume: boolean }): Promise<NativeStartResult> {
  lastMilestoneLock.set(input.basePath, input.milestoneId);
  process.env.GSD_MILESTONE_LOCK = input.milestoneId;
  const dispatch = dispatchNativeScopedAuto(input).then((result) => {
    if (result.dispatched) return;
    if (process.env.GSD_WEB_DAEMON_MODE === "1") {
      throw new NativeDispatchError("native auto was not dispatched", false);
    }
  });
  return { started: true, milestoneLock: input.milestoneId, dispatch };
}

function failOperation(host: CommandHost, stored: StoredOperation, code: "runtime_unavailable" | "recovery_required" | "invalid_contract", message: string): void {
  stored.operation.state = code === "recovery_required" ? "recovery_required" : "failed";
  stored.operation.updated_at = nowIso(host.clock);
  stored.operation.error = {
    code,
    message,
    retryable: false,
    operation_id: stored.operation.operation_id,
  };
  host.store.update(stored);
}

export function settleNativeDispatchFailure(host: CommandHost, operationId: string, error: unknown): void {
  const stored = host.store.read(operationId);
  if (!stored) return;
  if (stored.operation.state !== "running" && stored.operation.state !== "accepted") return;
  const began = error instanceof NativeDispatchError ? error.sideEffectsBegan : true;
  const message = error instanceof Error ? error.message : String(error);
  if (began) {
    const recovery = issueCrashRecovery(host, operationId, stored.operation.job_id, message);
    stored.operation.state = "recovery_required";
    stored.operation.updated_at = nowIso(host.clock);
    stored.operation.error = {
      code: "recovery_required",
      message,
      retryable: false,
      operation_id: operationId,
    };
    stored.operation.result = { ...(stored.operation.result ?? {}), recovery_id: recovery.recovery_id };
    host.store.update(stored);
    host.lease.retainForRecovery(operationId);
    return;
  }
  failOperation(host, stored, "runtime_unavailable", message);
  const held = host.lease.current();
  if (held?.operation_id === operationId) host.lease.release(operationId);
}

function observeDispatch(host: CommandHost, operationId: string, dispatch: Promise<void> | undefined): void {
  if (!dispatch) return;
  void dispatch.catch((error) => {
    settleNativeDispatchFailure(host, operationId, error);
  });
}

function reconcileIdleRecovery(
  host: CommandHost,
  recoveryOperationId: string,
  jobId: string | null,
  recoveryId: string,
  updatedAt: string,
): void {
  const held = host.lease.current();
  const ids = new Set<string>();
  if (held && (held.operation_id === recoveryOperationId || (jobId !== null && held.job_id === jobId))) {
    ids.add(held.operation_id);
    host.lease.release(held.operation_id);
  }
  ids.add(recoveryOperationId);
  for (const operationId of ids) {
    const stored = host.store.read(operationId);
    if (!stored || stored.operation.state !== "recovery_required") continue;
    stored.operation.state = "cancelled";
    stored.operation.updated_at = updatedAt;
    stored.operation.result = {
      ...(stored.operation.result ?? {}),
      reconciled: true,
      idle_confirmed: true,
      recovery_id: recoveryId,
    };
    host.store.update(stored);
  }
}

export async function productionCommandHandler(context: NativeCommandContext): Promise<NativeCommandResult> {
  const stored = storedFromContext(context);
  if (!stored) return { dispatch: false, holdLease: false };
  const action = context.request.action as CommandAction;
  const basePath = context.project.target_realpath;
  const milestoneId = context.job.milestone_id;

  if (action === "cancel") {
    const result = await executeCancel({ host: context.host, project: context.project, cancelOperation: stored });
    return { dispatch: false, holdLease: result.holdLease };
  }

  if (action === "recover") {
    const recoveryId = String(context.request.parameters.recovery_id ?? "");
    const diagnostic = getRecovery(recoveryId);
    if (!diagnostic) {
      stored.operation.state = "failed";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.error = {
        code: "invalid_request",
        message: `recovery_id ${recoveryId} was not issued by native diagnostics`,
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: false };
    }
    const owner = context.host.store.read(diagnostic.operation_id);
    if ((diagnostic.job_id && diagnostic.job_id !== context.job.job_id) || (owner && owner.operation.job_id !== context.job.job_id)) {
      stored.operation.state = "failed";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.error = {
        code: "invalid_request",
        message: "recover does not match the owning job",
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: true };
    }
    if (diagnostic.next_state === "recovery_required") {
      if (!owner?.backend_binding) {
        const blockedAt = nowIso(context.host.clock);
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = blockedAt;
        stored.operation.error = {
          code: "recovery_required",
          message: "Operation has no backend binding; ownership is unknown. Retain recovery_required.",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        stored.operation.result = {
          kind: "recover",
          recovery_id: recoveryId,
          next_state: "recovery_required",
          idle_confirmed: false,
          replayed_shell: false,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
      const evidence = await acknowledgeOwnedWorker({
        projectCwd: context.project.target_realpath,
        operationId: owner.operation.operation_id,
        jobId: context.job.job_id,
      });
      const idle = evidence.cleaned ? await probeIdleWithinTeardown(owner.backend_binding) : null;
      if (!evidence.cleaned || !idle?.idle) {
        const blockedAt = nowIso(context.host.clock);
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = blockedAt;
        stored.operation.error = {
          code: "recovery_required",
          message: !evidence.cleaned
            ? (evidence.reason ?? "worker cleanup was not acknowledged")
            : (idle?.reason ?? "backend ownership remains uncertain"),
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        stored.operation.result = {
          kind: "recover",
          recovery_id: recoveryId,
          next_state: "recovery_required",
          idle_confirmed: false,
          replayed_shell: false,
          dispatch_quiesced: evidence.dispatch_quiesced,
          request_closed: evidence.request_closed,
          tools_drained: evidence.tools_drained,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
    }
    const applied = applyRecovery(recoveryId);
    const recoveredAt = nowIso(context.host.clock);
    stored.operation.state = "succeeded";
    stored.operation.updated_at = recoveredAt;
    stored.operation.result = {
      kind: "recover",
      recovery_id: applied.recovery_id,
      next_state: applied.next_state,
      idle_confirmed: applied.next_state === "recovery_required",
      replayed_shell: false,
    };
    context.host.store.update(stored);
    if (applied.next_state === "recovery_required") {
      reconcileIdleRecovery(context.host, applied.operation_id, applied.job_id, applied.recovery_id, recoveredAt);
    } else if (context.host.lease.isHeld()) {
      const evidence = await acknowledgeOwnedWorker({
        projectCwd: context.project.target_realpath,
        operationId: applied.operation_id,
        jobId: applied.job_id ?? context.job.job_id,
      });
      if (!evidence.cleaned) {
        stored.operation.state = "recovery_required";
        stored.operation.error = {
          code: "recovery_required",
          message: evidence.reason ?? "worker cleanup was not acknowledged",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
      context.host.lease.release(applied.operation_id);
    }
    return { dispatch: false, holdLease: false };
  }

  if (action === "prepare") {
    setWorkspacePhase(basePath, "plan");
    beginPrepareMode(basePath, {
      jobId: context.job.job_id,
      milestoneId,
      operationId: stored.operation.operation_id,
    });
    lastMilestoneLock.set(basePath, milestoneId);
    process.env.GSD_MILESTONE_LOCK = milestoneId;
    const next = nativeOps.dispatchWouldSelect
      ? await nativeOps.dispatchWouldSelect({ basePath, milestoneId })
      : null;
    if (next && isImplementationUnit(next.unitType)) {
      const policy = await evaluateCompulsoryPolicy(basePath, { phase: "plan" });
      const policyPass = policy.kind === "unmanaged" || (policy.kind === "evaluated" && policy.result.verdict === "pass");
      if (!policyPass) {
        stored.operation.state = "failed";
        stored.operation.updated_at = nowIso(context.host.clock);
        stored.operation.error = {
          code: "invalid_contract",
          message: policy.kind === "blocked" ? policy.reason : "Required plan validation did not pass",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        context.host.store.update(stored);
        endPrepareMode(basePath);
        return { dispatch: false, holdLease: false };
      }
      stored.operation.state = "succeeded";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.result = {
        kind: "prepare",
        boundary: "prepared",
        stopped_before: next.unitType,
        unit_id: next.unitId,
        implementation: false,
      };
      context.host.store.update(stored);
      endPrepareMode(basePath);
      return { dispatch: false, holdLease: false };
    }
    const start = await (nativeOps.startScopedAuto ?? defaultStart)({ basePath, milestoneId, resume: false });
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "prepare", milestoneLock: start.milestoneLock, dispatched: true };
    context.host.store.update(stored);
    observeDispatch(context.host, stored.operation.operation_id, start.dispatch);
    return { dispatch: true, holdLease: true };
  }

  if (action === "review") {
    setWorkspacePhase(basePath, "review");
    const publish = nativeOps.publishReviewFindings;
    if (!publish) {
      failOperation(context.host, stored, "runtime_unavailable", "Native review workflow is not registered");
      return { dispatch: false, holdLease: false };
    }
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "review" };
    context.host.store.update(stored);
    const operationId = stored.operation.operation_id;
    void publish({
      basePath,
      milestoneId,
      operationId,
      jobId: context.job.job_id,
      revision: context.job.revision,
    }).then((findings) => {
      const current = context.host.store.read(operationId);
      if (!current || current.operation.state !== "running") return;
      if (findings.executed !== true) {
        settleNativeDispatchFailure(context.host, operationId, new NativeDispatchError("Native review did not publish findings", true));
        return;
      }
      if (findings.productMutated) {
        failOperation(context.host, current, "invalid_contract", "Review cannot mutate product code");
        context.host.lease.release(operationId);
        return;
      }
      current.operation.state = "succeeded";
      current.operation.updated_at = nowIso(context.host.clock);
      current.operation.error = null;
      current.operation.result = { kind: "review", findings: findings.findings, product_mutated: false };
      context.host.store.update(current);
      context.host.lease.release(operationId);
    }).catch((error) => {
      settleNativeDispatchFailure(context.host, operationId, error);
    });
    return { dispatch: true, holdLease: true };
  }

  if (action === "replan") {
    const reason = String(context.request.parameters.reason ?? "");
    const replan = nativeOps.replanMilestone;
    if (!replan) {
      failOperation(context.host, stored, "runtime_unavailable", "Native replan workflow is not registered");
      return { dispatch: false, holdLease: false };
    }
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "replan" };
    context.host.store.update(stored);
    const operationId = stored.operation.operation_id;
    void replan({
      basePath,
      milestoneId,
      reason,
      operationId,
      jobId: context.job.job_id,
      revision: context.job.revision,
    }).then((result) => {
      const current = context.host.store.read(operationId);
      if (!current || current.operation.state !== "running") return;
      if (result.preservedCompleted !== true) {
        settleNativeDispatchFailure(context.host, operationId, new NativeDispatchError("native replan did not persist a plan", true));
        return;
      }
      context.host.jobs.bumpRevision(context.job.job_id);
      current.operation.state = "succeeded";
      current.operation.updated_at = nowIso(context.host.clock);
      current.operation.error = null;
      current.operation.result = {
        kind: "replan",
        preserved_completed: result.preservedCompleted,
        evidence_invalidated: result.evidenceInvalidated,
        reason,
      };
      context.host.store.update(current);
      context.host.lease.release(operationId);
    }).catch((error) => {
      settleNativeDispatchFailure(context.host, operationId, error);
    });
    return { dispatch: true, holdLease: true };
  }

  if (action === "start" || action === "resume") {
    setWorkspacePhase(basePath, "implement");
    const start = await (nativeOps.startScopedAuto ?? defaultStart)({
      basePath,
      milestoneId,
      resume: action === "resume",
    });
    lastMilestoneLock.set(basePath, start.milestoneLock);
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = {
      kind: action,
      milestoneLock: start.milestoneLock,
      scoped: true,
    };
    context.host.store.update(stored);
    observeDispatch(context.host, stored.operation.operation_id, start.dispatch);
    return { dispatch: true, holdLease: true };
  }

  return { dispatch: false, holdLease: false };
}

export function issueCrashRecovery(host: CommandHost, operationId: string, jobId: string | null, reason: string) {
  return issueRecoveryId({
    operation_id: operationId,
    job_id: jobId,
    reason,
    issued_at: nowIso(host.clock),
    next_state: "recovery_required",
  });
}
