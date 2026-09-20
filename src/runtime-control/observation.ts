// Project/App: gsd-pi
// File Purpose: Live job observation overlay. Old-attempt terminals cannot override current state.

import type { ActiveTask, ReadMetadata, ScientificStatus } from "./types.ts";

export type JobObservation = {
  job_id: string;
  run_id: string | null;
  attempt_id: string | null;
  task_id: string | null;
  session_id: string | null;
  message_id: string | null;
  message_offset: number;
  last_delta_text: string | null;
  verified_complete: boolean;
  native_phase: string | null;
  scientific_status: ScientificStatus;
  active_task: ActiveTask | null;
  duration_ms: number | null;
  log_ref: string | null;
  timeline: Array<Record<string, unknown>>;
  source_revision: string | null;
  read_metadata: ReadMetadata;
  references: Array<{ project_id: string; root: string; head: string; dirty: boolean; files: Array<{ path: string; sha256: string }> }>;
};

const observations = new Map<string, JobObservation>();

export function defaultObservation(jobId: string): JobObservation {
  return {
    job_id: jobId,
    run_id: null,
    attempt_id: null,
    task_id: null,
    session_id: null,
    message_id: null,
    message_offset: 0,
    last_delta_text: null,
    verified_complete: false,
    native_phase: null,
    scientific_status: "NOT_SIGNED_OFF",
    active_task: null,
    duration_ms: null,
    log_ref: null,
    timeline: [],
    source_revision: null,
    read_metadata: { source: "projection", authority: "projection-fallback" },
    references: [],
  };
}

export function getObservation(jobId: string): JobObservation {
  return observations.get(jobId) ?? defaultObservation(jobId);
}

export function putObservation(observation: JobObservation): JobObservation {
  observations.set(observation.job_id, observation);
  return observation;
}

export function patchObservation(jobId: string, fields: Partial<JobObservation>): JobObservation {
  const next = { ...getObservation(jobId), ...fields, job_id: jobId };
  return putObservation(next);
}

export function appliesToCurrentAttempt(jobId: string, attemptId: string | null | undefined): boolean {
  if (!attemptId) return true;
  const current = getObservation(jobId).attempt_id;
  if (!current) return true;
  return current === attemptId;
}

export function resetObservationsForTest(): void {
  observations.clear();
}
