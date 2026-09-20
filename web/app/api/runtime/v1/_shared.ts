// Project/App: gsd-pi
// File Purpose: Shared runtime-v1 HTTP helpers.

import type { AdmitResult } from "../../../../../src/runtime-control/admission.ts";
import {
  admitCommand,
  getOperation,
  getOperationByRequest,
  getRuntimeControl,
} from "../../../../../src/runtime-control/index.ts";
import type { RuntimeError } from "../../../../../src/runtime-control/types.ts";

export { admitCommand, getOperation, getOperationByRequest };
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

export function admitResponse(result: AdmitResult): Response {
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

export function control() {
  return getRuntimeControl();
}

export async function routeParam(
  params: Promise<Record<string, string>> | Record<string, string>,
  name: string,
): Promise<string> {
  const resolved = await Promise.resolve(params);
  return decodeURIComponent(resolved[name] ?? "");
}
