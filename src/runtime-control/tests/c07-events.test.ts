// Project/App: gsd-pi
// File Purpose: C07 snapshot/SSE/history acceptance. No live model.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { GET as jobGet } from "../../../web/app/api/runtime/v1/jobs/[job_id]/route.ts";
import { GET as historyGet } from "../../../web/app/api/runtime/v1/jobs/[job_id]/history/route.ts";
import { GET as importGet } from "../../../web/app/api/runtime/v1/projects/[project_id]/jobs/route.ts";
import { GET as eventsGet } from "../../../web/app/api/runtime/v1/projects/[project_id]/events/route.ts";
import { POST as commandsPost } from "../../../web/app/api/runtime/v1/jobs/[job_id]/commands/route.ts";
import { registerPendingQuestion } from "../answers.ts";
import { attachSameWorker } from "../deep-links.ts";
import {
  configureEventHubForTest,
  cursorSemantics,
  ingestNativeEvent,
  ingestVerifiedMilestone,
  subscribeProjectEvents,
} from "../event-hub.ts";
import { readJobHistory } from "../history.ts";
import { modelCallCount } from "../model-calls.ts";
import { patchObservation } from "../observation.ts";
import { registerNativeSnapshotReaderForTest, reconcileBufferedEvents } from "../snapshots.ts";
import { registerCommandHandlerForTest } from "../command-handlers.ts";
import { createControl, resetC05, seedReadyProject, startRequest, tempProject, uuid } from "./harness.ts";
import type { NativeObservationInput } from "../snapshots.ts";
import type { RuntimeEvent } from "../types.ts";

afterEach(() => {
  resetC05();
});

function dbNative(overrides: Partial<NativeObservationInput> = {}): NativeObservationInput {
  return {
    readMetadata: { source: "database", authority: "db-authoritative" },
    phase: "prepared",
    tasks_completed: 0,
    tasks_total: 1,
    blockers: [],
    verified_complete: false,
    duration_ms: null,
    log_ref: null,
    ...overrides,
  };
}

async function collectSse(response: Response, count: number, ms = 1000): Promise<RuntimeEvent[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: RuntimeEvent[] = [];
  const deadline = Date.now() + ms;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice(6)) as RuntimeEvent);
    }
  }
  await reader.cancel();
  return events;
}

test("AT-E01: events replay in order with duplicate-safe IDs; deltas do not bump revision", async () => {
  configureEventHubForTest({ heartbeatMs: 0, coalesceMs: 0 });
  const alpha = tempProject("e01");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  const job = seedReadyProject(control, "alpha", alpha);
  const before = job.revision;
  const first = ingestNativeEvent(control, {
    type: "assistant_delta",
    project_id: "alpha",
    job_id: job.job_id,
    message_id: "msg-1",
    attempt_id: "attempt-1",
    text: "Hel",
    offset: 0,
  });
  assert.ok(first);
  const duplicate = ingestNativeEvent(control, {
    type: "assistant_delta",
    project_id: "alpha",
    job_id: job.job_id,
    message_id: "msg-1",
    attempt_id: "attempt-1",
    text: "Hel",
    offset: 0,
  });
  assert.equal(duplicate, null);
  const next = ingestNativeEvent(control, {
    type: "assistant_delta",
    project_id: "alpha",
    job_id: job.job_id,
    message_id: "msg-1",
    attempt_id: "attempt-1",
    text: "lo",
    offset: 3,
  });
  assert.ok(next);
  const conflict = ingestNativeEvent(control, {
    type: "assistant_delta",
    project_id: "alpha",
    job_id: job.job_id,
    message_id: "msg-1",
    attempt_id: "attempt-1",
    text: "XYZ",
    offset: 0,
  });
  assert.equal(conflict?.type, "snapshot_invalidated");
  const final = ingestNativeEvent(control, {
    type: "assistant_message",
    project_id: "alpha",
    job_id: job.job_id,
    message_id: "msg-1",
    attempt_id: "attempt-1",
    payload: { text: "Hello" },
  });
  assert.ok(final);
  assert.equal(final.message_id, "msg-1");
  assert.equal(control.jobs.require(job.job_id).revision, before);
  const replayed: RuntimeEvent[] = [];
  const stop = subscribeProjectEvents(control, "alpha", first.cursor, (frame) => {
    if (frame.kind === "event") replayed.push(frame.event);
  });
  stop();
  assert.ok(replayed.every((event, index) => index === 0 || event.sequence > replayed[index - 1]!.sequence));
  assert.equal(replayed.some((event) => event.event_id === first.event_id), false);
  assert.match(cursorSemantics(), /epochN:sequenceM/);
});

test("AT-E02: missing cursor gives stream_gap then snapshot+history recovery", async () => {
  configureEventHubForTest({ heartbeatMs: 0, coalesceMs: 0 });
  const alpha = tempProject("e02");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  ingestNativeEvent(control, {
    type: "assistant_message",
    project_id: "alpha",
    job_id: "alpha:M001",
    message_id: "kept",
    payload: { text: "kept" },
  });
  const response = await eventsGet(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/events?after=epoch1:sequence999"),
    { params: { project_id: "alpha" } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
  const events = await collectSse(response, 1);
  assert.equal(events[0]?.type, "stream_gap");
  assert.equal(events[0]?.job_id, null);
  assert.equal(events[0]?.payload.recovery, "snapshot_and_history");
  const history = readJobHistory(control, "alpha:M001", { cursor: "epoch1:sequence999", limit: 100 });
  assert.equal(history.gap, true);
  assert.equal(history.records[0]?.message_id, "kept");
  const snapshot = await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(snapshot.status, 200);
});

test("AT-E03: authoritative reads make no inference; projection fallback cannot claim verification", async () => {
  const alpha = tempProject("e03");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, required_policy: "ftm-science/v1" }],
    readyPolicy: false,
  });
  seedReadyProject(control, "alpha", alpha);
  control.lease.acquire({
    operation_id: uuid(40),
    job_id: "alpha:M001",
    action: "start",
    acquired_at: "2026-09-20T00:00:00Z",
    recovery_required: false,
  });
  registerNativeSnapshotReaderForTest(async () => ({
    ...dbNative({
      readMetadata: { source: "projection", authority: "projection-fallback" },
      phase: "complete",
      verified_complete: true,
      scientific_status: "SIGNED_OFF",
    }),
  }));
  const beforeCalls = modelCallCount();
  const list = await importGet(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/jobs"),
    { params: { project_id: "alpha" } },
  );
  const detail = await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  );
  const history = await historyGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001/history"),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(history.status, 200);
  const body = await detail.json() as { state: string; scientific_status: string; read_metadata: { authority: string } };
  assert.notEqual(body.state, "completed");
  assert.notEqual(body.scientific_status, "SIGNED_OFF");
  assert.equal(body.read_metadata.authority, "projection-fallback");
  assert.equal(modelCallCount(), beforeCalls);
  assert.equal(control.lease.isHeld(), true);
});

test("AT-E04: agent_end is not milestone completion; old-attempt terminals do not override current state", async () => {
  configureEventHubForTest({ heartbeatMs: 0, coalesceMs: 0 });
  const alpha = tempProject("e04");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeSnapshotReaderForTest(async () => dbNative({ phase: "executing" }));
  patchObservation("alpha:M001", { attempt_id: "attempt-new", run_id: "run-2" });
  ingestNativeEvent(control, { type: "agent_end", project_id: "alpha", job_id: "alpha:M001", attempt_id: "attempt-new" });
  ingestNativeEvent(control, { type: "execution_complete", project_id: "alpha", job_id: "alpha:M001", attempt_id: "attempt-new" });
  ingestNativeEvent(control, {
    type: "job_updated",
    project_id: "alpha",
    job_id: "alpha:M001",
    attempt_id: "attempt-old",
    payload: { source: "execution_complete", run_complete: true, state: "completed" },
  });
  let snapshot = await (await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  )).json() as { state: string; attempt_id: string | null };
  assert.notEqual(snapshot.state, "completed");
  assert.equal(snapshot.attempt_id, "attempt-new");
  ingestVerifiedMilestone(control, {
    project_id: "alpha",
    job_id: "alpha:M001",
    attempt_id: "attempt-new",
    run_id: "run-2",
    revision: 1,
    authority_epoch: 1,
  });
  snapshot = await (await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  )).json() as { state: string; attempt_id: string | null };
  assert.equal(snapshot.state, "completed");
});

test("AT-E05: input UI shares worker; two clients do not create two workers/runs", async () => {
  configureEventHubForTest({ heartbeatMs: 0, coalesceMs: 0 });
  const alpha = tempProject("e05");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerPendingQuestion({
    question_id: "q1",
    job_id: "alpha:M001",
    session_id: "sess-shared",
    title: "Choose path",
    summary: "Need a choice",
    method: "select",
  });
  const first = attachSameWorker(alpha, "sess-shared");
  const second = attachSameWorker(alpha, "sess-shared");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.key, second.key);
  const snapshot = await (await jobGet(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001"),
    { params: { job_id: "alpha%3AM001" } },
  )).json() as { state: string; pending_input: { url: string; session_id: string } | null };
  assert.equal(snapshot.state, "waiting_for_input");
  assert.ok(snapshot.pending_input);
  assert.equal(snapshot.pending_input.session_id, "sess-shared");
  assert.ok(snapshot.pending_input.url.includes("session=sess-shared"));
  assert.ok(snapshot.pending_input.url.includes("project="));
  const sseA = await eventsGet(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/events"),
    { params: { project_id: "alpha" } },
  );
  const sseB = await eventsGet(
    new Request("http://127.0.0.1/api/runtime/v1/projects/alpha/events"),
    { params: { project_id: "alpha" } },
  );
  assert.equal(sseA.status, 200);
  assert.equal(sseB.status, 200);
  await sseA.body?.cancel();
  await sseB.body?.cancel();
  registerCommandHandlerForTest(() => ({ holdLease: true }));
  const startA = await commandsPost(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startRequest(uuid(50))),
    }),
    { params: { job_id: "alpha%3AM001" } },
  );
  const startB = await commandsPost(
    new Request("http://127.0.0.1/api/runtime/v1/jobs/alpha%3AM001/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startRequest(uuid(51))),
    }),
    { params: { job_id: "alpha%3AM001" } },
  );
  assert.equal(startA.status, 202);
  assert.equal(startB.status, 409);
  const busy = await startB.json() as { error: { code: string } };
  assert.equal(busy.error.code, "model_busy");
});

test("buffered stream handoff drops stale-epoch events even with a larger revision", () => {
  const kept = reconcileBufferedEvents(
    { authority_epoch: 2, revision: 4 },
    [
      { type: "job_updated", authority_epoch: 1, revision: 99, attempt_id: "a", message_id: null },
      { type: "job_updated", authority_epoch: 2, revision: 4, attempt_id: "a", message_id: null },
      { type: "assistant_delta", authority_epoch: 2, revision: 4, attempt_id: "old", message_id: "m1" },
    ],
    "a",
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.authority_epoch, 2);
});
