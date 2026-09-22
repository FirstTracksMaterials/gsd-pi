// Project/App: gsd-pi
// File Purpose: Production review and replan calls used by the packaged runtime host.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { abortOwnedWorker, getProjectBridgeServiceForCwd, sendBridgeInput } from "../web/bridge-service.ts";
import { NativeDispatchError } from "./native-auto-dispatch.ts";
import type { NativeReplanResult, NativeReviewResult } from "./native-commands.ts";

const WORKFLOW_TIMEOUT_MS = 90_000;

type WorkflowIdentity = {
  basePath: string;
  milestoneId: string;
  operationId: string;
  jobId: string;
  revision: number;
};

function bridgeRejected(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "success" in result && (result as { success?: boolean }).success === false);
}

function bridgeError(result: unknown, fallback: string): string {
  if (result && typeof result === "object" && "error" in result && typeof (result as { error?: unknown }).error === "string") {
    return (result as { error: string }).error;
  }
  return fallback;
}

function waitForAgentEnd(basePath: string): { promise: Promise<void>; cancel: () => void } {
  const bridge = getProjectBridgeServiceForCwd(basePath);
  let unsubscribe = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      unsubscribe();
      reject(new NativeDispatchError("native workflow did not finish", true));
    }, WORKFLOW_TIMEOUT_MS);
    unsubscribe = bridge.subscribe((event) => {
      if (!event || typeof event !== "object" || !("type" in event)) return;
      if ((event as { type?: string }).type !== "agent_end") return;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}

async function awaitMatchingFile(path: string, accept: (parsed: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (accept(parsed)) return parsed;
      } catch {
        // A partial write is not a completed artifact.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function matchesIdentity(parsed: Record<string, unknown>, input: WorkflowIdentity): boolean {
  return parsed.operation_id === input.operationId
    && parsed.job_id === input.jobId
    && parsed.milestone_id === input.milestoneId
    && parsed.revision === input.revision;
}

export async function publishNativeReviewFindings(input: WorkflowIdentity): Promise<NativeReviewResult> {
  const finished = waitForAgentEnd(input.basePath);
  const message = `/gsd review --milestone ${input.milestoneId} --operation ${input.operationId} --job ${input.jobId} --revision ${input.revision}`;
  const result = await sendBridgeInput({ type: "prompt", message }, input.basePath);
  if (bridgeRejected(result)) {
    finished.cancel();
    throw new NativeDispatchError(bridgeError(result, "native review workflow did not accept the review"), false);
  }
  try {
    await finished.promise;
  } catch (error) {
    const evidence = await abortOwnedWorker(input.basePath, {
      operationId: input.operationId,
      jobId: input.jobId,
    });
    const began = evidence.cleaned !== true;
    throw new NativeDispatchError(error instanceof Error ? error.message : "native review workflow did not finish", began);
  }
  const published = await awaitMatchingFile(
    join(input.basePath, ".gsd", "reviews", `${input.milestoneId}.json`),
    (parsed) => parsed.executed === true && matchesIdentity(parsed, input),
  );
  if (!published) {
    const evidence = await abortOwnedWorker(input.basePath, {
      operationId: input.operationId,
      jobId: input.jobId,
    });
    throw new NativeDispatchError("native review did not publish findings for this operation", evidence.cleaned !== true);
  }
  return {
    findings: Array.isArray(published.findings) ? published.findings : [],
    productMutated: published.product_mutated === true,
    executed: true,
  };
}

export async function replanNativeMilestone(input: WorkflowIdentity & { reason: string }): Promise<NativeReplanResult> {
  const finished = waitForAgentEnd(input.basePath);
  const message = `/gsd dispatch replan ${input.milestoneId} --operation ${input.operationId} --job ${input.jobId} --revision ${input.revision}`;
  const result = await sendBridgeInput({ type: "prompt", message }, input.basePath);
  if (bridgeRejected(result)) {
    finished.cancel();
    throw new NativeDispatchError(bridgeError(result, "native replan workflow did not accept the replan"), false);
  }
  try {
    await finished.promise;
  } catch (error) {
    throw new NativeDispatchError(error instanceof Error ? error.message : "native replan workflow did not finish", true);
  }
  const receipt = await awaitMatchingFile(
    join(input.basePath, ".gsd", "runtime", "native-replan.json"),
    (parsed) => parsed.preserved_completed === true && matchesIdentity(parsed, input) && typeof parsed.plan_path === "string",
  );
  if (!receipt || typeof receipt.plan_path !== "string" || !existsSync(receipt.plan_path)) {
    throw new NativeDispatchError("native replan did not persist a plan for this operation", false);
  }
  const plan = readFileSync(receipt.plan_path, "utf8");
  const completed = Array.isArray(receipt.completed_task_ids) ? receipt.completed_task_ids : [];
  for (const taskId of completed) {
    if (typeof taskId === "string" && !plan.includes(taskId)) {
      throw new NativeDispatchError("native replan did not preserve completed work", true);
    }
  }
  const stampPath = join(input.basePath, ".gsd", "runtime", "invalidated-evidence", `${input.milestoneId}.json`);
  let evidenceInvalidated: string[] = [];
  if (existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { evidence_ids?: unknown };
      if (Array.isArray(stamp.evidence_ids)) {
        evidenceInvalidated = stamp.evidence_ids.filter((item): item is string => typeof item === "string");
      }
    } catch {
      evidenceInvalidated = [];
    }
  }
  return { preservedCompleted: true, evidenceInvalidated };
}
