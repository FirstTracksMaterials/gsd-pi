// Project/App: gsd-pi
// File Purpose: R3-R5 command admission. 202 after durable receipt; no LLM wait.

import { randomUUID } from "node:crypto";

import { getCommandHandler } from "./command-handlers.ts";
import {
  invalidRequest,
  modelBusy,
  policyUnavailable,
  requestIdConflict,
  revisionConflict,
  RuntimeControlError,
  runtimeUnavailable,
} from "./errors.ts";
import { fingerprintCommand } from "./fingerprint.ts";
import { parseJobId } from "./job-catalog.ts";
import type { JobCatalog } from "./job-catalog.ts";
import { CrashWindowError, type OperationStore } from "./operation-store.ts";
import type { ModelLease } from "./model-lease.ts";
import type { RegistrationRegistry } from "./registration.ts";
import {
  COMMAND_ACTIONS,
  MODEL_PRODUCING_ACTIONS,
  PROTOCOL_VERSION,
  type CommandAction,
  type CommandRequest,
  type Operation,
  type RuntimeError,
  type StoredOperation,
} from "./types.ts";
import { isRequiredPolicyReady } from "../resources/extensions/gsd/required-policy.ts";

export type AdmissionHost = {
  registration: RegistrationRegistry;
  jobs: JobCatalog;
  store: OperationStore;
  lease: ModelLease;
  clock: () => Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdmitResult =
  | { ok: true; status: 202 | 200; operation: Operation }
  | { ok: false; status: number; body: { error: RuntimeError } };

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isModelProducing(action: CommandAction): boolean {
  return (MODEL_PRODUCING_ACTIONS as readonly string[]).includes(action);
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseCommandRequest(raw: unknown): CommandRequest {
  if (!raw || typeof raw !== "object") {
    throw invalidRequest("CommandRequest must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (record.protocol_version !== PROTOCOL_VERSION) {
    throw invalidRequest("protocol_version must be 1");
  }
  if (typeof record.request_id !== "string" || !isUuid(record.request_id)) {
    throw invalidRequest("request_id must be a UUID");
  }
  if (typeof record.expected_revision !== "number" || !Number.isInteger(record.expected_revision) || record.expected_revision < 0) {
    throw invalidRequest("expected_revision must be a nonnegative integer");
  }
  if (typeof record.expected_epoch !== "number" || !Number.isInteger(record.expected_epoch) || record.expected_epoch < 0) {
    throw invalidRequest("expected_epoch must be a nonnegative integer");
  }
  if (record.action === "import" || record.action === "answer") {
    throw invalidRequest("import and answer are not valid on the job command route");
  }
  if (typeof record.action !== "string" || !(COMMAND_ACTIONS as readonly string[]).includes(record.action)) {
    throw invalidRequest("action is not a supported command");
  }
  const action = record.action as CommandAction;
  if (!record.parameters || typeof record.parameters !== "object" || Array.isArray(record.parameters)) {
    throw invalidRequest("parameters must be an object");
  }
  const parameters = record.parameters as Record<string, unknown>;
  validateParameters(action, parameters);
  return {
    protocol_version: 1,
    request_id: record.request_id,
    expected_revision: record.expected_revision,
    expected_epoch: record.expected_epoch,
    action,
    parameters,
  };
}

function validateParameters(action: CommandAction, parameters: Record<string, unknown>): void {
  const keys = Object.keys(parameters);
  if (action === "replan") {
    if (keys.length !== 1 || typeof parameters.reason !== "string") {
      throw invalidRequest("replan parameters must be { reason: string }");
    }
    return;
  }
  if (action === "recover") {
    if (keys.length !== 1 || typeof parameters.recovery_id !== "string" || !parameters.recovery_id.trim()) {
      throw invalidRequest("recover parameters must be { recovery_id: string } issued by diagnostics");
    }
    return;
  }
  if (keys.length !== 0) {
    throw invalidRequest(`${action} parameters must be empty`);
  }
}

export async function admitCommand(
  control: AdmissionHost,
  jobId: string,
  rawRequest: unknown,
): Promise<AdmitResult> {
  try {
    return await control.store.withWriter(() => admitLocked(control, jobId, rawRequest));
  } catch (error) {
    if (error instanceof CrashWindowError) {
      return {
        ok: false,
        status: 503,
        body: {
          error: {
            code: "runtime_unavailable",
            message: `Admission interrupted (${error.hook})`,
            retryable: true,
          },
        },
      };
    }
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

async function admitLocked(
  control: AdmissionHost,
  jobId: string,
  rawRequest: unknown,
): Promise<AdmitResult> {
  if (control.registration.error) {
    throw runtimeUnavailable(`Project registration is not ready: ${control.registration.error}`);
  }
  const request = parseCommandRequest(rawRequest);
  const decodedJobId = decodeURIComponent(jobId);
  const { project_id, milestone_id } = parseJobId(decodedJobId);
  const project = control.registration.getById(project_id);
  if (!project) {
    throw invalidRequest(`Project ${project_id} is not registered`);
  }
  const job = control.jobs.require(decodedJobId);
  if (job.project_id !== project_id || job.milestone_id !== milestone_id) {
    throw invalidRequest("job_id does not match registered project");
  }

  const fingerprint = fingerprintCommand({
    kind: "job-command",
    job_id: decodedJobId,
    request,
  });

  const existing = control.store.lookupByRequest(request.request_id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw requestIdConflict("Same request_id with a different fingerprint", existing.operation.operation_id);
    }
    return { ok: true, status: 202, operation: existing.operation };
  }

  if (request.expected_epoch !== job.authority_epoch) {
    throw revisionConflict("Stale authority_epoch; refresh snapshot before retrying");
  }
  if (request.expected_revision !== job.revision) {
    throw revisionConflict("expected_revision does not match the current job revision");
  }

  const policy = await isRequiredPolicyReady(project.target_realpath);
  if (!policy.ready) {
    throw policyUnavailable(policy.reason ?? `Required policy ${project.required_policy} is not ready`);
  }

  if (control.lease.ownershipUnknown()) {
    throw runtimeUnavailable("Lease file is unreadable; previous ownership is unknown. Do not admit work.");
  }
  const needsLease = isModelProducing(request.action);
  const currentLease = control.lease.current();
  if (needsLease && currentLease) {
    throw modelBusy("A model-producing operation already owns admission", currentLease.operation_id);
  }
  if (needsLease && !project.backend_binding) {
    throw runtimeUnavailable("Project has no validated backend binding; refusing model-producing admission");
  }

  const admittedAt = nowIso(control.clock);
  const operationId = randomUUID();
  const operation: Operation = {
    protocol_version: 1,
    operation_id: operationId,
    request_id: request.request_id,
    job_id: decodedJobId,
    action: request.action,
    state: "accepted",
    admitted_at: admittedAt,
    updated_at: admittedAt,
    result: null,
    error: null,
    target_operation_id: request.action === "cancel" ? currentLease?.operation_id ?? null : null,
  };
  const stored: StoredOperation = {
    operation,
    fingerprint,
    kind: "job-command",
    dispatch_intent: false,
    backend_binding: needsLease ? project.backend_binding : null,
  };

  control.store.writeAccepted(stored);
  if (needsLease && project.backend_binding) {
    control.lease.acquire({
      operation_id: operationId,
      job_id: decodedJobId,
      action: request.action,
      acquired_at: admittedAt,
      recovery_required: false,
      backend_binding: project.backend_binding,
    });
  }

  const handler = getCommandHandler();
  const result = await handler({
    operation: stored.operation,
    request,
    job,
    project,
    host: control,
  });
  const latest = control.store.read(operationId) ?? stored;
  if (result?.dispatch) {
    latest.operation.updated_at = nowIso(control.clock);
    control.store.writeDispatchIntent(latest);
  }
  if (result?.holdLease === false && needsLease) {
    control.lease.release(operationId);
  }
  return { ok: true, status: 202, operation: control.store.read(operationId)?.operation ?? latest.operation };
}

export function getOperation(control: AdmissionHost, operationId: string): AdmitResult {
  const stored = control.store.read(decodeURIComponent(operationId));
  if (!stored) {
    return {
      ok: false,
      status: 404,
      body: { error: { code: "unknown_job", message: `Unknown operation ${operationId}`, retryable: false } },
    };
  }
  return { ok: true, status: 200, operation: stored.operation };
}

export function getOperationByRequest(control: AdmissionHost, requestId: string): AdmitResult {
  const stored = control.store.lookupByRequest(decodeURIComponent(requestId));
  if (!stored) {
    return {
      ok: false,
      status: 404,
      body: { error: { code: "unknown_job", message: `Unknown request ${requestId}`, retryable: false } },
    };
  }
  return { ok: true, status: 200, operation: stored.operation };
}
