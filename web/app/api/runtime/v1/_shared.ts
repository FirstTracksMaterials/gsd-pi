// Project/App: gsd-pi
// File Purpose: Shared runtime-v1 HTTP helpers.

import {
  admitCommand,
  getOperation,
  getOperationByRequest,
} from "../../../../../src/runtime-control/admission.ts";
import { admitAnswer, registerAnswerWorkerLookup, verdictForAnswerSession } from "../../../../../src/runtime-control/answers.ts";
import { admitImport } from "../../../../../src/runtime-control/import-jobs.ts";
import { buildJobSnapshot, listProjectJobs } from "../../../../../src/runtime-control/snapshots.ts";
import { ensureRuntimeControl } from "../../../../../src/runtime-control/control.ts";
import { registerNativeAutoDispatch, NativeDispatchError } from "../../../../../src/runtime-control/native-auto-dispatch.ts";
import { registerNativeWorkflowOps } from "../../../../../src/runtime-control/native-commands.ts";
import { publishNativeReviewFindings, replanNativeMilestone } from "../../../../../src/runtime-control/native-workflow.ts";
import { registerCancelNativeOps } from "../../../../../src/runtime-control/cancel.ts";
import { readJobHistory } from "../../../../../src/runtime-control/history.ts";
import { subscribeProjectEvents } from "../../../../../src/runtime-control/event-hub.ts";
import { RuntimeControlError } from "../../../../../src/runtime-control/errors.ts";
import type { Operation, RuntimeError } from "../../../../../src/runtime-control/types.ts";
import { abortOwnedWorker, lookupProjectBridgeServiceForCwd, sendBridgeInput } from "../../../../../src/web/bridge-service.ts";

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

let nativeDispatchBound = false;

function bindNativeDispatch(): void {
  if (nativeDispatchBound) return;
  nativeDispatchBound = true;
  registerNativeAutoDispatch(async (input) => {
    const fault = process.env.GSD_NATIVE_DISPATCH_FAULT;
    if (fault === "refuse") {
      throw new NativeDispatchError("native auto dispatch refused before the prompt", false);
    }
    if (fault === "lost") {
      throw new NativeDispatchError("native auto dispatch lost the response after the prompt", true);
    }
    const result = await sendBridgeInput({ type: "prompt", message: "/gsd auto" }, input.basePath);
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      const message = "error" in result && typeof result.error === "string" ? result.error : "native auto dispatch failed";
      throw new NativeDispatchError(message, false);
    }
  });
  registerNativeWorkflowOps({
    publishReviewFindings: publishNativeReviewFindings,
    replanMilestone: replanNativeMilestone,
    dispatchWouldSelect: async ({ basePath, milestoneId }) => {
      const { deriveState } = await import("../../../../../src/resources/extensions/gsd/state/derive/index.ts");
      const { resolveDispatch } = await import("../../../../../src/resources/extensions/gsd/auto-dispatch.ts");
      const state = await deriveState(basePath);
      const action = await resolveDispatch({
        basePath,
        mid: milestoneId,
        midTitle: state.activeMilestone?.title ?? milestoneId,
        state,
        preview: true,
      });
      if (action.action !== "dispatch") return null;
      return { unitType: action.unitType, unitId: action.unitId };
    },
  });
  registerCancelNativeOps({
    abortOwnedWorker: (input) => abortOwnedWorker(input.projectCwd, {
      operationId: input.operationId,
      jobId: input.jobId,
    }),
  });
  registerAnswerWorkerLookup((projectCwd, sessionId) => {
    const bridge = lookupProjectBridgeServiceForCwd(projectCwd);
    if (!bridge) return { ok: true };
    return verdictForAnswerSession(bridge.getSnapshot().activeSessionId, sessionId);
  });
}

export async function control() {
  bindNativeDispatch();
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
