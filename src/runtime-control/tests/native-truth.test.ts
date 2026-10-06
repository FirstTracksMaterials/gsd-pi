// Project/App: gsd-pi
// File Purpose: R3 native command truth: dispatch failure, review, and replan.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { admitCommand } from "../admission.ts";
import { admitAnswer, answerMatchesOwner, registerAnswerWorkerLookup, registerPendingQuestion, verdictForAnswerSession } from "../answers.ts";
import { NativeDispatchError, registerNativeAutoDispatchForTest, resetNativeAutoDispatchForTest } from "../native-auto-dispatch.ts";
import { registerNativeWorkflowOpsForTest, resetNativeWorkflowOpsForTest } from "../native-commands.ts";
import { configureEventHubForTest, readProjectJournal } from "../event-hub.ts";
import {
  createControl,
  resetC05,
  seedReadyProject,
  startRequest,
  tempProject,
  uuid,
} from "./harness.ts";

afterEach(() => {
  resetC05();
  resetNativeAutoDispatchForTest();
  resetNativeWorkflowOpsForTest();
  delete process.env.GSD_WEB_DAEMON_MODE;
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("a refused native dispatch does not stay running", async () => {
  const alpha = tempProject("dispatch-fail");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  process.env.GSD_WEB_DAEMON_MODE = "1";
  registerNativeAutoDispatchForTest(() => {
    throw new NativeDispatchError("bridge refused the prompt", false);
  });
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(81)));
  assert.equal(started.ok, true);
  await flush();
  const operationId = started.ok ? started.operation.operation_id : "";
  const stored = control.store.read(operationId);
  assert.equal(stored?.operation.state, "failed");
  assert.equal(stored?.operation.error?.code, "runtime_unavailable");
  assert.equal(control.lease.isHeld(), false);
});

test("a dispatch that already began side effects stays recovery_required", async () => {
  const alpha = tempProject("dispatch-began");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  process.env.GSD_WEB_DAEMON_MODE = "1";
  registerNativeAutoDispatchForTest(() => {
    throw new NativeDispatchError("prompt was sent and the response was lost", true);
  });
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(82)));
  assert.equal(started.ok, true);
  await flush();
  const operationId = started.ok ? started.operation.operation_id : "";
  const stored = control.store.read(operationId);
  assert.equal(stored?.operation.state, "recovery_required");
  assert.notEqual(stored?.operation.state, "succeeded");
  assert.equal(control.lease.current()?.recovery_required, true);
});

test("native bridge assistant and tool events enter the canonical project journal", async () => {
  configureEventHubForTest({ heartbeatMs: 0, coalesceMs: 0 });
  const alpha = tempProject("dispatch-events");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  process.env.GSD_WEB_DAEMON_MODE = "1";
  registerNativeAutoDispatchForTest((input) => {
    input.onEvent?.({
      type: "message_update",
      messageId: "message-1",
      assistantMessageEvent: { type: "text_delta", delta: "Working", contentIndex: 0 },
    });
    input.onEvent?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
    input.onEvent?.({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "ok", isError: false });
    input.onEvent?.({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusText: "working" });
  });

  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(89)));
  assert.equal(started.ok, true);
  await flush();

  const events = readProjectJournal(control, "alpha").readAfter(null).events;
  const projected = events.filter((event) => ["assistant_delta", "tool_started", "tool_finished"].includes(event.type));
  assert.deepEqual(projected.map((event) => event.type), ["assistant_delta", "tool_started", "tool_finished"]);
  assert.equal(projected[0]?.payload.text, "Working");
  assert.equal(projected[1]?.payload.tool, "read");
  assert.equal(projected[2]?.payload.ok, true);
  assert.equal(projected.every((event) => event.operation_id === (started.ok ? started.operation.operation_id : null)), true);
  assert.equal(events.some((event) => event.type === "input_required"), false);
});

test("review without a native workflow does not succeed with empty findings", async () => {
  const alpha = tempProject("review-absent");
  const marker = join(alpha, "src", "convert.py");
  mkdirSync(join(alpha, "src"), { recursive: true });
  writeFileSync(marker, "INCH_TO_MM = None\n");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const reviewed = await admitCommand(control, "alpha:M001", command("review", uuid(83)));
  assert.equal(reviewed.ok, true);
  if (reviewed.ok) {
    assert.equal(reviewed.operation.state, "failed");
    assert.match(reviewed.operation.error?.message ?? "", /not registered/);
  }
  assert.equal(control.store.read(reviewed.ok ? reviewed.operation.operation_id : "")?.operation.result?.findings, undefined);
});

test("unregistered replan does not succeed from evidence invalidation", async () => {
  const alpha = tempProject("replan-fail");
  mkdirSync(join(alpha, ".gsd"), { recursive: true });
  writeFileSync(join(alpha, ".gsd", "evidence"), "not-a-directory");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const before = control.jobs.require("alpha:M001").revision;
  const replanned = await admitCommand(control, "alpha:M001", command("replan", uuid(84), { reason: "scope" }));
  assert.equal(replanned.ok, true);
  if (replanned.ok) {
    assert.equal(replanned.operation.state, "failed");
    assert.match(replanned.operation.error?.message ?? "", /not registered/);
  }
  assert.equal(control.jobs.require("alpha:M001").revision, before);
});

test("review keeps the lease when the workflow started and cleanup is unknown", async () => {
  const alpha = tempProject("review-began");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeWorkflowOpsForTest({
    publishReviewFindings: async () => {
      await Promise.resolve();
      throw new NativeDispatchError("native review did not publish findings", true);
    },
  });
  const reviewed = await admitCommand(control, "alpha:M001", command("review", uuid(87)));
  assert.equal(reviewed.ok, true);
  if (reviewed.ok) assert.equal(reviewed.operation.state, "running");
  await flush();
  const operationId = reviewed.ok ? reviewed.operation.operation_id : "";
  assert.equal(control.store.read(operationId)?.operation.state, "recovery_required");
  assert.equal(control.lease.current()?.recovery_required, true);
});

test("review releases the lease when the workflow refuses before work starts", async () => {
  const alpha = tempProject("review-refused");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeWorkflowOpsForTest({
    publishReviewFindings: async () => {
      await Promise.resolve();
      throw new NativeDispatchError("native review workflow did not accept the review", false);
    },
  });
  const reviewed = await admitCommand(control, "alpha:M001", command("review", uuid(88)));
  assert.equal(reviewed.ok, true);
  if (reviewed.ok) assert.equal(reviewed.operation.state, "running");
  await flush();
  const operationId = reviewed.ok ? reviewed.operation.operation_id : "";
  assert.equal(control.store.read(operationId)?.operation.state, "failed");
  assert.equal(control.lease.isHeld(), false);
});

test("a daemon prefix alone does not authorise an answer", () => {
  const question = { question_id: "q-1", job_id: "alpha:M001", session_id: "daemon:other" };
  const rejected = answerMatchesOwner({
    question,
    jobId: "alpha:M001",
    operationJobId: "alpha:M001",
    activeQuestionId: "q-1",
  });
  assert.equal(rejected.ok, false);
  const accepted = answerMatchesOwner({
    question: { ...question, session_id: "daemon:alpha:M001" },
    jobId: "alpha:M001",
    operationJobId: "alpha:M001",
    activeQuestionId: "q-1",
  });
  assert.equal(accepted.ok, true);
  const otherQuestion = answerMatchesOwner({
    question: { ...question, question_id: "q-2", session_id: "daemon:alpha:M001" },
    jobId: "alpha:M001",
    operationJobId: "alpha:M001",
    activeQuestionId: "q-1",
  });
  assert.equal(otherQuestion.ok, false);
  const rejectedSession = verdictForAnswerSession("pi-session", "other-session");
  assert.equal(rejectedSession.ok, false);
});

test("an answer for another session is rejected while the lease is held", async () => {
  const alpha = tempProject("answer-session");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeAutoDispatchForTest(async () => undefined);
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(85)));
  assert.equal(started.ok, true);
  registerAnswerWorkerLookup(() => ({ ok: false, reason: "answer session does not match the owning worker" }));
  registerPendingQuestion({
    question_id: "q-1",
    job_id: "alpha:M001",
    session_id: "other-session",
  });
  registerNativeWorkflowOpsForTest(null);
  const answered = await admitAnswer(control, "alpha:M001", {
    question_id: "q-1",
    request_id: uuid(86),
    expected_revision: 1,
    expected_epoch: 1,
    response: "yes",
  });
  assert.equal(answered.ok, false);
  if (!answered.ok) assert.match(answered.body.error.message, /session/);
  assert.equal(control.lease.isHeld(), true);
});

test("a daemon prefix from another owner is not an answer for the active question", async () => {
  const alpha = tempProject("answer-owner");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeAutoDispatchForTest(async () => undefined);
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(89)));
  assert.equal(started.ok, true);
  registerPendingQuestion({
    question_id: "q-1",
    job_id: "alpha:M001",
    session_id: "daemon:other-job",
  });
  const wrongOwner = await admitAnswer(control, "alpha:M001", {
    question_id: "q-1",
    request_id: uuid(90),
    expected_revision: 1,
    expected_epoch: 1,
    response: "yes",
  });
  assert.equal(wrongOwner.ok, false);
  if (!wrongOwner.ok) assert.match(wrongOwner.body.error.message, /owning/);
  registerPendingQuestion({
    question_id: "q-2",
    job_id: "alpha:M001",
    session_id: "daemon:alpha:M001",
  });
  const wrongQuestion = await admitAnswer(control, "alpha:M001", {
    question_id: "q-2",
    request_id: uuid(91),
    expected_revision: 1,
    expected_epoch: 1,
    response: "yes",
  });
  assert.equal(wrongQuestion.ok, false);
  if (!wrongQuestion.ok) assert.match(wrongQuestion.body.error.message, /active question/);
  assert.equal(control.lease.isHeld(), true);
});
