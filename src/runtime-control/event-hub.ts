// Project/App: gsd-pi
// File Purpose: Project event hub: journal append, SSE cursor replay, heartbeat, native ingest.

import type { RuntimeControl } from "./control.ts";
import { EventJournal, formatCursor, journalFor, parseCursor } from "./event-journal.ts";
import { translateNativeEvent, type NativeStreamEvent } from "./event-translator.ts";
import type { RuntimeEvent } from "./types.ts";

export const HEARTBEAT_MS = 15_000;

export type SseFrame =
  | { kind: "event"; event: RuntimeEvent }
  | { kind: "comment"; comment: string };

export type HubOptions = {
  heartbeatMs?: number;
  coalesceMs?: number;
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type Subscriber = (frame: SseFrame) => void;

const subscribers = new Map<string, Set<Subscriber>>();
const coalesceBuffers = new Map<string, { event: Omit<RuntimeEvent, "cursor" | "sequence">; timer: ReturnType<typeof setTimeout> | null }>();
let hubOptions: HubOptions = { heartbeatMs: HEARTBEAT_MS, coalesceMs: 50 };

export function configureEventHubForTest(options: HubOptions | null): void {
  hubOptions = options ?? { heartbeatMs: HEARTBEAT_MS, coalesceMs: 50 };
}

function journal(control: RuntimeControl, projectId: string): EventJournal {
  return journalFor(control.stateRoot, projectId, {
    maxSegmentBytes: hubOptions.maxSegmentBytes,
    maxSegments: hubOptions.maxSegments,
  });
}

function emit(projectId: string, frame: SseFrame): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  for (const subscriber of set) subscriber(frame);
}

function flushCoalesced(control: RuntimeControl, projectId: string, key: string): void {
  const buffered = coalesceBuffers.get(key);
  coalesceBuffers.delete(key);
  if (!buffered) return;
  if (buffered.timer) clearTimeout(buffered.timer);
  appendAndPublish(control, projectId, buffered.event);
}

function appendAndPublish(control: RuntimeControl, projectId: string, partial: Omit<RuntimeEvent, "cursor" | "sequence">): RuntimeEvent | null {
  const stored = journal(control, projectId).append(partial);
  if (!stored) return null;
  emit(projectId, { kind: "event", event: stored });
  return stored;
}

export function ingestNativeEvent(control: RuntimeControl, input: NativeStreamEvent): RuntimeEvent | null {
  const job = input.job_id ? control.jobs.get(input.job_id) : undefined;
  const resolved: NativeStreamEvent = {
    ...input,
    revision: input.revision ?? job?.revision ?? 0,
    authority_epoch: input.authority_epoch ?? job?.authority_epoch ?? 1,
  };
  const translated = translateNativeEvent(resolved, control.clock);
  if (translated.kind === "ignore") return null;
  if (translated.kind === "conflict") {
    return appendAndPublish(control, resolved.project_id, {
      protocol_version: 1,
      event_id: crypto.randomUUID(),
      authority_epoch: resolved.authority_epoch ?? 1,
      project_id: resolved.project_id,
      job_id: resolved.job_id ?? null,
      operation_id: resolved.operation_id ?? null,
      run_id: resolved.run_id ?? null,
      attempt_id: resolved.attempt_id ?? null,
      task_id: resolved.task_id ?? null,
      message_id: translated.message_id,
      type: "snapshot_invalidated",
      timestamp: control.clock().toISOString().replace(/\.\d{3}Z$/, "Z"),
      revision: resolved.revision ?? 0,
      payload: { reason: "conflicting_assistant_offset", message_id: translated.message_id },
    });
  }
  const coalesceMs = hubOptions.coalesceMs ?? 50;
  if (translated.coalesce && coalesceMs > 0) {
    const key = `${input.project_id}:${translated.event.message_id ?? translated.event.event_id}`;
    const existing = coalesceBuffers.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(() => flushCoalesced(control, input.project_id, key), coalesceMs);
    coalesceBuffers.set(key, { event: translated.event, timer });
    return null;
  }
  return appendAndPublish(control, input.project_id, translated.event);
}

export function ingestVerifiedMilestone(control: RuntimeControl, input: {
  project_id: string;
  job_id: string;
  operation_id?: string | null;
  run_id?: string | null;
  attempt_id?: string | null;
  revision: number;
  authority_epoch: number;
}): RuntimeEvent | null {
  return ingestNativeEvent(control, {
    type: "verified_milestone",
    project_id: input.project_id,
    job_id: input.job_id,
    operation_id: input.operation_id ?? null,
    run_id: input.run_id ?? null,
    attempt_id: input.attempt_id ?? null,
    revision: input.revision,
    authority_epoch: input.authority_epoch,
    payload: { state: "completed", source: "canonical_verified_milestone" },
  });
}

export function publishOperationUpdated(control: RuntimeControl, projectId: string, payload: Record<string, unknown>, ids: {
  job_id: string | null;
  operation_id: string;
  revision: number;
  authority_epoch: number;
}): void {
  ingestNativeEvent(control, {
    type: "operation_updated",
    project_id: projectId,
    job_id: ids.job_id,
    operation_id: ids.operation_id,
    revision: ids.revision,
    authority_epoch: ids.authority_epoch,
    payload,
  });
}

export function publishSnapshotInvalidated(control: RuntimeControl, projectId: string, jobId: string, revision: number, authorityEpoch: number): void {
  ingestNativeEvent(control, {
    type: "snapshot_invalidated",
    project_id: projectId,
    job_id: jobId,
    revision,
    authority_epoch: authorityEpoch,
    payload: { revision, authority_epoch: authorityEpoch },
  });
}

export function subscribeProjectEvents(
  control: RuntimeControl,
  projectId: string,
  after: string | null,
  emitFrame: Subscriber,
): () => void {
  const set = subscribers.get(projectId) ?? new Set<Subscriber>();
  set.add(emitFrame);
  subscribers.set(projectId, set);
  const replay = journal(control, projectId).readAfter(after);
  if (after && replay.gap) {
    const gap: RuntimeEvent = {
      protocol_version: 1,
      event_id: crypto.randomUUID(),
      cursor: formatCursor(1, 0),
      sequence: 0,
      authority_epoch: 1,
      project_id: projectId,
      job_id: null,
      operation_id: null,
      run_id: null,
      attempt_id: null,
      task_id: null,
      message_id: null,
      type: "stream_gap",
      timestamp: control.clock().toISOString().replace(/\.\d{3}Z$/, "Z"),
      revision: 0,
      payload: { reason: "cursor_unavailable", after, recovery: "snapshot_and_history" },
    };
    emitFrame({ kind: "event", event: gap });
  } else {
    for (const event of replay.events) emitFrame({ kind: "event", event });
  }
  const heartbeatMs = hubOptions.heartbeatMs ?? HEARTBEAT_MS;
  const timer = heartbeatMs > 0
    ? setInterval(() => emitFrame({ kind: "comment", comment: "heartbeat" }), heartbeatMs)
    : null;
  return () => {
    set.delete(emitFrame);
    if (timer) clearInterval(timer);
  };
}

export function readProjectJournal(control: RuntimeControl, projectId: string) {
  return journal(control, projectId);
}

export function cursorSemantics(): string {
  return [
    "Cursor is opaque epochN:sequenceM.",
    "GET /events?after=cursor resumes retained envelopes with sequence > M when that cursor is still in the journal.",
    "Unknown, malformed, or rotated-out cursors emit a project-level stream_gap (job_id=null) and require snapshot+history refresh.",
    "Missing after starts from the oldest retained envelope for this process, then live events.",
    "Token deltas and heartbeats do not increment job revision.",
  ].join(" ");
}

export function resetEventHubForTest(): void {
  subscribers.clear();
  for (const buffered of coalesceBuffers.values()) {
    if (buffered.timer) clearTimeout(buffered.timer);
  }
  coalesceBuffers.clear();
  hubOptions = { heartbeatMs: HEARTBEAT_MS, coalesceMs: 50 };
  void parseCursor;
}
