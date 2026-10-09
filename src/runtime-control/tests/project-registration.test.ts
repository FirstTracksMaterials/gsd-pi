import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { POST as registerProject } from "../../../web/app/api/runtime/v1/projects/route.ts";
import { createControl, tempProject } from "./harness.ts";

function descriptor(projectId: string, target: string): Record<string, unknown> {
  return {
    version: 1,
    project_id: projectId,
    source_repo: target,
    target_worktree: target,
    required_policy: "ftm-science/v1",
    contract_root: ".gsd/ftm/contracts",
    reference_repositories: [],
    writable_cache_roots: [],
  };
}

test("explicit trusted project registration is durable and idempotent", async () => {
  const existing = tempProject("registration-existing");
  const target = tempProject("registration-new");
  mkdirSync(join(target, ".git"), { recursive: true });
  mkdirSync(join(target, ".gsd", "ftm", "contracts"), { recursive: true });
  const { control } = createControl({ projects: [{ project_id: "existing", target: existing }] });
  const body = descriptor("quake-smoke", target);

  const first = await registerProject(new Request("http://127.0.0.1/api/runtime/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal(first.status, 201);
  assert.equal((await first.json() as { idempotent: boolean }).idempotent, false);
  assert.equal(control.registration.getById("quake-smoke")?.target_realpath, target);

  const retry = await registerProject(new Request("http://127.0.0.1/api/runtime/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { idempotent: boolean }).idempotent, true);
});

test("project registration rejects untrusted targets and policy changes", async () => {
  const existing = tempProject("registration-guard-existing");
  createControl({ projects: [{ project_id: "existing", target: existing }] });
  const outside = descriptor("outside", "/home/untrusted/project");
  const untrusted = await registerProject(new Request("http://127.0.0.1/api/runtime/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(outside),
  }));
  assert.equal(untrusted.status, 400);

  const target = tempProject("registration-policy");
  mkdirSync(join(target, ".git"), { recursive: true });
  mkdirSync(join(target, ".gsd", "ftm", "contracts"), { recursive: true });
  const wrongPolicy = { ...descriptor("wrong-policy", target), required_policy: "optional/v1" };
  const rejected = await registerProject(new Request("http://127.0.0.1/api/runtime/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(wrongPolicy),
  }));
  assert.equal(rejected.status, 400);
});
