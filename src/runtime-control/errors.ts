// Project/App: gsd-pi
// File Purpose: Stable runtime-v1 error envelopes (R2).

import type { RuntimeError } from "./types.ts";

export type ErrorEnvelope = { error: RuntimeError };

export class RuntimeControlError extends Error {
  readonly status: number;
  readonly body: ErrorEnvelope;

  constructor(status: number, error: RuntimeError) {
    super(error.message);
    this.name = "RuntimeControlError";
    this.status = status;
    this.body = { error };
  }
}

export function errorEnvelope(error: RuntimeError): ErrorEnvelope {
  return { error };
}

export function invalidRequest(message: string, retryable = false): RuntimeControlError {
  return new RuntimeControlError(400, { code: "invalid_request", message, retryable });
}

export function unknownJob(message: string): RuntimeControlError {
  return new RuntimeControlError(404, { code: "unknown_job", message, retryable: false });
}

export function revisionConflict(message: string): RuntimeControlError {
  return new RuntimeControlError(409, { code: "revision_conflict", message, retryable: false });
}

export function requestIdConflict(message: string, operationId?: string): RuntimeControlError {
  return new RuntimeControlError(409, {
    code: "request_id_conflict",
    message,
    retryable: false,
    ...(operationId ? { operation_id: operationId } : {}),
  });
}

export function modelBusy(message: string, operationId?: string | null): RuntimeControlError {
  return new RuntimeControlError(409, {
    code: "model_busy",
    message,
    retryable: true,
    operation_id: operationId ?? null,
  });
}

export function policyUnavailable(message: string): RuntimeControlError {
  return new RuntimeControlError(503, { code: "policy_unavailable", message, retryable: true });
}

export function runtimeUnavailable(message: string, operationId?: string | null): RuntimeControlError {
  return new RuntimeControlError(503, {
    code: "runtime_unavailable",
    message,
    retryable: true,
    operation_id: operationId ?? null,
  });
}

export function notFound(code: RuntimeError["code"], message: string): RuntimeControlError {
  return new RuntimeControlError(404, { code, message, retryable: false });
}

export function jsonError(error: RuntimeControlError): { status: number; body: ErrorEnvelope } {
  return { status: error.status, body: error.body };
}
