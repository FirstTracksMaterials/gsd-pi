// Project/App: gsd-pi
// File Purpose: R2 cancel receipts, false-success admission, and restart durability.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { admitCommand } from "../admission.ts";
import { abortOwnedWorker, lookupProjectBridgeServiceForCwd } from "../../web/bridge-service.ts";
import { registerCancelNativeOpsForTest } from "../cancel.ts";
import { RuntimeControl } from "../control.ts";
import { registerIdleProbeForTest } from "../idle-probe.ts";
import { registerNativeAutoDispatchForTest, resetNativeAutoDispatchForTest } from "../native-auto-dispatch.ts";
import {
  appendReconciliationDecision,
  findUnreconciledFalseSuccesses,
  readReconciliationDecision,
  reconciliationPath,
} from "../reconciliation.ts";
import { acceptWorkerCleanup, missingWorkerCleanup } from "../worker-cleanup.ts";
import { installTestRequiredPolicy } from "../../resources/extensions/gsd/tests/required-policy-test-harness.ts";
import {
  createControl,
  reopenControl,
  resetC05,
  seedReadyProject,
  startRequest,
  tempProject,
  tempState,
  uuid,
} from "./harness.ts";

const HISTORICAL_OPERATION = "3ef0e645-ebca-4f7a-a87f-574676ab766d";
const HISTORICAL_CANCEL = "108746d8-f530-4012-b53d-c11150432a0c";

afterEach(() => {
  resetC05();
});

function command(action: string, requestId: string, parameters: Record<string, unknown> = {}) {
  return {
    protocol_version: 1 as const,
    request_id: requestId,
    expected_revision: 1,
    expected_epoch: 1,
    action,
    parameters,
  };
}

test("cleanup receipts reject a stale generation, session, or missing acknowledgement", () => {
  const expected = {
    operationId: HISTORICAL_OPERATION,
    jobId: "c15-conversion:M001",
    sessionId: "session-1",
    generation: 4,
  };
  const acknowledged = {
    cleaned: true,
    dispatch_quiesced: true,
    request_closed: true,
    tools_drained: true,
    operation_id: HISTORICAL_OPERATION,
    job_id: "c15-conversion:M001",
    session_id: "session-1",
    worker_generation: 4,
    reason: null,
  };
  assert.equal(acceptWorkerCleanup(expected, acknowledged, 4).ok, true);
  assert.equal(acceptWorkerCleanup(expected, { ...acknowledged, worker_generation: 3 }, 4).reason, "stale worker generation");
  assert.equal(acceptWorkerCleanup(expected, acknowledged, 5).reason, "stale worker generation");
  assert.equal(acceptWorkerCleanup(expected, { ...acknowledged, session_id: "other" }, 4).reason, "stale session acknowledgement");
  assert.equal(acceptWorkerCleanup(expected, missingWorkerCleanup("abort response lost"), 4).ok, false);
});

test("an abort lookup does not create a worker", async () => {
  const cwd = tempProject("missing-worker");
  const evidence = await abortOwnedWorker(cwd, { operationId: "op", jobId: "alpha:M001" });
  assert.equal(evidence.cleaned, false);
  assert.match(evidence.reason ?? "", /did not create/);
  assert.equal(lookupProjectBridgeServiceForCwd(cwd), null);
});

test("cancel without a cleanup acknowledgement keeps the lease even when the probe is idle", async () => {
  const alpha = tempProject("no-ack");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(80)));
  assert.equal(started.ok, true);
  const cancel = await admitCommand(control, "alpha:M001", command("cancel", uuid(81)));
  assert.equal(cancel.ok, true);
  if (cancel.ok) assert.equal(cancel.operation.state, "recovery_required");
  assert.equal(control.lease.isHeld(), true);
});

test("failed policy still admits cancel and still blocks the next start", async () => {
  const alpha = tempProject("policy-cancel");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCancelNativeOpsForTest({
    stopAuto: async () => undefined,
    abortTools: async () => ({ cleaned: true }),
  });
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(82)));
  assert.equal(started.ok, true);
  installTestRequiredPolicy(alpha, { selfCheckReady: false });
  const cancel = await admitCommand(control, "alpha:M001", command("cancel", uuid(83)));
  assert.equal(cancel.ok, true);
  if (cancel.ok) {
    assert.equal(cancel.operation.state, "succeeded");
    assert.equal(cancel.operation.result?.scientific_status, undefined);
  }
  const again = await admitCommand(control, "alpha:M001", startRequest(uuid(84)));
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.body.error.code, "policy_unavailable");
});

test("a cancel for another job does not touch the owner", async () => {
  const alpha = tempProject("job-a");
  const beta = tempProject("job-b");
  const { control } = createControl({
    projects: [
      { project_id: "alpha", target: alpha },
      { project_id: "beta", target: beta },
    ],
  });
  seedReadyProject(control, "alpha", alpha);
  seedReadyProject(control, "beta", beta);
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(85)));
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const before = JSON.stringify(control.store.read(started.operation.operation_id));
  const cancel = await admitCommand(control, "beta:M001", command("cancel", uuid(86)));
  assert.equal(cancel.ok, false);
  assert.equal(JSON.stringify(control.store.read(started.operation.operation_id)), before);
  assert.equal(control.lease.current()?.job_id, "alpha:M001");
});

test("the cancelled historical operation blocks admission across restart until reconciliation", async () => {
  const alpha = tempProject("historical");
  const stateRoot = tempState();
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha }],
    stateRoot,
  });
  seedReadyProject(control, "alpha", alpha);
  const operation = {
    operation: {
      protocol_version: 1,
      operation_id: HISTORICAL_OPERATION,
      request_id: "ae1bd736-cd9e-4295-bff8-afb2758483b3",
      job_id: "alpha:M001",
      action: "start",
      state: "cancelled",
      admitted_at: "2026-09-21T22:09:49Z",
      updated_at: "2026-09-22T00:09:58Z",
      result: { kind: "start", milestoneLock: "M001", scoped: true },
      error: null,
      target_operation_id: null,
    },
    fingerprint: "historical-start",
    kind: "job-command",
    dispatch_intent: false,
  };
  const cancel = {
    operation: {
      protocol_version: 1,
      operation_id: HISTORICAL_CANCEL,
      request_id: "59e0ad5e-58a7-4330-a5bb-9e38e44d4fed",
      job_id: "alpha:M001",
      action: "cancel",
      state: "succeeded",
      admitted_at: "2026-09-22T00:09:58Z",
      updated_at: "2026-09-22T00:09:58Z",
      result: {
        kind: "cancel",
        target_operation_id: HISTORICAL_OPERATION,
        cancelled: true,
      },
      error: null,
      target_operation_id: HISTORICAL_OPERATION,
    },
    fingerprint: "historical-cancel",
    kind: "job-command",
    dispatch_intent: false,
  };
  const operationsDir = join(stateRoot, "runtime-control", "operations");
  mkdirSync(operationsDir, { recursive: true });
  const operationPath = join(operationsDir, `${HISTORICAL_OPERATION}.json`);
  const cancelPath = join(operationsDir, `${HISTORICAL_CANCEL}.json`);
  writeFileSync(operationPath, `${JSON.stringify(operation, null, 2)}\n`);
  writeFileSync(cancelPath, `${JSON.stringify(cancel, null, 2)}\n`);
  const leasePath = join(stateRoot, "runtime-control", "lease.json");
  writeFileSync(leasePath, "{\"lease\": null}\n");
  const before = readFileSync(operationPath, "utf8");

  const blocked = await admitCommand(control, "alpha:M001", startRequest(uuid(87)));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.body.error.message, new RegExp(HISTORICAL_OPERATION));
  assert.equal(control.lease.isHeld(), false);

  const reopened = reopenControl(stateRoot, [{ project_id: "alpha", target: alpha }]);
  seedReadyProject(reopened, "alpha", alpha);
  const stillBlocked = await admitCommand(reopened, "alpha:M001", startRequest(uuid(88)));
  assert.equal(stillBlocked.ok, false);
  assert.equal(readFileSync(operationPath, "utf8"), before);
  assert.equal(readFileSync(leasePath, "utf8"), "{\"lease\": null}\n");
  assert.equal(reopened.store.read(HISTORICAL_OPERATION)?.backend_binding ?? null, null);

  appendReconciliationDecision(stateRoot, {
    operation_id: HISTORICAL_OPERATION,
    cancel_operation_id: HISTORICAL_CANCEL,
    job_id: "alpha:M001",
    decision: "reconciled",
    provenance: "r0-worker-shutdown",
    worker_cleanup: {
      cgroup: "absent",
      signal: "SIGKILL",
      descendants_gone: true,
      pids_gone: [357000, 357119, 358923],
      source: "c16-recovery/R0/stop-result.json",
    },
    backend_observations: {
      coding_slots: { is_processing: false, id_task: 1, n_ctx: 131072 },
      ha_slots: { is_processing: false, id_task: 2, n_ctx: 4096 },
    },
    binding_assigned: false,
    decided_at: "2026-09-22T18:00:00Z",
  });
  const released = reopenControl(stateRoot, [{ project_id: "alpha", target: alpha }]);
  seedReadyProject(released, "alpha", alpha);
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const started = await admitCommand(released, "alpha:M001", startRequest(uuid(89)));
  assert.equal(started.ok, true);
  assert.equal(readFileSync(operationPath, "utf8"), before);
  assert.equal(released.store.read(HISTORICAL_OPERATION)?.backend_binding ?? null, null);
  assert.notEqual(released.store.read(started.ok ? started.operation.operation_id : "")?.backend_binding ?? null, null);
});

const OLDER_OPERATION = "79648da8-2723-4bd1-b8e2-b52e0f4a6887";
const OLDER_CANCEL = "9e119cc2-63ab-4ec8-842b-8fe1fe042d3e";
const STALE_RUNNING = "fba0f3be-9338-48df-beec-ecd96091f054";

function writeStored(stateRoot: string, stored: Record<string, unknown> & { operation: { operation_id: string } }) {
  const operationsDir = join(stateRoot, "runtime-control", "operations");
  mkdirSync(operationsDir, { recursive: true });
  writeFileSync(join(operationsDir, `${stored.operation.operation_id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
}

function storedStart(operationId: string, requestId: string, state: string, dispatchIntent: boolean) {
  return {
    operation: {
      protocol_version: 1,
      operation_id: operationId,
      request_id: requestId,
      job_id: "alpha:M001",
      action: "start",
      state,
      admitted_at: "2026-09-21T21:56:01Z",
      updated_at: "2026-09-21T21:57:47Z",
      result: { kind: "start", milestoneLock: "M001", scoped: true },
      error: null,
      target_operation_id: null,
    },
    fingerprint: `start-${operationId}`,
    kind: "job-command",
    dispatch_intent: dispatchIntent,
  };
}

function storedCancel(operationId: string, requestId: string, targetId: string) {
  return {
    operation: {
      protocol_version: 1,
      operation_id: operationId,
      request_id: requestId,
      job_id: "alpha:M001",
      action: "cancel",
      state: "succeeded",
      admitted_at: "2026-09-21T21:57:32Z",
      updated_at: "2026-09-21T21:57:39Z",
      result: { kind: "cancel", target_operation_id: targetId, cancelled: true },
      error: null,
      target_operation_id: targetId,
    },
    fingerprint: `cancel-${operationId}`,
    kind: "job-command",
    dispatch_intent: false,
  };
}

function validDecision(operationId: string, cancelId: string) {
  return {
    operation_id: operationId,
    cancel_operation_id: cancelId,
    job_id: "alpha:M001",
    decision: "reconciled" as const,
    provenance: "r0-worker-shutdown" as const,
    worker_cleanup: {
      cgroup: "absent" as const,
      signal: "SIGKILL" as const,
      descendants_gone: true as const,
      pids_gone: [357000],
      source: "c16-recovery/R0/stop-result.json",
    },
    backend_observations: {
      coding_slots: { is_processing: false, n_ctx: 131072 },
      ha_slots: { is_processing: false, n_ctx: 4096 },
    },
    binding_assigned: false as const,
    decided_at: "2026-09-22T19:54:52Z",
  };
}

test("an empty, malformed, or wrong-operation reconciliation does not clear the obligation", async () => {
  const alpha = tempProject("reconcile-fail-closed");
  const stateRoot = tempState();
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha }],
    stateRoot,
  });
  seedReadyProject(control, "alpha", alpha);
  writeStored(stateRoot, storedStart(OLDER_OPERATION, "8a084347-f3a8-47d6-a9c1-0b24d4859aee", "cancelled", true));
  writeStored(stateRoot, storedCancel(OLDER_CANCEL, "2a499e0a-16eb-4fc2-9531-3953bbf21f38", OLDER_OPERATION));
  writeFileSync(join(stateRoot, "runtime-control", "lease.json"), "{\"lease\": null}\n");
  const bodies = [
    "",
    "{",
    "{}",
    JSON.stringify({ ...validDecision(HISTORICAL_OPERATION, HISTORICAL_CANCEL) }),
    JSON.stringify({
      ...validDecision(OLDER_OPERATION, OLDER_CANCEL),
      backend_observations: { coding_slots: {}, ha_slots: { is_processing: false, n_ctx: 4096 } },
    }),
    JSON.stringify({ ...validDecision(OLDER_OPERATION, HISTORICAL_CANCEL) }),
  ];
  for (const body of bodies) {
    mkdirSync(join(stateRoot, "runtime-control", "reconciliation"), { recursive: true });
    writeFileSync(reconciliationPath(stateRoot, OLDER_OPERATION), body);
    const reopened = reopenControl(stateRoot, [{ project_id: "alpha", target: alpha }]);
    seedReadyProject(reopened, "alpha", alpha);
    const parsed = readReconciliationDecision(stateRoot, OLDER_OPERATION);
    if (body.includes(HISTORICAL_CANCEL) && body.includes(OLDER_OPERATION)) {
      assert.equal(parsed?.cancel_operation_id, HISTORICAL_CANCEL);
    } else {
      assert.equal(parsed, null);
    }
    assert.deepEqual(
      findUnreconciledFalseSuccesses(reopened.store).map((item) => item.operation_id),
      [OLDER_OPERATION],
    );
    const blocked = await admitCommand(reopened, "alpha:M001", startRequest(uuid(90)));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.body.error.message, new RegExp(OLDER_OPERATION));
  }
  assert.throws(
    () => appendReconciliationDecision(stateRoot, {
      ...validDecision(OLDER_OPERATION, OLDER_CANCEL),
      binding_assigned: true as unknown as false,
    }),
    /required evidence/,
  );
});

test("startup reconciliation keeps unresolved ownership blocking and does not fabricate success", async () => {
  const alpha = tempProject("startup-copy");
  const stateRoot = tempState();
  mkdirSync(join(stateRoot, "runtime-control"), { recursive: true });
  const historical = storedStart(HISTORICAL_OPERATION, "ae1bd736-cd9e-4295-bff8-afb2758483b3", "cancelled", true);
  const historicalCancel = storedCancel(HISTORICAL_CANCEL, "59e0ad5e-58a7-4330-a5bb-9e38e44d4fed", HISTORICAL_OPERATION);
  const older = storedStart(OLDER_OPERATION, "8a084347-f3a8-47d6-a9c1-0b24d4859aee", "cancelled", true);
  const olderCancel = storedCancel(OLDER_CANCEL, "2a499e0a-16eb-4fc2-9531-3953bbf21f38", OLDER_OPERATION);
  const running = storedStart(STALE_RUNNING, "3ba6ea68-b408-4a93-9c90-1f77ea5cb0e2", "running", true);
  writeStored(stateRoot, historical);
  writeStored(stateRoot, historicalCancel);
  writeStored(stateRoot, older);
  writeStored(stateRoot, olderCancel);
  writeStored(stateRoot, running);
  writeFileSync(join(stateRoot, "runtime-control", "lease.json"), "{\"lease\": null}\n");
  appendReconciliationDecision(stateRoot, validDecision(HISTORICAL_OPERATION, HISTORICAL_CANCEL));
  const historicalBytes = readFileSync(join(stateRoot, "runtime-control", "operations", `${HISTORICAL_OPERATION}.json`), "utf8");
  const decisionBytes = readFileSync(reconciliationPath(stateRoot, HISTORICAL_OPERATION), "utf8");
  const runningBytes = readFileSync(join(stateRoot, "runtime-control", "operations", `${STALE_RUNNING}.json`), "utf8");
  let dispatches = 0;
  registerNativeAutoDispatchForTest(() => {
    dispatches += 1;
  });
  try {
    const { control } = createControl({
      projects: [{ project_id: "alpha", target: alpha }],
      stateRoot,
    });
    seedReadyProject(control, "alpha", alpha);
    const recovered = control.store.read(STALE_RUNNING);
    assert.equal(recovered?.operation.state, "recovery_required");
    assert.match(recovered?.operation.error?.message ?? "", /not replayed/);
    assert.notEqual(recovered?.operation.state, "succeeded");
    assert.equal(recovered?.backend_binding ?? null, null);
    assert.equal(readFileSync(join(stateRoot, "runtime-control", "operations", `${HISTORICAL_OPERATION}.json`), "utf8"), historicalBytes);
    assert.equal(readFileSync(reconciliationPath(stateRoot, HISTORICAL_OPERATION), "utf8"), decisionBytes);
    assert.notEqual(readFileSync(join(stateRoot, "runtime-control", "operations", `${STALE_RUNNING}.json`), "utf8"), runningBytes);
    assert.equal(readReconciliationDecision(stateRoot, HISTORICAL_OPERATION)?.operation_id, HISTORICAL_OPERATION);
    const blocked = await admitCommand(control, "alpha:M001", startRequest(uuid(91)));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.body.error.message, new RegExp(OLDER_OPERATION));
    assert.equal(dispatches, 0);

    const reopened = reopenControl(stateRoot, [{ project_id: "alpha", target: alpha }]);
    seedReadyProject(reopened, "alpha", alpha);
    assert.equal(readFileSync(reconciliationPath(stateRoot, HISTORICAL_OPERATION), "utf8"), decisionBytes);
    assert.equal(reopened.store.read(HISTORICAL_OPERATION)?.operation.state, "cancelled");
    assert.equal(reopened.store.read(STALE_RUNNING)?.operation.state, "recovery_required");
    const stillBlocked = await admitCommand(reopened, "alpha:M001", startRequest(uuid(92)));
    assert.equal(stillBlocked.ok, false);
    assert.equal(dispatches, 0);
  } finally {
    resetNativeAutoDispatchForTest();
  }
});

test("an interrupted running operation blocks a new start when the lease is empty", async () => {
  const alpha = tempProject("stale-running");
  const stateRoot = tempState();
  mkdirSync(join(stateRoot, "runtime-control"), { recursive: true });
  writeStored(stateRoot, storedStart(HISTORICAL_OPERATION, "ae1bd736-cd9e-4295-bff8-afb2758483b3", "cancelled", true));
  writeStored(stateRoot, storedCancel(HISTORICAL_CANCEL, "59e0ad5e-58a7-4330-a5bb-9e38e44d4fed", HISTORICAL_OPERATION));
  writeStored(stateRoot, storedStart(STALE_RUNNING, "3ba6ea68-b408-4a93-9c90-1f77ea5cb0e2", "running", true));
  writeFileSync(join(stateRoot, "runtime-control", "lease.json"), "{\"lease\": null}\n");
  appendReconciliationDecision(stateRoot, validDecision(HISTORICAL_OPERATION, HISTORICAL_CANCEL));
  const decisionBytes = readFileSync(reconciliationPath(stateRoot, HISTORICAL_OPERATION), "utf8");
  let dispatches = 0;
  registerNativeAutoDispatchForTest(() => {
    dispatches += 1;
  });
  try {
    const { control } = createControl({
      projects: [{ project_id: "alpha", target: alpha }],
      stateRoot,
    });
    seedReadyProject(control, "alpha", alpha);
    const recovered = control.store.read(STALE_RUNNING);
    assert.equal(recovered?.operation.state, "recovery_required");
    assert.notEqual(recovered?.operation.state, "succeeded");
    assert.equal(recovered?.backend_binding ?? null, null);
    const blocked = await admitCommand(control, "alpha:M001", startRequest(uuid(93)));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.body.error.message, new RegExp(STALE_RUNNING));
    assert.equal(dispatches, 0);
    const reopened = reopenControl(stateRoot, [{ project_id: "alpha", target: alpha }]);
    seedReadyProject(reopened, "alpha", alpha);
    assert.equal(readFileSync(reconciliationPath(stateRoot, HISTORICAL_OPERATION), "utf8"), decisionBytes);
    assert.equal(readReconciliationDecision(stateRoot, HISTORICAL_OPERATION)?.operation_id, HISTORICAL_OPERATION);
    const stillBlocked = await admitCommand(reopened, "alpha:M001", startRequest(uuid(94)));
    assert.equal(stillBlocked.ok, false);
    if (!stillBlocked.ok) assert.match(stillBlocked.body.error.message, new RegExp(STALE_RUNNING));
    assert.equal(reopened.store.read(STALE_RUNNING)?.operation.state, "recovery_required");
    assert.equal(dispatches, 0);
  } finally {
    resetNativeAutoDispatchForTest();
  }
});

test("a corrupt lease survives restart and does not become empty", () => {
  const alpha = tempProject("corrupt-lease");
  const stateRoot = tempState();
  mkdirSync(join(stateRoot, "runtime-control"), { recursive: true });
  const leasePath = join(stateRoot, "runtime-control", "lease.json");
  writeFileSync(leasePath, "{");
  assert.throws(
    () => createControl({ projects: [{ project_id: "alpha", target: alpha }], stateRoot }),
    /unreadable/,
  );
  assert.equal(readFileSync(leasePath, "utf8"), "{");
  assert.throws(
    () => new RuntimeControl({ stateRoot, loadEnv: false }),
    /unreadable/,
  );
  assert.equal(readFileSync(leasePath, "utf8"), "{");
});
