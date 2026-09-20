// Project/App: gsd-pi
// File Purpose: Translate BridgeService/native events into R9 envelopes. agent_end is not completion.

import { randomUUID } from "node:crypto";

import { appliesToCurrentAttempt, getObservation, patchObservation } from "./observation.ts";
import { formatCursor } from "./event-journal.ts";
import type { EventType, RuntimeEvent } from "./types.ts";

export type NativeStreamEvent = {
  type: string;
  project_id: string;
  job_id?: string | null;
  operation_id?: string | null;
  run_id?: string | null;
  attempt_id?: string | null;
  task_id?: string | null;
  message_id?: string | null;
  timestamp?: string;
  revision?: number;
  authority_epoch?: number;
  payload?: Record<string, unknown>;
  text?: string;
  offset?: number;
  assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number };
};

const COMPLETION_FALSE_TYPES = new Set(["agent_end", "execution_complete", "cost_update"]);

export type TranslateResult =
  | { kind: "ignore" }
  | { kind: "conflict"; message_id: string }
  | { kind: "event"; event: Omit<RuntimeEvent, "cursor" | "sequence">; coalesce: boolean };

function mapType(nativeType: string): EventType | null {
  switch (nativeType) {
    case "assistant_delta":
    case "message_update":
    case "text_delta":
      return "assistant_delta";
    case "assistant_message":
    case "message_end":
    case "message_start":
      return nativeType === "message_start" ? "assistant_delta" : "assistant_message";
    case "tool_execution_start":
    case "tool_started":
      return "tool_started";
    case "tool_execution_end":
    case "tool_execution_update":
    case "tool_finished":
      return "tool_finished";
    case "verification_updated":
    case "verification":
      return "verification_updated";
    case "extension_ui_request":
    case "input_required":
      return "input_required";
    case "input_resolved":
      return "input_resolved";
    case "operation_updated":
      return "operation_updated";
    case "job_updated":
      return "job_updated";
    case "snapshot_invalidated":
      return "snapshot_invalidated";
    case "recovery_required":
      return "recovery_required";
    case "stream_gap":
      return "stream_gap";
    case "verified_milestone":
      return "job_updated";
    default:
      return null;
  }
}

function deltaText(input: NativeStreamEvent): { text: string; offset: number } {
  const payload = input.payload ?? {};
  const fromAssistant = input.assistantMessageEvent?.type === "text_delta" ? input.assistantMessageEvent.delta ?? "" : "";
  const text = typeof input.text === "string"
    ? input.text
    : typeof payload.text === "string"
      ? payload.text
      : fromAssistant;
  const offset = typeof input.offset === "number"
    ? input.offset
    : typeof payload.offset === "number"
      ? payload.offset
      : 0;
  return { text, offset };
}

export function translateNativeEvent(input: NativeStreamEvent, clock: () => Date): TranslateResult {
  if (COMPLETION_FALSE_TYPES.has(input.type)) {
    return { kind: "ignore" };
  }
  const type = mapType(input.type);
  if (!type) return { kind: "ignore" };

  const jobId = input.job_id ?? null;
  const currentAttempt = jobId ? appliesToCurrentAttempt(jobId, input.attempt_id) : true;

  if (currentAttempt && input.type === "verified_milestone" && jobId) {
    patchObservation(jobId, {
      verified_complete: true,
      run_id: input.run_id ?? getObservation(jobId).run_id,
      attempt_id: input.attempt_id ?? getObservation(jobId).attempt_id,
    });
  } else if (currentAttempt && jobId && input.attempt_id && !getObservation(jobId).attempt_id) {
    patchObservation(jobId, {
      attempt_id: input.attempt_id,
      run_id: input.run_id ?? null,
      task_id: input.task_id ?? null,
    });
  }

  if (type === "assistant_delta" && jobId && input.message_id) {
    const current = getObservation(jobId);
    const { text, offset } = deltaText(input);
    if (current.message_id === input.message_id) {
      if (offset === current.message_offset - text.length && text === current.last_delta_text && text.length > 0) {
        return { kind: "ignore" };
      }
      if (offset !== current.message_offset) {
        return { kind: "conflict", message_id: input.message_id };
      }
    } else if (offset !== 0 && current.message_id) {
      return { kind: "conflict", message_id: input.message_id };
    }
    if (currentAttempt) {
      patchObservation(jobId, {
        message_id: input.message_id,
        message_offset: offset + text.length,
        last_delta_text: text,
      });
    }
  }

  if (type === "assistant_message" && jobId && input.message_id) {
    patchObservation(jobId, { message_id: input.message_id });
  }

  const payload = { ...(input.payload ?? {}) };
  if (type === "assistant_delta") {
    const delta = deltaText(input);
    payload.text = delta.text;
    payload.offset = delta.offset;
  }
  if (input.type === "verified_milestone") {
    payload.state = "completed";
    payload.source = "canonical_verified_milestone";
  }
  if (type === "job_updated" && payload.source === "execution_complete") {
    return { kind: "ignore" };
  }
  if (type === "job_updated" && payload.run_complete === true && payload.source !== "canonical_verified_milestone") {
    return { kind: "ignore" };
  }

  const revision = input.revision ?? (jobId ? getObservation(jobId) : null)?.message_offset ?? 0;
  void revision;
  const event: Omit<RuntimeEvent, "cursor" | "sequence"> = {
    protocol_version: 1,
    event_id: randomUUID(),
    authority_epoch: input.authority_epoch ?? 1,
    project_id: input.project_id,
    job_id: type === "stream_gap" ? input.job_id ?? null : input.job_id ?? null,
    operation_id: input.operation_id ?? null,
    run_id: input.run_id ?? (jobId ? getObservation(jobId).run_id : null),
    attempt_id: input.attempt_id ?? (jobId ? getObservation(jobId).attempt_id : null),
    task_id: input.task_id ?? (jobId ? getObservation(jobId).task_id : null),
    message_id: input.message_id ?? null,
    type,
    timestamp: input.timestamp ?? clock().toISOString().replace(/\.\d{3}Z$/, "Z"),
    revision: input.revision ?? 0,
    payload,
  };
  void formatCursor;
  return { kind: "event", event, coalesce: type === "assistant_delta" };
}
