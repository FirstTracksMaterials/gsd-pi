// Project/App: gsd-pi
// File Purpose: AT-C04 all-entry-point policy/bind-failure guards. No live model.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { POST as sessionCommand } from "../../../web/app/api/session/command/route.ts";
import { POST as terminalSessions } from "../../../web/app/api/terminal/sessions/route.ts";
import { installTestRequiredPolicy } from "../../resources/extensions/gsd/tests/required-policy-test-harness.ts";
import { guardManagedEntry } from "../entry-guard.ts";
import { buildCapabilities, buildProjectList } from "../capabilities.ts";
import { createControl, resetC05, tempProject } from "./harness.ts";

afterEach(() => {
  resetC05();
});

function projectRequest(cwd: string, url: string, init?: RequestInit): Request {
  const target = new URL(url, "http://127.0.0.1");
  target.searchParams.set("project", cwd);
  return new Request(target, init);
}

test("AT-C04: missing required policy cannot start through a generic web prompt", async () => {
  const alpha = tempProject("prompt");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const direct = await guardManagedEntry(alpha, "prompt", control);
  assert.equal(direct.allow, false);
  if (!direct.allow) {
    assert.equal(direct.status, 503);
    assert.equal(direct.body.error.code, "policy_unavailable");
  }

  const response = await sessionCommand(
    projectRequest(alpha, "http://127.0.0.1/api/session/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", text: "start the job" }),
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, "policy_unavailable");
});

test("AT-C04: required extension bind failure blocks managed terminal gsd starts", async () => {
  const alpha = tempProject("term");
  createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const response = await terminalSessions(
    projectRequest(alpha, "http://127.0.0.1/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "gsd" }),
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, "policy_unavailable");
});

test("AT-C04: failed required-policy self-check blocks prompt and terminal", async () => {
  const alpha = tempProject("selfcheck");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha }],
    readyPolicy: false,
  });
  installTestRequiredPolicy(alpha, { selfCheckReady: false });
  const prompt = await guardManagedEntry(alpha, "prompt", control);
  const terminal = await guardManagedEntry(alpha, "terminal", control);
  assert.equal(prompt.allow, false);
  assert.equal(terminal.allow, false);
});

test("AT-C04: read-only snapshots skip the model lease and do not require policy", async () => {
  const alpha = tempProject("ro");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const result = await guardManagedEntry(alpha, "readonly", control);
  assert.equal(result.allow, true);
});

test("AT-C04: unregistered cwd remains general-purpose GSD", async () => {
  const registered = tempProject("reg");
  const other = tempProject("other");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: registered, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const result = await guardManagedEntry(other, "prompt", control);
  assert.equal(result.allow, true);
});

test("GET capabilities and projects make no model calls and report honest feature flags", async () => {
  const alpha = tempProject("caps");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const capabilities = await buildCapabilities(control.registration) as {
    protocol: number;
    policy_ready: boolean;
    features: Record<string, boolean>;
  };
  assert.equal(capabilities.protocol, 1);
  assert.equal(capabilities.policy_ready, false);
  assert.equal(capabilities.features.durable_operations, true);
  assert.equal(capabilities.features.single_model_admission, true);
  assert.equal(capabilities.features.required_policy_gate, true);
  assert.equal(capabilities.features.cancellable_verification, true);
  assert.equal(capabilities.features.milestone_scope, true);
  assert.equal(capabilities.features.project_snapshots, true);
  assert.equal(capabilities.features.event_history, true);
  assert.equal(capabilities.features.readonly_references, true);
  const projects = await buildProjectList(control.registration);
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0]?.policy_ready, false);
});
