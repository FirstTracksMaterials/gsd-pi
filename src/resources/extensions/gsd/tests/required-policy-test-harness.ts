// Project/App: gsd-pi
// File Purpose: Explicit test-only required policy. Never auto-selected in production.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HostCheckResult } from "../host-check-runner.js";
import {
  registerRequiredPolicyForTest,
  type PolicyVerificationResult,
  type RequiredPolicy,
  type RequiredPolicyContext,
} from "../required-policy.js";
import type { VerificationCheck } from "../types.js";

export const TEST_REQUIRED_POLICY_ID = "test-policy/v1";
export const TEST_REQUIRED_POLICY_FIXTURE = ".gsd/test-policy.json";

export interface TestRequiredPolicyFixture {
  selfCheckReady?: boolean;
  selfCheckThrow?: string;
  verdict?: "pass" | "fail" | "inconclusive" | "cancelled";
  malformed?: boolean;
  omitResult?: boolean;
  throw?: string;
  argv?: string[];
  shellCommand?: string;
  timeoutMs?: number;
  sleepMs?: number;
}

export function testPolicyFixturePath(basePath: string): string {
  return join(basePath, TEST_REQUIRED_POLICY_FIXTURE);
}

export function writeTestRequiredPolicyFixture(basePath: string, fixture: TestRequiredPolicyFixture): void {
  const path = testPolicyFixturePath(basePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture), "utf-8");
}

function loadFixture(basePath: string): TestRequiredPolicyFixture {
  try {
    const raw = JSON.parse(readFileSync(testPolicyFixturePath(basePath), "utf-8"));
    return raw && typeof raw === "object" ? raw as TestRequiredPolicyFixture : {};
  } catch {
    return {};
  }
}

function checkFromHost(command: string, host: HostCheckResult): VerificationCheck {
  return {
    command,
    exitCode: host.exitCode,
    stdout: host.stdout,
    stderr: host.stderr,
    durationMs: host.durationMs,
    ...(host.failureClass ? { failureClass: host.failureClass } : {}),
    ...(host.durableOutputRef ? { durableOutputRef: host.durableOutputRef } : {}),
  };
}

function resultFromFixture(
  context: RequiredPolicyContext,
  fixture: TestRequiredPolicyFixture,
  checks: VerificationCheck[],
): PolicyVerificationResult {
  if (fixture.omitResult) {
    return undefined as unknown as PolicyVerificationResult;
  }
  if (fixture.malformed) {
    return { notAVerdict: true } as unknown as PolicyVerificationResult;
  }
  const verdict = fixture.verdict ?? (checks.every((check) => check.exitCode === 0) ? "pass" : "fail");
  return {
    policy_id: TEST_REQUIRED_POLICY_ID,
    version: "1",
    verdict,
    checks,
    evidence: [{ fixture }],
  };
}

async function runConfiguredCheck(context: RequiredPolicyContext): Promise<VerificationCheck[]> {
  const fixture = loadFixture(context.basePath);
  if (fixture.sleepMs && fixture.sleepMs > 0) {
    const host = await context.runHostCheck({
      cwd: context.basePath,
      timeoutMs: fixture.timeoutMs ?? Math.max(fixture.sleepMs * 4, 1_000),
      argv: ["node", "-e", `setTimeout(() => {}, ${Math.floor(fixture.sleepMs)})`],
      abortSignal: context.abortSignal,
    });
    return [checkFromHost(`node-sleep-${fixture.sleepMs}`, host)];
  }
  if (fixture.argv?.length) {
    const host = await context.runHostCheck({
      cwd: context.basePath,
      timeoutMs: fixture.timeoutMs ?? 5_000,
      argv: fixture.argv,
      abortSignal: context.abortSignal,
    });
    return [checkFromHost(fixture.argv.join(" "), host)];
  }
  if (fixture.shellCommand) {
    const host = await context.runHostCheck({
      cwd: context.basePath,
      timeoutMs: fixture.timeoutMs ?? 5_000,
      shellCommand: fixture.shellCommand,
      abortSignal: context.abortSignal,
    });
    return [checkFromHost(fixture.shellCommand, host)];
  }
  if (fixture.verdict === "fail") {
    return [{
      command: "test-policy",
      exitCode: 1,
      stdout: "",
      stderr: "test policy configured to fail",
      durationMs: 0,
    }];
  }
  if (fixture.verdict === "cancelled") {
    return [{
      command: "test-policy",
      exitCode: 1,
      stdout: "",
      stderr: "cancelled",
      durationMs: 0,
      failureClass: "cancelled",
    }];
  }
  if (fixture.verdict === "inconclusive") {
    return [{
      command: "test-policy",
      exitCode: 1,
      stdout: "",
      stderr: "inconclusive",
      durationMs: 0,
    }];
  }
  return [{
    command: "test-policy",
    exitCode: 0,
    stdout: "pass",
    stderr: "",
    durationMs: 0,
  }];
}

export function createTestRequiredPolicy(overrides?: Partial<RequiredPolicy>): RequiredPolicy {
  const policy: RequiredPolicy = {
    id: TEST_REQUIRED_POLICY_ID,
    version: "1",
    async selfCheck(context) {
      const fixture = loadFixture(context.basePath);
      if (fixture.selfCheckThrow) throw new Error(fixture.selfCheckThrow);
      if (fixture.selfCheckReady === false) {
        return { ready: false, reason: "test policy self-check not ready" };
      }
      return { ready: true };
    },
    async validatePlan(context) {
      return runVerify(context);
    },
    async verifyTask(context) {
      return runVerify(context);
    },
    async admission() {
      return { allowed: true };
    },
    async workspace() {
      return { allowed: true };
    },
    ...overrides,
  };
  return policy;
}

async function runVerify(context: RequiredPolicyContext): Promise<PolicyVerificationResult> {
  const fixture = loadFixture(context.basePath);
  if (fixture.throw) throw new Error(fixture.throw);
  const checks = fixture.malformed || fixture.omitResult ? [] : await runConfiguredCheck(context);
  return resultFromFixture(context, fixture, checks);
}

export function installTestRequiredPolicy(basePath: string, fixture?: TestRequiredPolicyFixture): RequiredPolicy {
  const policy = createTestRequiredPolicy();
  registerRequiredPolicyForTest(policy);
  if (fixture) writeTestRequiredPolicyFixture(basePath, fixture);
  return policy;
}
