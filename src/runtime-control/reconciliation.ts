// Project/App: gsd-pi
// File Purpose: Append-only reconciliation of pre-binding false-success cancels.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import type { OperationStore } from "./operation-store.ts";
import { MODEL_PRODUCING_ACTIONS, type StoredOperation } from "./types.ts";

export type ReconciliationDecision = {
  operation_id: string;
  cancel_operation_id: string;
  job_id: string | null;
  decision: "reconciled";
  provenance: "r0-worker-shutdown";
  worker_cleanup: {
    cgroup: "absent";
    signal: "SIGKILL";
    descendants_gone: true;
    pids_gone: number[];
    source: string;
  };
  backend_observations: {
    coding_slots: Record<string, unknown>;
    ha_slots: Record<string, unknown>;
  };
  binding_assigned: false;
  decided_at: string;
};

export type UnreconciledFalseSuccess = {
  operation_id: string;
  cancel_operation_id: string;
  job_id: string | null;
};

export function reconciliationDir(stateRoot: string): string {
  return join(stateRoot, "runtime-control", "reconciliation");
}

export function reconciliationPath(stateRoot: string, operationId: string): string {
  return join(reconciliationDir(stateRoot), `${operationId}.json`);
}

function idleObservation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const observation = value as { is_processing?: unknown; n_ctx?: unknown };
  return observation.is_processing === false && typeof observation.n_ctx === "number";
}

export function decisionMatchesOperation(value: unknown, operationId: string): value is ReconciliationDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as ReconciliationDecision;
  if (decision.operation_id !== operationId) return false;
  if (typeof decision.cancel_operation_id !== "string" || !decision.cancel_operation_id) return false;
  if (typeof decision.job_id !== "string" || !decision.job_id) return false;
  if (typeof decision.decided_at !== "string" || !decision.decided_at) return false;
  if (decision.decision !== "reconciled" || decision.provenance !== "r0-worker-shutdown") return false;
  if (decision.binding_assigned !== false) return false;
  const cleanup = decision.worker_cleanup;
  if (!cleanup || cleanup.cgroup !== "absent" || cleanup.signal !== "SIGKILL" || cleanup.descendants_gone !== true) return false;
  if (!Array.isArray(cleanup.pids_gone) || cleanup.pids_gone.length === 0) return false;
  if (!cleanup.pids_gone.every((pid) => typeof pid === "number")) return false;
  if (typeof cleanup.source !== "string" || !cleanup.source.trim()) return false;
  return idleObservation(decision.backend_observations?.coding_slots)
    && idleObservation(decision.backend_observations?.ha_slots);
}

export function readReconciliationDecision(stateRoot: string, operationId: string): ReconciliationDecision | null {
  const path = reconciliationPath(stateRoot, operationId);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return null;
    const parsed: unknown = JSON.parse(text);
    return decisionMatchesOperation(parsed, operationId) ? parsed : null;
  } catch {
    return null;
  }
}

export function reconciliationClearsFalseSuccess(
  stateRoot: string,
  operationId: string,
  expected: { cancelOperationId: string; jobId: string },
): boolean {
  const decision = readReconciliationDecision(stateRoot, operationId);
  return decision?.cancel_operation_id === expected.cancelOperationId && decision.job_id === expected.jobId;
}

export function hasReconciliation(stateRoot: string, operationId: string): boolean {
  return readReconciliationDecision(stateRoot, operationId) !== null;
}

function cleanupAcknowledged(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  return result.dispatch_quiesced === true
    && result.request_closed === true
    && result.tools_drained === true;
}

function isModelProducing(stored: StoredOperation): boolean {
  return (MODEL_PRODUCING_ACTIONS as readonly string[]).includes(stored.operation.action);
}

export function findUnreconciledFalseSuccesses(store: OperationStore): UnreconciledFalseSuccess[] {
  const found: UnreconciledFalseSuccess[] = [];
  for (const cancel of store.list()) {
    if (cancel.operation.action !== "cancel" || cancel.operation.state !== "succeeded") continue;
    const result = cancel.operation.result;
    if (!result || result.cancelled !== true) continue;
    if (cleanupAcknowledged(result)) continue;
    const targetId = cancel.operation.target_operation_id
      ?? (typeof result.target_operation_id === "string" ? result.target_operation_id : null);
    if (!targetId) continue;
    const target = store.read(targetId);
    if (!target || !isModelProducing(target)) continue;
    if (target.backend_binding) continue;
    if (reconciliationClearsFalseSuccess(store.stateRoot, targetId, {
      cancelOperationId: cancel.operation.operation_id,
      jobId: target.operation.job_id,
    })) continue;
    found.push({
      operation_id: targetId,
      cancel_operation_id: cancel.operation.operation_id,
      job_id: target.operation.job_id,
    });
  }
  return found;
}

export function appendReconciliationDecision(stateRoot: string, decision: ReconciliationDecision): string {
  if (!decisionMatchesOperation(decision, decision.operation_id)) {
    throw new Error("Reconciliation decision is missing operation identity or required evidence");
  }
  const path = reconciliationPath(stateRoot, decision.operation_id);
  if (existsSync(path)) {
    throw new Error(`Reconciliation already exists for ${decision.operation_id}`);
  }
  atomicWriteJson(path, decision);
  return path;
}
