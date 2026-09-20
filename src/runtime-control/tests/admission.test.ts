// Project/App: gsd-pi
// File Purpose: AT-C01 admission, AT-C02 idempotency, AT-C03 crash windows.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { admitCommand, getOperationByRequest } from "../admission.ts";
import { registerCommandHandlerForTest } from "../command-handlers.ts";
import { fingerprintCommand } from "../fingerprint.ts";
import {
  createControl,
  reopenControl,
  resetC05,
  seedReadyProject,
  startRequest,
  tempProject,
  uuid,
} from "./harness.ts";

afterEach(() => {
  resetC05();
});

test("AT-C01: parallel starts across projects produce one admission", async () => {
  const alpha = tempProject("alpha");
  const beta = tempProject("beta");
  const { control } = createControl({
    projects: [
      { project_id: "alpha", target: alpha },
      { project_id: "beta", target: beta },
    ],
  });
  seedReadyProject(control, "alpha", alpha);
  seedReadyProject(control, "beta", beta);
  registerCommandHandlerForTest(() => ({ holdLease: true }));

  const [first, second] = await Promise.all([
    admitCommand(control, "alpha:M001", startRequest(uuid(1))),
    admitCommand(control, "beta:M001", startRequest(uuid(2))),
  ]);
  const statuses = [first, second].map((result) => result.ok ? result.status : result.status).sort();
  const admitted = [first, second].filter((result) => result.ok);
  const rejected = [first, second].filter((result) => !result.ok);
  assert.equal(admitted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(admitted[0]?.status, 202);
  assert.equal(rejected[0]?.status, 409);
  assert.equal(rejected[0] && !rejected[0].ok ? rejected[0].body.error.code : "", "model_busy");
  assert.deepEqual(statuses, [202, 409]);
});

test("AT-C01: cancel does not acquire the model lease", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const start = await admitCommand(control, "alpha:M001", startRequest(uuid(3)));
  assert.equal(start.ok, true);
  const cancel = await admitCommand(control, "alpha:M001", {
    protocol_version: 1,
    request_id: uuid(4),
    expected_revision: 1,
    expected_epoch: 1,
    action: "cancel",
    parameters: {},
  });
  assert.equal(cancel.ok, true);
  if (cancel.ok) {
    assert.equal(cancel.operation.action, "cancel");
    assert.equal(cancel.operation.target_operation_id, start.ok ? start.operation.operation_id : null);
    assert.notEqual(cancel.operation.state, "succeeded");
  }
});

test("AT-C02: duplicate request_id returns the same receipt after restart", async () => {
  const alpha = tempProject("alpha");
  const projects = [{ project_id: "alpha", target: alpha }];
  const { control, stateRoot } = createControl({ projects });
  seedReadyProject(control, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const request = startRequest(uuid(5));
  const first = await admitCommand(control, "alpha:M001", request);
  assert.equal(first.ok, true);

  const restarted = reopenControl(stateRoot, projects);
  seedReadyProject(restarted, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const retry = await admitCommand(restarted, "alpha:M001", request);
  assert.equal(retry.ok, true);
  if (first.ok && retry.ok) {
    assert.equal(retry.operation.operation_id, first.operation.operation_id);
    assert.equal(retry.operation.request_id, first.operation.request_id);
  }
});

test("AT-C02: same request_id with a different payload is request_id_conflict", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const requestId = uuid(6);
  const first = await admitCommand(control, "alpha:M001", startRequest(requestId));
  assert.equal(first.ok, true);
  const conflict = await admitCommand(control, "alpha:M001", {
    protocol_version: 1,
    request_id: requestId,
    expected_revision: 1,
    expected_epoch: 1,
    action: "cancel",
    parameters: {},
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "request_id_conflict");
  }
});

test("AT-C02: fingerprint is checked before stale revision rejection", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const request = startRequest(uuid(7), 1, 1);
  const first = await admitCommand(control, "alpha:M001", request);
  assert.equal(first.ok, true);
  control.seedJob({
    job_id: "alpha:M001",
    project_id: "alpha",
    milestone_id: "M001",
    revision: 9,
    authority_epoch: 1,
  });
  const retry = await admitCommand(control, "alpha:M001", request);
  assert.equal(retry.ok, true);
  if (first.ok && retry.ok) {
    assert.equal(retry.operation.operation_id, first.operation.operation_id);
  }
});

test("AT-C02: stale epoch with a larger revision is revision_conflict", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  control.seedJob({
    job_id: "alpha:M001",
    project_id: "alpha",
    milestone_id: "M001",
    revision: 5,
    authority_epoch: 2,
  });
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const result = await admitCommand(control, "alpha:M001", startRequest(uuid(8), 99, 1));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "revision_conflict");
  }
});

test("AT-C02: fingerprints include route kind so command/import IDs cannot collide", () => {
  const command = fingerprintCommand({
    kind: "job-command",
    job_id: "alpha:M001",
    request: startRequest(uuid(9)),
  });
  const imported = fingerprintCommand({
    kind: "import",
    job_id: "alpha:M001",
    request: startRequest(uuid(9)),
  });
  assert.notEqual(command, imported);
});

test("AT-C03: crash before receipt write leaves no durable operation", async () => {
  const alpha = tempProject("alpha");
  const projects = [{ project_id: "alpha", target: alpha }];
  const { control, stateRoot } = createControl({ projects });
  seedReadyProject(control, "alpha", alpha);
  let handlerCalls = 0;
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { holdLease: true };
  });
  control.setCrashHookForTest("before_receipt");
  const request = startRequest(uuid(14));
  const crashed = await admitCommand(control, "alpha:M001", request);
  assert.equal(crashed.ok, false);
  assert.equal(handlerCalls, 0);

  const restarted = reopenControl(stateRoot, projects);
  seedReadyProject(restarted, "alpha", alpha);
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { holdLease: true };
  });
  const lookedUp = getOperationByRequest(restarted, uuid(14));
  assert.equal(lookedUp.ok, false);
  const retry = await admitCommand(restarted, "alpha:M001", request);
  assert.equal(retry.ok, true);
  assert.equal(handlerCalls, 1);
});

test("AT-C03: crash after receipt and before index still reconciles the same receipt", async () => {
  const alpha = tempProject("alpha");
  const projects = [{ project_id: "alpha", target: alpha }];
  const { control, stateRoot } = createControl({ projects });
  seedReadyProject(control, "alpha", alpha);
  let handlerCalls = 0;
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { holdLease: true };
  });
  control.setCrashHookForTest("before_index");
  const request = startRequest(uuid(10));
  const crashed = await admitCommand(control, "alpha:M001", request);
  assert.equal(crashed.ok, false);
  assert.equal(handlerCalls, 0);

  const restarted = reopenControl(stateRoot, projects);
  seedReadyProject(restarted, "alpha", alpha);
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { holdLease: true };
  });
  const lookedUp = getOperationByRequest(restarted, uuid(10));
  assert.equal(lookedUp.ok, true);
  const retry = await admitCommand(restarted, "alpha:M001", request);
  assert.equal(retry.ok, true);
  if (lookedUp.ok && retry.ok) {
    assert.equal(retry.operation.operation_id, lookedUp.operation.operation_id);
    assert.equal(lookedUp.operation.state, "accepted");
  }
  assert.equal(handlerCalls, 0);
});

test("AT-C03: crash after dispatch intent becomes recovery_required and is not replayed", async () => {
  const alpha = tempProject("alpha");
  const projects = [{ project_id: "alpha", target: alpha }];
  const { control, stateRoot } = createControl({ projects });
  seedReadyProject(control, "alpha", alpha);
  let handlerCalls = 0;
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { dispatch: true, holdLease: true };
  });
  control.setCrashHookForTest("after_dispatch_intent");
  const request = startRequest(uuid(11));
  const crashed = await admitCommand(control, "alpha:M001", request);
  assert.equal(crashed.ok, false);
  assert.equal(handlerCalls, 1);

  const restarted = reopenControl(stateRoot, projects);
  seedReadyProject(restarted, "alpha", alpha);
  registerCommandHandlerForTest(() => {
    handlerCalls += 1;
    return { dispatch: true, holdLease: true };
  });
  const lookedUp = getOperationByRequest(restarted, uuid(11));
  assert.equal(lookedUp.ok, true);
  if (lookedUp.ok) {
    assert.equal(lookedUp.operation.state, "recovery_required");
    assert.equal(lookedUp.operation.error?.code, "recovery_required");
  }
  const retry = await admitCommand(restarted, "alpha:M001", request);
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.operation.state, "recovery_required");
  }
  assert.equal(handlerCalls, 1);
  assert.equal(restarted.lease.isHeld(), true);
});

test("production command handlers dispatch native start without treating prompt ACK as success", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const first = await admitCommand(control, "alpha:M001", startRequest(uuid(12)));
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.notEqual(first.operation.state, "succeeded");
  }
  const stored = getOperationByRequest(control, uuid(12));
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.operation.state, "running");
    assert.equal(stored.operation.result?.kind, "start");
    assert.equal(stored.operation.result?.milestoneLock, "M001");
    assert.equal(stored.operation.result?.scoped, true);
    assert.equal(stored.operation.error, null);
  }
  assert.equal(control.lease.isHeld(), true);
  assert.equal(process.env.GSD_MILESTONE_LOCK, "M001");
});

test("unregistered project cwd is rejected on runtime-v1 commands", async () => {
  const alpha = tempProject("alpha");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const result = await admitCommand(control, "other:M001", startRequest(uuid(13)));
  assert.equal(result.ok, false);
});
