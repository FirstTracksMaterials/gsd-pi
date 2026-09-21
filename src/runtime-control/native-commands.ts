// Project/App: gsd-pi
// File Purpose: Typed runtime-v1 command adapters over existing GSD domain functions.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluateCompulsoryPolicy } from "../resources/extensions/gsd/required-policy.ts";
import { beginPrepareMode, endPrepareMode, isImplementationUnit } from "./prepare-boundary.ts";
import { probeBackendIdle } from "./idle-probe.ts";
import { applyRecovery, getRecovery, issueRecoveryId } from "./recovery.ts";
import type { CommandAction, CommandRequest, JobRecord, Operation, ResolvedProject, StoredOperation } from "./types.ts";
import type { JobCatalog } from "./job-catalog.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { setWorkspacePhase } from "./workspace-profile.ts";
import { dispatchNativeScopedAuto } from "./native-auto-dispatch.ts";

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
};

export type NativeReviewResult = {
  findings: unknown[];
  productMutated: boolean;
};

export type NativeReplanResult = {
  preservedCompleted: boolean;
  evidenceInvalidated: string[];
  revision?: number;
};

export type NativeWorkflowOps = {
  startScopedAuto?: (input: { basePath: string; milestoneId: string; resume: boolean }) => Promise<NativeStartResult>;
  publishReviewFindings?: (input: { basePath: string; milestoneId: string }) => Promise<NativeReviewResult>;
  replanMilestone?: (input: { basePath: string; milestoneId: string; reason: string }) => Promise<NativeReplanResult>;
  dispatchWouldSelect?: (input: { basePath: string; milestoneId: string }) => Promise<{ unitType: string; unitId: string } | null>;
};

const lastMilestoneLock = new Map<string, string>();
let nativeOps: NativeWorkflowOps = {};
const reviewFindings = new Map<string, NativeReviewResult>();
const replanEvidence = new Map<string, string[]>();

export function registerNativeWorkflowOpsForTest(ops: NativeWorkflowOps | null): void {
  nativeOps = ops ?? {};
}

export function resetNativeWorkflowOpsForTest(): void {
  nativeOps = {};
  lastMilestoneLock.clear();
  reviewFindings.clear();
  replanEvidence.clear();
}

export function getLastMilestoneLock(basePath: string): string | undefined {
  return lastMilestoneLock.get(basePath);
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function loadExecuteCancel(): Promise<{ executeCancel: (input: {
  host: CommandHost;
  project: ResolvedProject;
  cancelOperation: StoredOperation;
}) => Promise<{ holdLease: boolean }> }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = process.env.GSD_WEB_PACKAGE_ROOT?.trim();
  const candidates = [
    packaged ? join(packaged, "src", "runtime-control", "cancel.ts") : "",
    join(here, "cancel.ts"),
  ].filter((path) => path && existsSync(path));
  let lastError: unknown = new Error("cancel module was not found beside the runtime or GSD_WEB_PACKAGE_ROOT");
  for (const candidate of candidates) {
    try {
      return await import(/* webpackIgnore: true */ pathToFileURL(candidate).href) as {
        executeCancel: (input: {
          host: CommandHost;
          project: ResolvedProject;
          cancelOperation: StoredOperation;
        }) => Promise<{ holdLease: boolean }>;
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function storedFromContext(context: NativeCommandContext): StoredOperation | undefined {
  return context.host.store.read(context.operation.operation_id);
}

async function defaultStart(input: { basePath: string; milestoneId: string; resume: boolean }): Promise<NativeStartResult> {
  lastMilestoneLock.set(input.basePath, input.milestoneId);
  process.env.GSD_MILESTONE_LOCK = input.milestoneId;
  // Existing native auto via the RPC worker. Fire-and-forget: HTTP admission
  // must not await generation (R4). Owner C06.
  void dispatchNativeScopedAuto(input).catch((error) => {
    console.error(
      "[gsd] native auto dispatch failed:",
      error instanceof Error ? error.stack ?? error.message : error,
    );
  });
  return { started: true, milestoneLock: input.milestoneId };
}

async function defaultReview(input: { basePath: string; milestoneId: string }): Promise<NativeReviewResult> {
  const existing = reviewFindings.get(`${input.basePath}:${input.milestoneId}`);
  if (existing) return existing;
  return { findings: [], productMutated: false };
}

async function defaultReplan(input: { basePath: string; milestoneId: string; reason: string }): Promise<NativeReplanResult> {
  const key = `${input.basePath}:${input.milestoneId}`;
  let invalidated = replanEvidence.get(key);
  if (!invalidated) {
    try {
      const { invalidateAffectedVerificationEvidence } = await import("../resources/extensions/gsd/replan-evidence.ts");
      invalidated = invalidateAffectedVerificationEvidence({
        basePath: input.basePath,
        milestoneId: input.milestoneId,
        reason: input.reason,
      });
    } catch {
      invalidated = [`evidence:${input.milestoneId}:${input.reason}`];
    }
  }
  replanEvidence.set(key, invalidated);
  return { preservedCompleted: true, evidenceInvalidated: invalidated };
}

export function recordReviewFindingsForTest(basePath: string, milestoneId: string, result: NativeReviewResult): void {
  reviewFindings.set(`${basePath}:${milestoneId}`, result);
}

export function recordReplanEvidenceForTest(basePath: string, milestoneId: string, ids: string[]): void {
  replanEvidence.set(`${basePath}:${milestoneId}`, ids);
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
    const { executeCancel } = await loadExecuteCancel();
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
    if (diagnostic.next_state === "recovery_required") {
      const idle = await probeBackendIdle(context.project.backend_idle_probe);
      if (!idle.idle) {
        const blockedAt = nowIso(context.host.clock);
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = blockedAt;
        stored.operation.error = {
          code: "recovery_required",
          message: idle.reason,
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
    } else {
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
    return { dispatch: true, holdLease: true };
  }

  if (action === "review") {
    setWorkspacePhase(basePath, "review");
    const findings = await (nativeOps.publishReviewFindings ?? defaultReview)({ basePath, milestoneId });
    if (findings.productMutated) {
      stored.operation.state = "failed";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.error = {
        code: "invalid_contract",
        message: "Review cannot mutate product code",
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: false };
    }
    stored.operation.state = "succeeded";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "review", findings: findings.findings, product_mutated: false };
    context.host.store.update(stored);
    return { dispatch: false, holdLease: false };
  }

  if (action === "replan") {
    const reason = String(context.request.parameters.reason ?? "");
    const result = await (nativeOps.replanMilestone ?? defaultReplan)({ basePath, milestoneId, reason });
    context.host.jobs.bumpRevision(context.job.job_id);
    stored.operation.state = "succeeded";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = {
      kind: "replan",
      preserved_completed: result.preservedCompleted,
      evidence_invalidated: result.evidenceInvalidated,
      reason,
    };
    context.host.store.update(stored);
    return { dispatch: false, holdLease: false };
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
