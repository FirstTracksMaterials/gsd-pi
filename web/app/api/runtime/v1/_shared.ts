// Project/App: gsd-pi
// File Purpose: Shared runtime-v1 HTTP helpers.

import {
  admitCommand,
  getOperation,
  getOperationByRequest,
} from "../../../../../src/runtime-control/admission.ts";
import { admitAnswer } from "../../../../../src/runtime-control/answers.ts";
import { admitImport } from "../../../../../src/runtime-control/import-jobs.ts";
import { buildJobSnapshot, listProjectJobs } from "../../../../../src/runtime-control/snapshots.ts";
import { ensureRuntimeControl } from "../../../../../src/runtime-control/control.ts";
import { readJobHistory } from "../../../../../src/runtime-control/history.ts";
import { subscribeProjectEvents } from "../../../../../src/runtime-control/event-hub.ts";
import { RuntimeControlError } from "../../../../../src/runtime-control/errors.ts";
import type { Operation, RuntimeError } from "../../../../../src/runtime-control/types.ts";

export { admitAnswer, admitCommand, admitImport, getOperation, getOperationByRequest };
export { buildJobSnapshot, listProjectJobs, readJobHistory, subscribeProjectEvents };
export { RuntimeControlError };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function notReady(message: string): Response {
  return errorResponse(503, {
    code: "runtime_unavailable",
    message,
    retryable: true,
  });
}

export function errorResponse(status: number, error: RuntimeError): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function admitResponse(result: {
  ok: true;
  status: number;
  operation: Operation;
} | {
  ok: false;
  status: number;
  body: { error: RuntimeError };
}): Response {
  if (!result.ok) {
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.json(result.operation, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be JSON"), { status: 400 });
  }
}

export async function control() {
  return ensureRuntimeControl();
}

export function controlError(error: unknown): Response {
  if (error instanceof RuntimeControlError) {
    return errorResponse(error.status, error.body.error);
  }
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status: number }).status) : 400;
  return errorResponse(status, {
    code: "invalid_request",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  });
}

export async function routeParam(
  params: Promise<Record<string, string>> | Record<string, string>,
  name: string,
): Promise<string> {
  const resolved = await Promise.resolve(params);
  return decodeURIComponent(resolved[name] ?? "");
}
