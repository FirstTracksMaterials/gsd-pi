// Project/App: gsd-pi
// File Purpose: Production review and replan calls used by the packaged runtime host.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { abortOwnedWorker, sendBridgeInput } from "../web/bridge-service.ts";
import { NativeDispatchError } from "./native-auto-dispatch.ts";
import type { NativeReplanResult, NativeReviewResult } from "./native-commands.ts";
import { invalidateAffectedVerificationEvidence } from "../resources/extensions/gsd/replan-evidence.ts";

function bridgeRejected(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "success" in result && (result as { success?: boolean }).success === false);
}

function publishedFindings(basePath: string, milestoneId: string): NativeReviewResult | null {
  const findingsPath = join(basePath, ".gsd", "reviews", `${milestoneId}.json`);
  if (!existsSync(findingsPath)) return null;
  const parsed = JSON.parse(readFileSync(findingsPath, "utf8")) as {
    executed?: unknown;
    findings?: unknown;
    productMutated?: unknown;
  };
  if (parsed.executed !== true) return null;
  return {
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    productMutated: parsed.productMutated === true,
    executed: true,
  };
}

export async function publishNativeReviewFindings(input: {
  basePath: string;
  milestoneId: string;
  operationId: string;
  jobId: string;
}): Promise<NativeReviewResult> {
  const result = await sendBridgeInput(
    { type: "prompt", message: `/gsd review --milestone ${input.milestoneId}` },
    input.basePath,
  );
  if (bridgeRejected(result)) {
    const message = result && typeof result === "object" && "error" in result && typeof (result as { error?: unknown }).error === "string"
      ? (result as { error: string }).error
      : "native review workflow did not accept the review";
    throw new NativeDispatchError(message, false);
  }
  const published = publishedFindings(input.basePath, input.milestoneId);
  if (published) return published;
  const evidence = await abortOwnedWorker(input.basePath, {
    operationId: input.operationId,
    jobId: input.jobId,
  });
  throw new NativeDispatchError("native review did not publish findings", evidence.cleaned !== true);
}

export async function replanNativeMilestone(input: {
  basePath: string;
  milestoneId: string;
  reason: string;
}): Promise<NativeReplanResult> {
  const evidenceInvalidated = invalidateAffectedVerificationEvidence(input);
  return { preservedCompleted: true, evidenceInvalidated };
}
