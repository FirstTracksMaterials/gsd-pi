// Project/App: gsd-pi
// File Purpose: AT-S06/AT-S07 compulsory required-policy gate and unmanaged regressions.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyCompulsoryPolicyToGate,
  assertRequiredPolicyReady,
  configureProjectRequiredPolicy,
  evaluateCompulsoryPolicy,
  isRequiredPolicyReady,
  resetRequiredPolicyRegistryForTest,
} from "../required-policy.ts";
import { runVerificationGate } from "../verification-gate.ts";
import {
  TEST_REQUIRED_POLICY_ID,
  installTestRequiredPolicy,
  writeTestRequiredPolicyFixture,
} from "./required-policy-test-harness.ts";

afterEach(() => {
  resetRequiredPolicyRegistryForTest();
});

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "gsd-required-policy-"));
}

test("AT-S06: extensionsReady is not proof of required-policy readiness", async () => {
  const basePath = tempProject();
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const status = await isRequiredPolicyReady(basePath, { extensionsReady: true });
  assert.equal(status.ready, false);
  assert.match(status.reason ?? "", /not registered/);
  await assert.rejects(
    () => assertRequiredPolicyReady(basePath),
    /not registered/,
  );
});

test("AT-S06: missing self-check blocks dispatch and acceptance", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { selfCheckReady: false });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const status = await isRequiredPolicyReady(basePath, { extensionsReady: true });
  assert.equal(status.ready, false);
  const evaluation = await evaluateCompulsoryPolicy(basePath, { phase: "task" });
  assert.equal(evaluation.kind, "blocked");
  const combined = applyCompulsoryPolicyToGate({
    passed: true,
    checks: [{ command: "true", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }],
    evaluation,
  });
  assert.equal(combined.passed, false);
});

test("AT-S06: task-local true/echo cannot bypass a failed compulsory policy", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { verdict: "fail" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const ordinary = await runVerificationGate({
    cwd: basePath,
    preferenceCommands: ["true", "echo bypass"],
  });
  assert.equal(ordinary.passed, true);
  const evaluation = await evaluateCompulsoryPolicy(basePath, { phase: "task" });
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation,
  });
  assert.equal(combined.passed, false);
  assert.ok(combined.checks.some((check) => check.command === "true" && check.exitCode === 0));
  assert.ok(combined.checks.some((check) => check.exitCode !== 0));
});

test("AT-S07: empty discovery cannot skip a failed compulsory policy", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { verdict: "fail" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const ordinary = await runVerificationGate({ cwd: basePath });
  assert.equal(ordinary.passed, true);
  assert.equal(ordinary.checks.length, 0);
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation: await evaluateCompulsoryPolicy(basePath, { phase: "task" }),
  });
  assert.equal(combined.passed, false);
});

test("AT-S07: qualifying prose evidence cannot skip a failed compulsory policy", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { verdict: "fail" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const ordinary = await runVerificationGate({
    cwd: basePath,
    taskPlanVerify: "Planning artifacts exist and contain all required sections",
    preferenceCommands: ["node -e 'process.exit(9)'"],
    taskEvidence: [
      { command: "true", exitCode: 0, verdict: "pass", durationMs: 1 },
    ],
  });
  assert.equal(ordinary.passed, true);
  assert.equal(ordinary.discoverySource, "task-plan-prose");
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation: await evaluateCompulsoryPolicy(basePath, { phase: "task" }),
  });
  assert.equal(combined.passed, false);
});

test("AT-S07: unmanaged projects keep upstream empty-discovery pass", async () => {
  const basePath = tempProject();
  const ordinary = await runVerificationGate({ cwd: basePath });
  assert.equal(ordinary.passed, true);
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation: await evaluateCompulsoryPolicy(basePath, { phase: "task" }),
  });
  assert.equal(combined.passed, true);
  assert.equal(combined.policyEvaluation.kind, "unmanaged");
});

test("AT-S07: malformed policy output is non-pass", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { malformed: true });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const evaluation = await evaluateCompulsoryPolicy(basePath, { phase: "task" });
  assert.equal(evaluation.kind, "evaluated");
  if (evaluation.kind === "evaluated") {
    assert.equal(evaluation.result.malformed, true);
    assert.equal(evaluation.nativeVerdict, "inconclusive");
  }
  const combined = applyCompulsoryPolicyToGate({
    passed: true,
    checks: [],
    evaluation,
  });
  assert.equal(combined.passed, false);
});

test("AT-S07: omitted policy result is non-pass", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { omitResult: true });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const evaluation = await evaluateCompulsoryPolicy(basePath, { phase: "task" });
  assert.notEqual(evaluation.kind, "unmanaged");
  const combined = applyCompulsoryPolicyToGate({
    passed: true,
    checks: [{ command: "echo ok", exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 }],
    evaluation,
  });
  assert.equal(combined.passed, false);
});

test("AT-S07: cancelled compulsory policy is non-pass", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { verdict: "cancelled" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  const evaluation = await evaluateCompulsoryPolicy(basePath, { phase: "task" });
  assert.equal(evaluation.kind, "evaluated");
  if (evaluation.kind === "evaluated") {
    assert.equal(evaluation.result.verdict, "cancelled");
    assert.equal(evaluation.nativeVerdict, "inconclusive");
  }
  assert.equal(applyCompulsoryPolicyToGate({
    passed: true,
    checks: [],
    evaluation,
  }).passed, false);
});

test("AT-S07: task-plan-only true still cannot skip missing policy", async () => {
  const basePath = tempProject();
  writeFileSync(join(basePath, "package.json"), "{}\n");
  configureProjectRequiredPolicy(basePath, "ftm-science/v1");
  const ordinary = await runVerificationGate({
    cwd: basePath,
    taskPlanVerify: "true",
  });
  assert.equal(ordinary.passed, true);
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation: await evaluateCompulsoryPolicy(basePath, { phase: "task" }),
  });
  assert.equal(combined.passed, false);
});

test("passing compulsory policy AND ordinary checks can pass", async () => {
  const basePath = tempProject();
  installTestRequiredPolicy(basePath, { verdict: "pass" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  writeTestRequiredPolicyFixture(basePath, { verdict: "pass" });
  const ordinary = await runVerificationGate({
    cwd: basePath,
    preferenceCommands: ["echo ok"],
  });
  const combined = applyCompulsoryPolicyToGate({
    passed: ordinary.passed,
    checks: ordinary.checks,
    evaluation: await evaluateCompulsoryPolicy(basePath, { phase: "task" }),
  });
  assert.equal(combined.passed, true);
});
