// Project/App: gsd-pi
// File Purpose: runtime-v1 HTTP route stubs and command admission wiring.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";

import { GET as capabilitiesGet } from "../../../web/app/api/runtime/v1/capabilities/route.ts";
import { POST as commandsPost } from "../../../web/app/api/runtime/v1/jobs/[job_id]/commands/route.ts";
import { GET as jobGet } from "../../../web/app/api/runtime/v1/jobs/[job_id]/route.ts";
import { POST as answersPost } from "../../../web/app/api/runtime/v1/jobs/[job_id]/answers/route.ts";
import { GET as importGet, POST as importPost } from "../../../web/app/api/runtime/v1/projects/[project_id]/jobs/route.ts";
import { GET as byRequestGet } from "../../../web/app/api/runtime/v1/operations/by-request/[request_id]/route.ts";
import { registerCommandHandlerForTest } from "../command-handlers.ts";
import { registerPendingQuestion } from "../answers.ts";
import { createControl, resetC05, seedReadyProject, startRequest, tempProject, uuid } from "./harness.ts";

afterEach(() => {
  resetC05();
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

test("C07 runtime-v1 snapshot list and detail are read-only 200s", async () => {
  const alpha = tempProject("http-snap");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const listResponse = await importGet(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/jobs"),
    { params: { project_id: "alpha" } },
  );
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as { jobs: Array<{ job_id: string }>; revision: number };
  assert.equal(listBody.jobs[0]?.job_id, "alpha:M001");
  const snapshot = await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(snapshot.status, 200);
  const body = await snapshot.json() as { protocol_version: number; job_id: string; revision: number };
  assert.equal(body.protocol_version, 1);
  assert.equal(body.job_id, "alpha:M001");
});

test("POST import admits a JobImport and stays idempotent on the same digest", async () => {
  const alpha = tempProject("http-import");
  createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  const content = "# imported";
  const digest = sha256(`alpha:${content}`);
  const body = {
    protocol_version: 1,
    request_id: uuid(30),
    import_digest: digest,
    spec_id: null,
    title: "Imported milestone",
    source: { kind: "prompt", path: "spec.md", sha256: sha256("spec") },
    tasks: [],
    source_job_status: "queued",
    documents: [{ path: "notes.md", content, sha256: sha256(content) }],
  };
  const response = await importPost(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { project_id: "alpha" } },
  );
  assert.equal(response.status, 202);
  const operation = await response.json() as { action: string; state: string; result: { job_id: string; milestone_id: string } };
  assert.equal(operation.action, "import");
  assert.equal(operation.state, "succeeded");
  assert.equal(operation.result.job_id, "alpha:M001");

  const retry = await importPost(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, request_id: uuid(31) }),
    }),
    { params: { project_id: "alpha" } },
  );
  assert.equal(retry.status, 202);
  const retried = await retry.json() as { result: { job_id: string; idempotent?: boolean } };
  assert.equal(retried.result.job_id, "alpha:M001");
  assert.equal(retried.result.idempotent, true);
});

test("POST answers routes a pending question without a second lease", async () => {
  const alpha = tempProject("http-answer");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerPendingQuestion({ question_id: "q1", job_id: "alpha:M001", session_id: "sess-1" });
  const response = await answersPost(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question_id: "q1",
        request_id: uuid(32),
        expected_revision: 1,
        expected_epoch: 1,
        response: { choice: "yes" },
      }),
    }),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(response.status, 202);
  const operation = await response.json() as { action: string; state: string; result: { kind: string } };
  assert.equal(operation.action, "answer");
  assert.equal(operation.state, "succeeded");
  assert.equal(operation.result.kind, "answer");
  assert.equal(control.lease.isHeld(), false);
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
  const body = await response.json() as { protocol: number; policy_ready: boolean; features: Record<string, boolean> };
  assert.equal(body.protocol, 1);
  assert.equal(body.policy_ready, false);
  assert.equal(body.features.milestone_scope, true);
  assert.equal(body.features.readonly_references, true);
  assert.equal(body.features.project_snapshots, true);
});
