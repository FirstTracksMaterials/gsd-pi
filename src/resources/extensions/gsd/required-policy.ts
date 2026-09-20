// Project/App: gsd-pi
// File Purpose: Generic required-policy registry (S4). Compulsory host gate, not a notification hook.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  runHostCheck,
  type HostCheckRequest,
  type HostCheckResult,
} from "./host-check-runner.js";
import type { VerificationCheck } from "./types.js";

export type PolicyVerdict = "pass" | "fail" | "inconclusive" | "cancelled";
export type RequiredPolicyPhase = "plan" | "task" | "publication";

export interface RequiredPolicyContext {
  basePath: string;
  phase: RequiredPolicyPhase;
  abortSignal?: AbortSignal;
  runHostCheck: (request: HostCheckRequest) => Promise<HostCheckResult>;
  task?: { milestoneId: string; sliceId: string; taskId: string };
}

export interface PolicyVerificationResult {
  policy_id: string;
  version: string;
  verdict: PolicyVerdict;
  reason?: string;
  malformed?: boolean;
  checks: VerificationCheck[];
  evidence: Record<string, unknown>[];
}

export interface RequiredPolicy {
  id: string;
  version: string;
  selfCheck(context: RequiredPolicyContext): Promise<{ ready: boolean; reason?: string }>;
  validatePlan(context: RequiredPolicyContext): Promise<PolicyVerificationResult>;
  verifyTask(context: RequiredPolicyContext): Promise<PolicyVerificationResult>;
  admission?(context: RequiredPolicyContext): Promise<{ allowed: boolean; reason?: string }>;
  workspace?(context: RequiredPolicyContext): Promise<{ allowed: boolean; reason?: string }>;
}

export type CompulsoryPolicyEvaluation =
  | { kind: "unmanaged" }
  | {
    kind: "blocked";
    reason: string;
    nativeVerdict: "inconclusive";
    checks: VerificationCheck[];
    policyId: string;
  }
  | {
    kind: "evaluated";
    result: PolicyVerificationResult;
    nativeVerdict: "pass" | "fail" | "inconclusive";
    checks: VerificationCheck[];
  };

const policies = new Map<string, RequiredPolicy>();
const projectBindings = new Map<string, string>();

function canonicalProjectPath(basePath: string): string {
  const resolved = resolve(basePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function registerRequiredPolicy(policy: RequiredPolicy): void {
  if (!policy.id || !policy.version) {
    throw new Error("Required policy registration needs id and version");
  }
  policies.set(policy.id, policy);
}

export function unregisterRequiredPolicy(policyId: string): void {
  policies.delete(policyId);
}

export function configureProjectRequiredPolicy(basePath: string, policyId: string): void {
  if (!policyId.trim()) {
    throw new Error("Required policy id must be non-empty");
  }
  projectBindings.set(canonicalProjectPath(basePath), policyId);
}

export function clearProjectRequiredPolicy(basePath: string): void {
  projectBindings.delete(canonicalProjectPath(basePath));
}

export function getProjectRequiredPolicyId(basePath: string): string | undefined {
  return projectBindings.get(canonicalProjectPath(basePath));
}

export function getRegisteredRequiredPolicy(policyId: string): RequiredPolicy | undefined {
  return policies.get(policyId);
}

export function resetRequiredPolicyRegistryForTest(): void {
  policies.clear();
  projectBindings.clear();
}

export function registerRequiredPolicyForTest(policy: RequiredPolicy): RequiredPolicy {
  registerRequiredPolicy(policy);
  return policy;
}

function policyContext(
  basePath: string,
  phase: RequiredPolicyPhase,
  abortSignal?: AbortSignal,
  task?: RequiredPolicyContext["task"],
): RequiredPolicyContext {
  return {
    basePath,
    phase,
    ...(abortSignal ? { abortSignal } : {}),
    ...(task ? { task } : {}),
    runHostCheck,
  };
}

function blockedCheck(reason: string): VerificationCheck {
  return {
    command: "gsd-required-policy",
    exitCode: 1,
    stdout: "",
    stderr: reason,
    durationMs: 0,
  };
}

/**
 * Positive policy readiness. RPC extensionsReady is ignored even if supplied.
 */
export async function isRequiredPolicyReady(
  basePath: string,
  options?: { extensionsReady?: boolean },
): Promise<{ ready: boolean; reason?: string; policyId?: string }> {
  void options?.extensionsReady;
  const policyId = getProjectRequiredPolicyId(basePath);
  if (!policyId) return { ready: true };
  const policy = policies.get(policyId);
  if (!policy) {
    return {
      ready: false,
      policyId,
      reason: `Required policy ${policyId} is not registered`,
    };
  }
  try {
    const check = await policy.selfCheck(policyContext(basePath, "task"));
    if (!check.ready) {
      return {
        ready: false,
        policyId,
        reason: check.reason ?? `Required policy ${policyId} self-check failed`,
      };
    }
    return { ready: true, policyId };
  } catch (error) {
    return {
      ready: false,
      policyId,
      reason: `Required policy ${policyId} self-check threw: ${(error as Error).message}`,
    };
  }
}

export async function assertRequiredPolicyReady(basePath: string): Promise<void> {
  const status = await isRequiredPolicyReady(basePath);
  if (!status.ready) {
    throw new Error(status.reason ?? "Required policy is not ready");
  }
}

export function nativeVerdictFromPolicy(verdict: PolicyVerdict, malformed?: boolean): "pass" | "fail" | "inconclusive" {
  if (malformed) return "inconclusive";
  if (verdict === "pass") return "pass";
  if (verdict === "fail") return "fail";
  return "inconclusive";
}

function normalizePolicyResult(
  policy: RequiredPolicy,
  raw: PolicyVerificationResult | null | undefined,
): PolicyVerificationResult {
  if (!raw || typeof raw !== "object") {
    return {
      policy_id: policy.id,
      version: policy.version,
      verdict: "inconclusive",
      malformed: true,
      reason: "Required policy returned a malformed result",
      checks: [blockedCheck("Required policy returned a malformed result")],
      evidence: [],
    };
  }
  const verdict = raw.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive" && verdict !== "cancelled") {
    return {
      policy_id: policy.id,
      version: policy.version,
      verdict: "inconclusive",
      malformed: true,
      reason: "Required policy returned a malformed verdict",
      checks: Array.isArray(raw.checks) && raw.checks.length > 0
        ? raw.checks
        : [blockedCheck("Required policy returned a malformed verdict")],
      evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    };
  }
  return {
    policy_id: raw.policy_id || policy.id,
    version: raw.version || policy.version,
    verdict,
    ...(raw.reason ? { reason: raw.reason } : {}),
    ...(raw.malformed ? { malformed: true } : {}),
    checks: Array.isArray(raw.checks) ? raw.checks : [blockedCheck("Required policy omitted checks")],
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
  };
}

async function runPolicyPhase(
  policy: RequiredPolicy,
  context: RequiredPolicyContext,
): Promise<PolicyVerificationResult> {
  const method = context.phase === "plan" ? policy.validatePlan : policy.verifyTask;
  try {
    return normalizePolicyResult(policy, await method.call(policy, context));
  } catch (error) {
    const reason = `Required policy ${policy.id} threw: ${(error as Error).message}`;
    return {
      policy_id: policy.id,
      version: policy.version,
      verdict: "inconclusive",
      reason,
      checks: [blockedCheck(reason)],
      evidence: [],
    };
  }
}

/**
 * Compulsory policy evaluation for managed projects. Unmanaged projects
 * (no host-owned required-policy binding) skip this gate.
 */
export async function evaluateCompulsoryPolicy(
  basePath: string,
  options: {
    phase: RequiredPolicyPhase;
    abortSignal?: AbortSignal;
    task?: RequiredPolicyContext["task"];
  },
): Promise<CompulsoryPolicyEvaluation> {
  const policyId = getProjectRequiredPolicyId(basePath);
  if (!policyId) return { kind: "unmanaged" };

  const ready = await isRequiredPolicyReady(basePath);
  if (!ready.ready) {
    const reason = ready.reason ?? `Required policy ${policyId} is not ready`;
    return {
      kind: "blocked",
      reason,
      nativeVerdict: "inconclusive",
      policyId,
      checks: [blockedCheck(reason)],
    };
  }

  const policy = policies.get(policyId);
  if (!policy) {
    const reason = `Required policy ${policyId} is not registered`;
    return {
      kind: "blocked",
      reason,
      nativeVerdict: "inconclusive",
      policyId,
      checks: [blockedCheck(reason)],
    };
  }

  const result = await runPolicyPhase(
    policy,
    policyContext(basePath, options.phase, options.abortSignal, options.task),
  );
  const checks = result.checks.length > 0 ? result.checks : [blockedCheck(result.reason ?? "Required policy produced no checks")];
  if (result.malformed || result.verdict !== "pass") {
    if (checks.every((check) => check.exitCode === 0) && result.verdict !== "pass") {
      checks.push(blockedCheck(result.reason ?? `Required policy verdict ${result.verdict}`));
    }
  }
  return {
    kind: "evaluated",
    result,
    nativeVerdict: nativeVerdictFromPolicy(result.verdict, result.malformed),
    checks,
  };
}

export function compulsoryPolicyPassed(evaluation: CompulsoryPolicyEvaluation): boolean {
  if (evaluation.kind === "unmanaged") return true;
  if (evaluation.kind === "blocked") return false;
  return evaluation.nativeVerdict === "pass" && !evaluation.result.malformed;
}

export function applyCompulsoryPolicyToGate(input: {
  passed: boolean;
  checks: VerificationCheck[];
  evaluation: CompulsoryPolicyEvaluation;
}): { passed: boolean; checks: VerificationCheck[]; policyEvaluation: CompulsoryPolicyEvaluation } {
  if (input.evaluation.kind === "unmanaged") {
    return { passed: input.passed, checks: input.checks, policyEvaluation: input.evaluation };
  }
  const checks = [...input.checks, ...input.evaluation.checks];
  return {
    passed: input.passed && compulsoryPolicyPassed(input.evaluation),
    checks,
    policyEvaluation: input.evaluation,
  };
}
