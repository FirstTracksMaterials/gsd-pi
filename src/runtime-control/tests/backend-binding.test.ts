// Project/App: gsd-pi
// File Purpose: R1 backend binding admission, idle ownership, and lease durability.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { admitCommand, getOperationByRequest } from "../admission.ts";
import { sealBackendBinding } from "../backend-binding.ts";
import { registerCancelNativeOpsForTest } from "../cancel.ts";
import { RuntimeControl } from "../control.ts";
import { registerIdleProbeForTest } from "../idle-probe.ts";
import { ModelLease } from "../model-lease.ts";
import { issueRecoveryId } from "../recovery.ts";
import {
  createControl,
  resetC05,
  seedReadyProject,
  startRequest,
  tempProject,
  tempState,
  testBackendBinding,
  uuid,
} from "./harness.ts";

afterEach(() => {
  resetC05();
});

test("model-producing admission persists the binding and leaves the runtime-v1 operation unchanged", async () => {
  const alpha = tempProject("bind");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const admitted = await admitCommand(control, "alpha:M001", startRequest(uuid(70)));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(admitted.operation.protocol_version, 1);
  assert.equal("backend_binding" in admitted.operation, false);
  const stored = control.store.read(admitted.operation.operation_id);
  const binding = control.registration.getById("alpha")?.backend_binding;
  assert.ok(stored?.backend_binding);
  assert.equal(stored?.backend_binding?.digest, binding?.digest);
  assert.equal(control.lease.current()?.backend_binding?.digest, binding?.digest);
});

test("a project without a validated binding cannot admit model work", async () => {
  const alpha = tempProject("unbound-admit");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_binding: null }],
  });
  seedReadyProject(control, "alpha", alpha);
  const admitted = await admitCommand(control, "alpha:M001", startRequest(uuid(71)));
  assert.equal(admitted.ok, false);
  if (!admitted.ok) {
    assert.equal(admitted.body.error.code, "runtime_unavailable");
    assert.match(admitted.body.error.message, /no validated backend binding/);
  }
  assert.equal(control.lease.isHeld(), false);
});

test("a registration probe that disagrees with the binding is rejected", () => {
  const alpha = tempProject("mismatch");
  const binding = testBackendBinding("http://127.0.0.1:9/slots");
  const stateRoot = tempState();
  assert.throws(
    () => RuntimeControl.createForTest({
      stateRoot,
      registration: {
        projects: [{
          project_id: "alpha",
          target_worktree: alpha,
          contract_root: ".gsd/ftm/contracts",
          reference_repositories: [],
          writable_cache_roots: [],
          required_policy: "test-policy/v1",
          backend_binding: binding,
          backend_idle_probe: "http://127.0.0.1:8/slots",
        }],
      },
    }),
    /does not match the backend binding/,
  );
});

test("changing the binding while a lease is held is rejected and the receipt is not rewritten", async () => {
  const alpha = tempProject("held");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const admitted = await admitCommand(control, "alpha:M001", startRequest(uuid(72)));
  assert.equal(admitted.ok, true);
  const original = control.registration.getById("alpha")?.backend_binding;
  assert.ok(original);
  const replacement = sealBackendBinding({
    ...original,
    model_id: "other-model",
  });
  const project = control.registration.getById("alpha");
  assert.ok(project);
  assert.throws(
    () => control.registration.loadFromObject({
      projects: [{
        project_id: project.project_id,
        target_worktree: project.target_worktree,
        contract_root: ".gsd/ftm/contracts",
        reference_repositories: [],
        writable_cache_roots: [],
        required_policy: project.required_policy,
        backend_binding: replacement,
        backend_idle_probe: replacement.slot_probe_url,
      }],
    }),
    /binding change refused/,
  );
  assert.equal(control.registration.getById("alpha")?.backend_binding?.digest, original.digest);
  if (admitted.ok) {
    assert.equal(control.store.read(admitted.operation.operation_id)?.backend_binding?.digest, original.digest);
  }
});

test("startup rejects a different binding while a lease is held", () => {
  const alpha = tempProject("startup-held");
  const stateRoot = tempState();
  const first = testBackendBinding();
  const second = sealBackendBinding({ ...first, model_id: "replaced" });
  const registration = (binding: typeof first) => ({
    projects: [{
      project_id: "alpha",
      target_worktree: alpha,
      contract_root: ".gsd/ftm/contracts",
      reference_repositories: [],
      writable_cache_roots: [],
      required_policy: "test-policy/v1",
      backend_binding: binding,
      backend_idle_probe: binding.slot_probe_url,
    }],
  });
  const control = RuntimeControl.createForTest({ stateRoot, registration: registration(first) });
  control.lease.acquire({
    operation_id: "held-op",
    job_id: "alpha:M001",
    action: "start",
    acquired_at: "2026-09-21T00:00:00Z",
    recovery_required: false,
    backend_binding: first,
  });
  assert.throws(
    () => RuntimeControl.createForTest({ stateRoot, registration: registration(second) }),
    /binding change refused/,
  );
  const reread = new ModelLease(stateRoot);
  assert.equal(reread.current()?.backend_binding?.digest, first.digest);
});

test("an unreadable lease is unknown ownership and is not deleted or replaced", () => {
  const alpha = tempProject("corrupt-lease");
  const stateRoot = mkdtempSync(join(tmpdir(), "gsd-r1-lease-"));
  const leaseDir = join(stateRoot, "runtime-control");
  mkdirSync(leaseDir, { recursive: true });
  const leasePath = join(leaseDir, "lease.json");
  writeFileSync(leasePath, "{", "utf8");
  const lease = new ModelLease(stateRoot);
  assert.equal(lease.ownershipUnknown(), true);
  assert.equal(lease.isHeld(), false);
  assert.throws(() => lease.acquire({
    operation_id: "new",
    job_id: null,
    action: "start",
    acquired_at: "2026-09-21T00:00:00Z",
    recovery_required: false,
  }));
  assert.equal(readFileSync(leasePath, "utf8"), "{");
  const binding = testBackendBinding();
  assert.throws(
    () => RuntimeControl.createForTest({
      stateRoot,
      registration: {
        projects: [{
          project_id: "alpha",
          target_worktree: alpha,
          contract_root: ".gsd/ftm/contracts",
          reference_repositories: [],
          writable_cache_roots: [],
          required_policy: "test-policy/v1",
          backend_binding: binding,
          backend_idle_probe: binding.slot_probe_url,
        }],
      },
    }),
    /previous ownership is unknown/,
  );
  assert.equal(readFileSync(leasePath, "utf8"), "{");
});

test("a pre-binding receipt stays recovery_required even when the current probe is idle", async () => {
  const alpha = tempProject("pre-binding");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1:9/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "legacy-op",
      request_id: uuid(901),
      job_id: "alpha:M001",
      action: "start",
      state: "recovery_required",
      admitted_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
      result: null,
      error: null,
      target_operation_id: null,
    },
    fingerprint: "legacy",
    kind: "job-command",
    dispatch_intent: false,
  });
  control.lease.acquire({
    operation_id: "legacy-op",
    job_id: "alpha:M001",
    action: "start",
    acquired_at: "2026-09-21T00:00:00Z",
    recovery_required: true,
  });
  const recovery = issueRecoveryId({
    operation_id: "legacy-op",
    job_id: "alpha:M001",
    reason: "predates backend binding",
    issued_at: "2026-09-21T00:00:01Z",
    next_state: "recovery_required",
  });
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const recovered = await admitCommand(control, "alpha:M001", {
    protocol_version: 1,
    request_id: uuid(73),
    expected_revision: 1,
    expected_epoch: 1,
    action: "recover",
    parameters: { recovery_id: recovery.recovery_id },
  });
  assert.equal(recovered.ok, true);
  const stored = getOperationByRequest(control, uuid(73));
  assert.equal(stored.ok, true);
  if (stored.ok) assert.equal(stored.operation.state, "recovery_required");
  assert.equal(control.lease.isHeld(), true);
  assert.equal(control.store.read("legacy-op")?.operation.state, "recovery_required");
  assert.equal(control.store.read("legacy-op")?.backend_binding ?? null, null);
});

test("cancel probes the operation binding and ignores another idle server", async () => {
  const alpha = tempProject("two-servers");
  const bound = testBackendBinding("http://127.0.0.1:9/bound/slots");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_binding: bound }],
  });
  seedReadyProject(control, "alpha", alpha);
  const seen: string[] = [];
  registerIdleProbeForTest(async (url) => {
    seen.push(url);
    if (url.includes("unrelated")) return { idle: true, source: "slots" };
    return { idle: false, source: "slots", reason: "A backend slot is still processing" };
  });
  registerCancelNativeOpsForTest({
    stopAuto: async () => undefined,
    abortTools: async () => ({ cleaned: true }),
  });
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(74)));
  assert.equal(started.ok, true);
  const cancel = await admitCommand(control, "alpha:M001", {
    protocol_version: 1,
    request_id: uuid(75),
    expected_revision: 1,
    expected_epoch: 1,
    action: "cancel",
    parameters: {},
  });
  assert.equal(cancel.ok, true);
  const cancelStored = getOperationByRequest(control, uuid(75));
  assert.equal(cancelStored.ok, true);
  if (cancelStored.ok) assert.equal(cancelStored.operation.state, "recovery_required");
  assert.equal(control.lease.isHeld(), true);
  assert.deepEqual(seen, [bound.slot_probe_url]);
});
