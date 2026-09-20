// Project/App: gsd-pi
// File Purpose: Route pending-question answers to native UI machinery without a second lease.

import { randomUUID } from "node:crypto";

import { invalidRequest, requestIdConflict, revisionConflict, RuntimeControlError, unknownJob } from "./errors.ts";
import { fingerprintAnswer } from "./fingerprint.ts";
import type { AdmissionHost } from "./admission.ts";
import type { Operation, StoredOperation } from "./types.ts";

export type AnswerRequest = {
  question_id: string;
  request_id: string;
  expected_revision: number;
  expected_epoch: number;
  response: unknown;
};

export type PendingQuestion = {
  question_id: string;
  job_id: string;
  session_id: string;
};

export type NativeAnswerRouter = (input: {
  question: PendingQuestion;
  response: unknown;
  request_id: string;
}) => Promise<{ accepted: boolean; reason?: string }>;

const pending = new Map<string, PendingQuestion>();
let nativeRouter: NativeAnswerRouter | null = null;

export function registerPendingQuestion(question: PendingQuestion): void {
  pending.set(`${question.job_id}:${question.question_id}`, question);
}

export function registerNativeAnswerRouterForTest(router: NativeAnswerRouter | null): void {
  nativeRouter = router;
}

export function resetAnswersForTest(): void {
  pending.clear();
  nativeRouter = null;
}

async function defaultNativeAnswerRouter(input: {
  question: PendingQuestion;
  response: unknown;
  request_id: string;
}): Promise<{ accepted: boolean; reason?: string }> {
  try {
    const remote = await import("../resources/extensions/remote-questions/store.ts");
    const answered = remote.markPromptAnswered(input.question.session_id, {
      answers: input.response,
    } as never);
    if (answered) return { accepted: true };
  } catch {
    // Local pending questions do not require a remote prompt record.
  }
  return { accepted: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAnswerRequest(raw: unknown): AnswerRequest {
  if (!raw || typeof raw !== "object") throw invalidRequest("Answer request must be a JSON object");
  const record = raw as Record<string, unknown>;
  if (typeof record.question_id !== "string" || !record.question_id.trim()) {
    throw invalidRequest("question_id is required");
  }
  if (typeof record.request_id !== "string" || !UUID_RE.test(record.request_id)) {
    throw invalidRequest("request_id must be a UUID");
  }
  if (typeof record.expected_revision !== "number" || !Number.isInteger(record.expected_revision) || record.expected_revision < 0) {
    throw invalidRequest("expected_revision must be a nonnegative integer");
  }
  if (typeof record.expected_epoch !== "number" || !Number.isInteger(record.expected_epoch) || record.expected_epoch < 0) {
    throw invalidRequest("expected_epoch must be a nonnegative integer");
  }
  if (!("response" in record)) throw invalidRequest("typed response is required");
  return {
    question_id: record.question_id,
    request_id: record.request_id,
    expected_revision: record.expected_revision,
    expected_epoch: record.expected_epoch,
    response: record.response,
  };
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function canonicalResponse(value: unknown): string {
  return JSON.stringify(value);
}

export async function admitAnswer(
  host: AdmissionHost,
  jobId: string,
  raw: unknown,
): Promise<{ ok: true; status: 202 | 200; operation: Operation } | { ok: false; status: number; body: { error: import("./types.ts").RuntimeError } }> {
  try {
    return await host.store.withWriter(() => admitAnswerLocked(host, jobId, raw));
  } catch (error) {
    if (error instanceof RuntimeControlError) {
      return { ok: false, status: error.status, body: error.body };
    }
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          code: "runtime_unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      },
    };
  }
}

async function admitAnswerLocked(
  host: AdmissionHost,
  jobId: string,
  raw: unknown,
): Promise<{ ok: true; status: 202 | 200; operation: Operation }> {
  const decodedJobId = decodeURIComponent(jobId);
  const job = host.jobs.get(decodedJobId);
  if (!job) throw unknownJob(`Unknown job ${decodedJobId}`);
  const parsed = parseAnswerRequest(raw);
  const fingerprint = fingerprintAnswer({
    job_id: decodedJobId,
    question_id: parsed.question_id,
    request_id: parsed.request_id,
    expected_revision: parsed.expected_revision,
    expected_epoch: parsed.expected_epoch,
    response: parsed.response,
  });

  const existing = host.store.lookupByRequest(parsed.request_id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw requestIdConflict("Duplicate answer request_id with a different value", existing.operation.operation_id);
    }
    return { ok: true, status: 202, operation: existing.operation };
  }

  if (parsed.expected_epoch !== job.authority_epoch) {
    throw revisionConflict("Stale authority_epoch; refresh snapshot before answering");
  }
  if (parsed.expected_revision !== job.revision) {
    throw revisionConflict("expected_revision does not match the current job revision");
  }

  const question = pending.get(`${decodedJobId}:${parsed.question_id}`);
  if (!question || question.job_id !== decodedJobId) {
    throw invalidRequest(`Question ${parsed.question_id} is not pending for job ${decodedJobId}`);
  }

  const router = nativeRouter ?? defaultNativeAnswerRouter;
  const routed = await router({ question, response: parsed.response, request_id: parsed.request_id });
  const admittedAt = nowIso(host.clock);
  const operationId = randomUUID();
  const operation: Operation = {
    protocol_version: 1,
    operation_id: operationId,
    request_id: parsed.request_id,
    job_id: decodedJobId,
    action: "answer",
    state: routed.accepted ? "succeeded" : "failed",
    admitted_at: admittedAt,
    updated_at: admittedAt,
    result: routed.accepted
      ? {
        kind: "answer",
        question_id: parsed.question_id,
        session_id: question.session_id,
        response: parsed.response,
        accepted: true,
      }
      : null,
    error: routed.accepted
      ? null
      : {
        code: "invalid_request",
        message: routed.reason ?? "Native question rejected the response",
        retryable: false,
        operation_id: operationId,
      },
    target_operation_id: host.lease.current()?.operation_id ?? null,
  };
  const stored: StoredOperation = {
    operation,
    fingerprint,
    kind: "answer",
    dispatch_intent: false,
  };
  host.store.writeAccepted(stored);
  if (!routed.accepted) host.store.update(stored);
  void canonicalResponse;
  return { ok: true, status: 202, operation: stored.operation };
}
