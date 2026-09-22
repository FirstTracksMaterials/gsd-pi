// Project/App: gsd-pi
// File Purpose: Positive worker-cleanup receipts. No acknowledgement means not cleaned.

export type WorkerCleanupEvidence = {
  cleaned: boolean;
  dispatch_quiesced: boolean;
  request_closed: boolean;
  tools_drained: boolean;
  operation_id: string | null;
  job_id: string | null;
  session_id: string | null;
  worker_generation: number | null;
  reason: string | null;
};

export type WorkerCleanupExpectation = {
  operationId: string;
  jobId: string;
  sessionId: string | null;
  generation: number;
};

export function missingWorkerCleanup(reason: string): WorkerCleanupEvidence {
  return {
    cleaned: false,
    dispatch_quiesced: false,
    request_closed: false,
    tools_drained: false,
    operation_id: null,
    job_id: null,
    session_id: null,
    worker_generation: null,
    reason,
  };
}

export function acceptWorkerCleanup(
  expected: WorkerCleanupExpectation,
  evidence: WorkerCleanupEvidence,
  currentGeneration: number,
): { ok: boolean; reason: string } {
  if (!evidence.dispatch_quiesced || !evidence.request_closed || !evidence.tools_drained || !evidence.cleaned) {
    return { ok: false, reason: evidence.reason ?? "worker cleanup was not acknowledged" };
  }
  if (evidence.operation_id !== expected.operationId) {
    return { ok: false, reason: "stale operation acknowledgement" };
  }
  if (evidence.job_id !== expected.jobId) {
    return { ok: false, reason: "stale job acknowledgement" };
  }
  if (expected.sessionId !== null && evidence.session_id !== expected.sessionId) {
    return { ok: false, reason: "stale session acknowledgement" };
  }
  if (evidence.worker_generation !== expected.generation || currentGeneration !== expected.generation) {
    return { ok: false, reason: "stale worker generation" };
  }
  return { ok: true, reason: "" };
}
