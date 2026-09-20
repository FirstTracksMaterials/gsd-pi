// Project/App: gsd-pi
// File Purpose: Job list/detail/action projections. No model calls. readMetadata is authoritative.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getPendingForJob } from "./answers.ts";
import { attachSameWorker, buildQuestionSessionUrl } from "./deep-links.ts";
import { invalidRequest, unknownJob } from "./errors.ts";
import { defaultSpecId } from "./job-catalog.ts";
import { appliesToCurrentAttempt, getObservation, patchObservation, type JobObservation } from "./observation.ts";
import { latestOpenRecoveryForJob } from "./recovery.ts";
import type { RuntimeControl } from "./control.ts";
import type {
  Action,
  ActionId,
  JobRecord,
  JobSnapshot,
  JobState,
  JobSummary,
  PendingInput,
  Progress,
  ReadMetadata,
  ScientificStatus,
  SnapshotReference,
  StoredOperation,
} from "./types.ts";
import { getWorkspacePhase } from "./workspace-profile.ts";

export type NativeObservationInput = {
  readMetadata: ReadMetadata;
  phase: string;
  tasks_completed: number;
  tasks_total: number;
  blockers: string[];
  verified_complete?: boolean;
  milestone_status?: string;
  active_task?: JobSnapshot["active_task"];
  duration_ms?: number | null;
  log_ref?: string | null;
  source_revision?: string | null;
  timeline?: Array<Record<string, unknown>>;
  scientific_status?: ScientificStatus;
  open_question?: {
    question_id: string;
    title: string;
    summary: string;
    method: PendingInput["method"];
    session_id: string;
  } | null;
};

const VERIFYING_PHASES = new Set([
  "verifying",
  "summarizing",
  "advancing",
  "validating-milestone",
  "completing-milestone",
]);
const PLANNING_PHASES = new Set([
  "pre-planning",
  "needs-discussion",
  "discussing",
  "researching",
  "planning",
  "refining",
  "evaluating-gates",
  "replanning-slice",
]);
const LIVE_OPERATION_STATES = new Set(["accepted", "running", "awaiting_input", "cancelling", "recovery_required"]);
const ACTION_LABELS: Record<ActionId, string> = {
  prepare: "Prepare job",
  review: "Review current",
  replan: "Regenerate plan",
  start: "Launch job",
  resume: "Resume job",
  cancel: "Cancel job",
  recover: "Recover job",
};

let nativeReader: ((basePath: string) => Promise<NativeObservationInput | null>) | null = null;

export function registerNativeSnapshotReaderForTest(
  reader: ((basePath: string) => Promise<NativeObservationInput | null>) | null,
): void {
  nativeReader = reader;
}

export function resetSnapshotsForTest(): void {
  nativeReader = null;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function gitHead(root: string): { head: string; dirty: boolean } {
  if (!existsSync(join(root, ".git"))) return { head: "unknown", dirty: false };
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
    return { head, dirty: status.trim().length > 0 };
  } catch {
    return { head: "unknown", dirty: false };
  }
}

function referencesFor(project: { project_id: string; target_realpath: string; reference_repositories: Array<{ project_id: string; realpath: string }> }): SnapshotReference[] {
  const refs = [
    { project_id: project.project_id, root: project.target_realpath },
    ...project.reference_repositories.map((ref) => ({ project_id: ref.project_id, root: ref.realpath })),
  ];
  return refs.map((ref) => {
    const git = gitHead(ref.root);
    return { ...ref, head: git.head, dirty: git.dirty, files: [] };
  });
}

async function readNative(basePath: string): Promise<NativeObservationInput | null> {
  if (nativeReader) return nativeReader(basePath);
  try {
    const { readProjectSnapshotFromDb } = await import("../resources/extensions/gsd/state/project-snapshot.ts");
    const { readProgressFromDb } = await import("../resources/extensions/gsd/state/progress-from-db.ts");
    const snapshot = await readProjectSnapshotFromDb(basePath, { preserveGlobalDbHandle: true });
    const progress = await readProgressFromDb(basePath);
    if (!snapshot && !progress) return null;
    const tasksTotal = snapshot?.progress.tasks.total ?? progress?.tasks.total ?? 0;
    const tasksDone = snapshot?.progress.tasks.done ?? progress?.tasks.done ?? 0;
    const question = snapshot?.openQuestions[0];
    return {
      readMetadata: { source: "database", authority: "db-authoritative" },
      phase: snapshot?.current.phase ?? progress?.phase ?? "idle",
      tasks_completed: tasksDone,
      tasks_total: tasksTotal,
      blockers: snapshot?.blockers.map((row) => row.description) ?? progress?.blockers ?? [],
      verified_complete: false,
      milestone_status: snapshot?.current.activeMilestone ? snapshot.current.phase : undefined,
      active_task: snapshot?.current.activeTask
        ? { id: snapshot.current.activeTask.id, title: snapshot.current.activeTask.title, started_at: null, turns: null }
        : progress?.activeTask
          ? { id: progress.activeTask.id, title: progress.activeTask.title, started_at: null, turns: null }
          : null,
      open_question: question
        ? {
          question_id: question.questionId,
          title: question.questionText,
          summary: question.questionText,
          method: "input",
          session_id: "",
        }
        : null,
    };
  } catch {
    return null;
  }
}

function latestLive(operations: StoredOperation[]): StoredOperation | undefined {
  const live = operations.filter((stored) => LIVE_OPERATION_STATES.has(stored.operation.state));
  return live.sort((a, b) => a.operation.updated_at.localeCompare(b.operation.updated_at)).at(-1);
}

function latestTerminal(operations: StoredOperation[]): StoredOperation | undefined {
  const terminal = operations.filter((stored) => !LIVE_OPERATION_STATES.has(stored.operation.state));
  return terminal.sort((a, b) => a.operation.updated_at.localeCompare(b.operation.updated_at)).at(-1);
}

function deriveState(input: {
  operations: StoredOperation[];
  observation: JobObservation;
  native: NativeObservationInput | null;
  pending: boolean;
  blockers: string[];
  workspacePhase?: string;
}): JobState {
  const live = latestLive(input.operations);
  if (live?.operation.state === "cancelling") return "cancelling";
  if (live?.operation.state === "recovery_required") return "recovery_required";
  if (live?.operation.state === "awaiting_input" || input.pending) return "waiting_for_input";
  const phase = input.native?.phase ?? input.observation.native_phase ?? "";
  if (live && (VERIFYING_PHASES.has(phase) || input.workspacePhase === "verify")) return "verifying";
  if (live && (live.operation.state === "accepted" || live.operation.state === "running")) {
    return live.operation.action === "prepare" ? "planning" : "running";
  }
  const dbAuthoritative = (input.native?.readMetadata ?? input.observation.read_metadata).authority === "db-authoritative";
  if (input.observation.verified_complete) return "completed";
  if (input.native?.verified_complete && dbAuthoritative) return "completed";
  if (phase === "blocked" || input.blockers.length > 0) return "blocked";
  const terminal = latestTerminal(input.operations);
  if (terminal?.operation.state === "cancelled") return "cancelled";
  if (terminal?.operation.state === "failed") return "failed";
  if (terminal?.operation.state === "recovery_required") return "recovery_required";
  if (terminal?.operation.action === "prepare" && terminal.operation.state === "succeeded") return "prepared";
  if (terminal?.operation.action === "start" && terminal.operation.state === "succeeded" && input.observation.verified_complete) {
    return "completed";
  }
  if (PLANNING_PHASES.has(phase)) return "planning";
  if (phase === "executing") return "running";
  return "idle";
}

function progressFrom(native: NativeObservationInput | null, observation: JobObservation): Progress {
  const completed = native?.tasks_completed ?? 0;
  const total = native?.tasks_total ?? 0;
  void observation;
  if (total === 0 && completed === 0) {
    return { tasks_completed: 0, tasks_total: 0, label: "no task totals" };
  }
  return { tasks_completed: completed, tasks_total: total, label: `${completed} of ${total} tasks` };
}

function action(id: ActionId, enabled: boolean, reason: string | null = null): Action {
  return { id, label: ACTION_LABELS[id], enabled, reason };
}

function actionsFor(state: JobState, recoveryAvailable: boolean, blockers: string[]): { actions: Action[]; primary_action: ActionId | null } {
  const reviewReplan = state === "idle" || state === "prepared" || state === "cancelled" || state === "failed";
  const cancelLive = state === "running" || state === "planning" || state === "verifying" || state === "waiting_for_input" || state === "cancelling";
  const actions: Action[] = [
    action("prepare", state === "idle"),
    action("review", reviewReplan),
    action("replan", reviewReplan),
    action("start", state === "prepared" && blockers.length === 0, state === "prepared" && blockers.length > 0 ? "Blockers must be cleared before start" : null),
    action("resume", state === "cancelled"),
    action("cancel", cancelLive, cancelLive ? null : "No outstanding operation to cancel"),
    action("recover", (state === "failed" || state === "recovery_required") && recoveryAvailable, (state === "failed" || state === "recovery_required") && !recoveryAvailable ? "No native recovery_id is available" : null),
  ];
  let primary: ActionId | null = null;
  if (state === "idle") primary = "prepare";
  else if (state === "prepared" && blockers.length === 0) primary = "start";
  else if (state === "cancelled") primary = "resume";
  else if ((state === "failed" || state === "recovery_required") && recoveryAvailable) primary = "recover";
  return { actions, primary_action: primary };
}

function pendingInputFor(job: JobRecord, projectCwd: string, native: NativeObservationInput | null): PendingInput | null {
  const registered = getPendingForJob(job.job_id);
  const nativeQuestion = native?.open_question;
  const question = registered ?? (nativeQuestion
    ? {
      question_id: nativeQuestion.question_id,
      job_id: job.job_id,
      session_id: nativeQuestion.session_id,
      title: nativeQuestion.title,
      summary: nativeQuestion.summary,
      method: nativeQuestion.method,
    }
    : undefined);
  if (!question) return null;
  attachSameWorker(projectCwd, question.session_id);
  return {
    question_id: question.question_id,
    title: question.title ?? question.question_id,
    summary: question.summary ?? "",
    method: question.method ?? "input",
    session_id: question.session_id,
    url: buildQuestionSessionUrl({
      targetRealpath: projectCwd,
      sessionId: question.session_id,
      questionId: question.question_id,
    }),
  };
}

export async function buildJobSnapshot(control: RuntimeControl, jobId: string): Promise<JobSnapshot> {
  const decoded = decodeURIComponent(jobId);
  const job = control.jobs.get(decoded);
  if (!job) throw unknownJob(`Unknown job ${decoded}`);
  const project = control.registration.getById(job.project_id);
  if (!project) throw invalidRequest(`Unknown project ${job.project_id}`);
  const native = await readNative(project.target_realpath);
  const observation = getObservation(job.job_id);
  if (native) {
    patchObservation(job.job_id, {
      read_metadata: native.readMetadata,
      native_phase: native.phase,
      active_task: native.active_task ?? observation.active_task,
      duration_ms: native.duration_ms ?? observation.duration_ms,
      log_ref: native.log_ref ?? observation.log_ref,
      source_revision: native.source_revision ?? observation.source_revision,
      timeline: native.timeline ?? observation.timeline,
      scientific_status: native.scientific_status ?? observation.scientific_status,
      verified_complete: observation.verified_complete
        || (native.readMetadata.authority === "db-authoritative" && Boolean(native.verified_complete)),
    });
  }
  const liveObservation = getObservation(job.job_id);
  const operations = control.store.listForJob(job.job_id).filter((stored) => appliesToCurrentAttempt(job.job_id, (stored.operation.result?.attempt_id as string | undefined) ?? null));
  const pending = pendingInputFor(job, project.target_realpath, native);
  const blockers = native?.blockers ?? [];
  const metadata = native?.readMetadata ?? liveObservation.read_metadata;
  let state = deriveState({
    operations,
    observation: liveObservation,
    native,
    pending: Boolean(pending),
    blockers,
    workspacePhase: getWorkspacePhase(project.target_realpath),
  });
  let scientific: ScientificStatus = liveObservation.scientific_status;
  if (metadata.authority === "projection-fallback") {
    if (state === "completed") state = latestTerminal(operations)?.operation.action === "prepare" ? "prepared" : "running";
    if (scientific === "SIGNED_OFF") scientific = "NOT_SIGNED_OFF";
  }
  if (scientific === "SIGNED_OFF" && metadata.authority !== "db-authoritative") scientific = "NOT_SIGNED_OFF";
  const recovery = latestOpenRecoveryForJob(job.job_id);
  const { actions, primary_action } = actionsFor(state, Boolean(recovery), blockers);
  const live = latestLive(operations);
  const phase = native?.phase ?? liveObservation.native_phase ?? state;
  const snapshot: JobSnapshot = {
    protocol_version: 1,
    job_id: job.job_id,
    spec_id: job.spec_id ?? defaultSpecId(job.project_id, job.milestone_id),
    project_id: job.project_id,
    milestone_id: job.milestone_id,
    revision: job.revision,
    authority_epoch: job.authority_epoch,
    state,
    phase,
    observed_at: nowIso(control.clock),
    active_operation_id: live?.operation.operation_id ?? null,
    active_task: native?.active_task ?? liveObservation.active_task,
    progress: progressFrom(native, liveObservation),
    actions,
    primary_action,
    blockers,
    pending_input: pending,
    scientific_status: scientific,
    source_revision: native?.source_revision ?? liveObservation.source_revision,
    references: liveObservation.references.length > 0 ? liveObservation.references : referencesFor(project),
    timeline: native?.timeline ?? liveObservation.timeline,
    read_metadata: metadata,
    duration_ms: native?.duration_ms ?? liveObservation.duration_ms,
    log_ref: native?.log_ref ?? liveObservation.log_ref,
    run_id: liveObservation.run_id,
    attempt_id: liveObservation.attempt_id,
  };
  return snapshot;
}

export function summarize(snapshot: JobSnapshot): JobSummary {
  return {
    job_id: snapshot.job_id,
    spec_id: snapshot.spec_id,
    project_id: snapshot.project_id,
    milestone_id: snapshot.milestone_id,
    revision: snapshot.revision,
    authority_epoch: snapshot.authority_epoch,
    state: snapshot.state,
    phase: snapshot.phase,
    primary_action: snapshot.primary_action,
    progress: snapshot.progress,
    scientific_status: snapshot.scientific_status,
  };
}

export async function listProjectJobs(control: RuntimeControl, projectId: string): Promise<{ jobs: JobSummary[]; revision: number }> {
  const decoded = decodeURIComponent(projectId);
  const project = control.registration.getById(decoded);
  if (!project) throw invalidRequest(`Unknown project ${decoded}`);
  const records = control.jobs.list().filter((job) => job.project_id === decoded);
  const snapshots = await Promise.all(records.map((job) => buildJobSnapshot(control, job.job_id)));
  const revision = snapshots.reduce((max, snapshot) => Math.max(max, snapshot.revision), 0);
  return { jobs: snapshots.map(summarize), revision };
}

export function reconcileBufferedEvents(
  snapshot: Pick<JobSnapshot, "authority_epoch" | "revision">,
  buffered: Array<{ type: string; authority_epoch: number; revision: number; attempt_id: string | null; message_id: string | null }>,
  currentAttemptId: string | null,
): typeof buffered {
  const seenMessages = new Set<string>();
  const kept = [];
  for (const event of buffered) {
    if (event.authority_epoch !== snapshot.authority_epoch) continue;
    if (event.revision < snapshot.revision && (event.type === "job_updated" || event.type === "operation_updated")) continue;
    if (event.attempt_id && currentAttemptId && event.attempt_id !== currentAttemptId) continue;
    if (event.message_id) {
      if (seenMessages.has(event.message_id) && event.type === "assistant_message") {
        kept.push(event);
        continue;
      }
      seenMessages.add(event.message_id);
    }
    kept.push(event);
  }
  return kept;
}
