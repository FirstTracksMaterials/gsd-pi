// Project/App: gsd-pi
// File Purpose: AT-S08 publication binding: stale source and missing policy receipts cannot publish.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.js";
import { createHostCheckLogDir, runHostCheck } from "../host-check-runner.js";
import {
  configureProjectRequiredPolicy,
  resetRequiredPolicyRegistryForTest,
} from "../required-policy.js";
import { publishVerifiedTaskCompletion, stageTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { claimTaskAttempt } from "../task-execution-domain-operation.js";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";
import {
  installTestRequiredPolicy,
  TEST_REQUIRED_POLICY_ID,
} from "./required-policy-test-harness.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool" as const,
    actorType: "agent" as const,
    actorId: "required-policy-publication-test",
    traceId: key,
    turnId: "turn-required-policy-publication",
  };
}

function createFixture(): { basePath: string; attemptId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-required-policy-pub-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, "tracked.txt"), "verified\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Required policy publication",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage completion** `est:30m`",
    "  - Do: Keep legacy status open until host verification",
    "  - Verify: npm test",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Required policy publication', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Publication seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, verify, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Stage completion', 'in_progress', 'npm test', 1
    );
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-1', 'turn-dispatch-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("required-policy-pub/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return { basePath, attemptId: claim.attemptId };
}

async function stage(basePath: string): Promise<void> {
  await stageTaskCompletion({
    invocation: invocation("required-policy-pub/stage"),
    basePath,
    task: TASK,
    completion: {
      oneLiner: "Implemented the compatibility seam",
      narrative: "The executor produced a candidate result for host verification.",
      verification: "Agent reported npm test passed; host verification is still required.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["src/task.ts"],
      keyDecisions: ["Keep dependency unlock behind host verification."],
      blockerDiscovered: false,
      verificationEvidence: [{
        command: "npm test",
        exitCode: 0,
        verdict: "pass",
        durationMs: 25,
      }],
    },
  });
}

function recordHostVerdict(
  basePath: string,
  attemptId: string,
  environment: Record<string, string | boolean | number> = {},
): void {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: invocation(`pi:host-verification:${attemptId}`),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Host verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: basePath,
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test", ...environment },
    },
  });
}

afterEach(() => {
  resetRequiredPolicyRegistryForTest();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("AT-S08: source change after a policy pass blocks publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  installTestRequiredPolicy(basePath, { verdict: "pass" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  recordHostVerdict(basePath, attemptId, {
    requiredPolicyId: TEST_REQUIRED_POLICY_ID,
    requiredPolicyVersion: "1",
    requiredPolicyVerdict: "pass",
  });
  writeFileSync(join(basePath, "tracked.txt"), "mutated after pass\n");

  await assert.rejects(
    () => publishVerifiedTaskCompletion({
      invocation: invocation("required-policy-pub/publish"),
      basePath,
      task: TASK,
      attemptId,
    }),
    /source no longer matches|host verification evidence/i,
  );
});

test("AT-S08: runner logs after a pass do not block publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  installTestRequiredPolicy(basePath, { verdict: "pass" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  recordHostVerdict(basePath, attemptId, {
    requiredPolicyId: TEST_REQUIRED_POLICY_ID,
    requiredPolicyVersion: "1",
    requiredPolicyVerdict: "pass",
  });
  const logDir = createHostCheckLogDir(basePath);
  const host = await runHostCheck({
    cwd: basePath,
    timeoutMs: 3_000,
    logDir,
    shellCommand: "echo leftover-runner-log",
  });
  assert.equal(host.exitCode, 0, host.stderr);

  const published = await publishVerifiedTaskCompletion({
    invocation: invocation("required-policy-pub/publish"),
    basePath,
    task: TASK,
    attemptId,
  });
  assert.equal(published.status, "committed");
});

test("AT-S08: a pass recorded without the required policy cannot publish", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  installTestRequiredPolicy(basePath, { verdict: "pass" });
  configureProjectRequiredPolicy(basePath, TEST_REQUIRED_POLICY_ID);
  recordHostVerdict(basePath, attemptId);

  await assert.rejects(
    () => publishVerifiedTaskCompletion({
      invocation: invocation("required-policy-pub/publish-missing-policy"),
      basePath,
      task: TASK,
      attemptId,
    }),
    /required-policy pass/i,
  );
});

test("AT-S07: unmanaged publication still accepts a pass without policy receipts", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  recordHostVerdict(basePath, attemptId);
  const published = await publishVerifiedTaskCompletion({
    invocation: invocation("required-policy-pub/publish-unmanaged"),
    basePath,
    task: TASK,
    attemptId,
  });
  assert.equal(published.status, "committed");
});
