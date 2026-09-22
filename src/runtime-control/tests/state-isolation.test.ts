// Project/App: gsd-pi
// File Purpose: A replacement state root cannot see retired operations, and the retired root still blocks.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { admitCommand } from "../admission.ts";
import { registerNativeAutoDispatchForTest, resetNativeAutoDispatchForTest } from "../native-auto-dispatch.ts";
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

const FALSE_SUCCESS = "79648da8-2723-4bd1-b8e2-b52e0f4a6887";
const FALSE_CANCEL = "9e119cc2-63ab-4ec8-842b-8fe1fe042d3e";
const STALE_RUNNING = "fba0f3be-9338-48df-beec-ecd96091f054";

afterEach(() => {
  resetC05();
  resetNativeAutoDispatchForTest();
});

function writeStored(stateRoot: string, stored: { operation: { operation_id: string } }) {
  const dir = join(stateRoot, "runtime-control", "operations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stored.operation.operation_id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
}

test("a fresh state root cannot dispatch retired operations and the retired root still blocks", async () => {
  const retired = tempState();
  const fresh = tempState();
  const target = tempProject("isolation");
  mkdirSync(join(retired, "runtime-control"), { recursive: true });
  mkdirSync(join(fresh, "runtime-control"), { recursive: true });
  writeFileSync(join(retired, "runtime-control", "lease.json"), "{\"lease\": null}\n");
  writeFileSync(join(fresh, "runtime-control", "lease.json"), "{\"lease\": null}\n");
  writeStored(retired, {
    operation: {
      protocol_version: 1,
      operation_id: FALSE_SUCCESS,
      request_id: "8a084347-f3a8-47d6-a9c1-0b24d4859aee",
      job_id: "alpha:M001",
      action: "start",
      state: "cancelled",
      admitted_at: "2026-09-21T21:56:01Z",
      updated_at: "2026-09-21T21:57:39Z",
      result: { kind: "start", milestoneLock: "M001", scoped: true },
      error: null,
      target_operation_id: null,
    },
    fingerprint: "retired-start",
    kind: "job-command",
    dispatch_intent: true,
  });
  writeStored(retired, {
    operation: {
      protocol_version: 1,
      operation_id: FALSE_CANCEL,
      request_id: "2a499e0a-16eb-4fc2-9531-3953bbf21f38",
      job_id: "alpha:M001",
      action: "cancel",
      state: "succeeded",
      admitted_at: "2026-09-21T21:57:32Z",
      updated_at: "2026-09-21T21:57:39Z",
      result: { kind: "cancel", target_operation_id: FALSE_SUCCESS, cancelled: true },
      error: null,
      target_operation_id: FALSE_SUCCESS,
    },
    fingerprint: "retired-cancel",
    kind: "job-command",
    dispatch_intent: false,
  });
  writeStored(retired, {
    operation: {
      protocol_version: 1,
      operation_id: STALE_RUNNING,
      request_id: "3ba6ea68-b408-4a93-9c90-1f77ea5cb0e2",
      job_id: "alpha:M001",
      action: "start",
      state: "running",
      admitted_at: "2026-09-21T21:57:47Z",
      updated_at: "2026-09-21T21:57:47Z",
      result: { kind: "start", milestoneLock: "M001", scoped: true },
      error: null,
      target_operation_id: null,
    },
    fingerprint: "retired-running",
    kind: "job-command",
    dispatch_intent: true,
  });

  const projects = [{ project_id: "alpha", target }];
  let dispatches = 0;
  registerNativeAutoDispatchForTest(() => {
    dispatches += 1;
  });
  const replacement = createControl({ projects, stateRoot: fresh });
  seedReadyProject(replacement.control, "alpha", target);
  assert.equal(replacement.control.store.read(FALSE_SUCCESS) ?? null, null);
  assert.equal(replacement.control.store.read(STALE_RUNNING) ?? null, null);
  const started = await admitCommand(replacement.control, "alpha:M001", startRequest(uuid(70)));
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.notEqual(started.operation.operation_id, FALSE_SUCCESS);
    assert.notEqual(started.operation.operation_id, STALE_RUNNING);
  }
  assert.equal(dispatches, 1);

  const reopened = reopenControl(retired, projects);
  seedReadyProject(reopened, "alpha", target);
  const blocked = await admitCommand(reopened, "alpha:M001", startRequest(uuid(71)));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.match(blocked.body.error.message, new RegExp(`${FALSE_SUCCESS}|${STALE_RUNNING}`));
  }
  assert.equal(dispatches, 1);
  assert.equal(reopened.store.read(FALSE_SUCCESS)?.operation.state, "cancelled");
  assert.notEqual(reopened.store.read(STALE_RUNNING)?.operation.state, "succeeded");
});
