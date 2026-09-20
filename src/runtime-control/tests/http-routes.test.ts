// Project/App: gsd-pi
// File Purpose: runtime-v1 HTTP route stubs and command admission wiring.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { GET as capabilitiesGet } from "../../../web/app/api/runtime/v1/capabilities/route.ts";
import { POST as commandsPost } from "../../../web/app/api/runtime/v1/jobs/[job_id]/commands/route.ts";
import { GET as jobGet } from "../../../web/app/api/runtime/v1/jobs/[job_id]/route.ts";
import { GET as importGet, POST as importPost } from "../../../web/app/api/runtime/v1/projects/[project_id]/jobs/route.ts";
import { GET as byRequestGet } from "../../../web/app/api/runtime/v1/operations/by-request/[request_id]/route.ts";
import { registerCommandHandlerForTest } from "../command-handlers.ts";
import { createControl, resetC05, seedReadyProject, startRequest, tempProject, uuid } from "./harness.ts";

afterEach(() => {
  resetC05();
});

test("C06/C07 runtime-v1 routes report not-ready instead of fake success", async () => {
  const importResponse = await importPost();
  assert.equal(importResponse.status, 503);
  const listResponse = await importGet();
  assert.equal(listResponse.status, 503);
  const snapshot = await jobGet();
  assert.equal(snapshot.status, 503);
  const importBody = await importResponse.json() as { error?: { code?: string } };
  assert.equal(importBody.error?.code, "runtime_unavailable");
});

test("POST commands returns 202 after durable admission", async () => {
  const alpha = tempProject("http");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const requestId = uuid(20);
  const response = await commandsPost(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startRequest(requestId)),
    }),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(response.status, 202);
  const operation = await response.json() as { operation_id: string; request_id: string; state: string };
  assert.equal(operation.request_id, requestId);
  assert.equal(operation.state, "accepted");

  const lookup = await byRequestGet(
    new Request(`http://127.0.0.1/api/runtime/v1/operations/by-request/${requestId}`),
    { params: { request_id: requestId } },
  );
  assert.equal(lookup.status, 200);
  const found = await lookup.json() as { operation_id: string };
  assert.equal(found.operation_id, operation.operation_id);
});

test("GET capabilities uses existing control registration", async () => {
  const alpha = tempProject("http-caps");
  createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  const response = await capabilitiesGet();
  assert.equal(response.status, 200);
  const body = await response.json() as { protocol: number; policy_ready: boolean };
  assert.equal(body.protocol, 1);
  assert.equal(body.policy_ready, false);
});
