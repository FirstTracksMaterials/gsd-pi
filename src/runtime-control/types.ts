// Project/App: gsd-pi
// File Purpose: Runtime-v1 admission types (R3-R5). Not a second task queue.

export const PROTOCOL_VERSION = 1;

export const COMMAND_ACTIONS = [
  "prepare",
  "review",
  "replan",
  "start",
  "resume",
  "cancel",
  "recover",
] as const;

export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export const MODEL_PRODUCING_ACTIONS = [
  "prepare",
  "review",
  "replan",
  "start",
  "resume",
] as const;

export type ModelProducingAction = (typeof MODEL_PRODUCING_ACTIONS)[number];

export const OPERATION_STATES = [
  "accepted",
  "running",
  "awaiting_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

export type OperationKind = "job-command" | "import" | "answer";

export type CommandRequest = {
  protocol_version: 1;
  request_id: string;
  expected_revision: number;
  expected_epoch: number;
  action: CommandAction;
  parameters: Record<string, unknown>;
};

export type RuntimeError = {
  code:
    | "invalid_request"
    | "unknown_job"
    | "revision_conflict"
    | "request_id_conflict"
    | "model_busy"
    | "policy_unavailable"
    | "runtime_unavailable"
    | "recovery_required"
    | "invalid_contract";
  message: string;
  retryable: boolean;
  operation_id?: string | null;
};

export type Operation = {
  protocol_version: 1;
  operation_id: string;
  request_id: string;
  job_id: string | null;
  action: CommandAction | "import" | "answer";
  state: OperationState;
  admitted_at: string;
  updated_at: string;
  result: Record<string, unknown> | null;
  error: RuntimeError | null;
  target_operation_id: string | null;
};

export type StoredOperation = {
  operation: Operation;
  fingerprint: string;
  kind: OperationKind;
  dispatch_intent: boolean;
};

export type ReferenceRegistration = {
  project_id: string;
  root: string;
};

export type ProjectRegistration = {
  project_id: string;
  target_worktree: string;
  contract_root: string;
  reference_repositories: ReferenceRegistration[];
  writable_cache_roots: string[];
  required_policy: string;
  provider?: string | null;
  backend_idle_probe?: string | null;
};

export type RegistrationFile = {
  version?: number;
  projects: ProjectRegistration[];
};

export type ResolvedProject = {
  project_id: string;
  target_worktree: string;
  target_realpath: string;
  contract_root: string;
  reference_repositories: Array<ReferenceRegistration & { realpath: string }>;
  writable_cache_roots: string[];
  required_policy: string;
  provider: string | null;
  backend_idle_probe: string | null;
};

export type JobRecord = {
  job_id: string;
  project_id: string;
  milestone_id: string;
  revision: number;
  authority_epoch: number;
  spec_id?: string | null;
  import_digest?: string | null;
  import_fingerprint?: string | null;
  status?: string;
};

export const JOB_STATES = [
  "idle",
  "planning",
  "prepared",
  "running",
  "verifying",
  "waiting_for_input",
  "blocked",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
  "recovery_required",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const EVENT_TYPES = [
  "snapshot_invalidated",
  "operation_updated",
  "job_updated",
  "assistant_delta",
  "assistant_message",
  "tool_started",
  "tool_finished",
  "verification_updated",
  "input_required",
  "input_resolved",
  "recovery_required",
  "stream_gap",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ActionId = CommandAction;

export type Action = {
  id: ActionId;
  label: string;
  enabled: boolean;
  reason: string | null;
};

export type ActiveTask = {
  id: string;
  title: string;
  started_at: string | null;
  turns: number | null;
};

export type Progress = {
  tasks_completed: number;
  tasks_total: number;
  label: string;
};

export type PendingInput = {
  question_id: string;
  title: string;
  summary: string;
  method: "select" | "confirm" | "input" | "editor";
  session_id: string;
  url: string;
};

export type SnapshotReference = {
  project_id: string;
  root: string;
  head: string;
  dirty: boolean;
  files: Array<{ path: string; sha256: string }>;
};

export type ReadMetadata =
  | { source: "database"; authority: "db-authoritative" }
  | { source: "projection"; authority: "projection-fallback" };

export type ScientificStatus = "NOT_SIGNED_OFF" | "SIGNED_OFF" | "NOT_APPLICABLE";

export type JobSnapshot = {
  protocol_version: 1;
  job_id: string;
  spec_id: string;
  project_id: string;
  milestone_id: string;
  revision: number;
  authority_epoch: number;
  state: JobState;
  phase: string;
  observed_at: string;
  active_operation_id: string | null;
  active_task: ActiveTask | null;
  progress: Progress;
  actions: Action[];
  primary_action: ActionId | null;
  blockers: string[];
  pending_input: PendingInput | null;
  scientific_status: ScientificStatus;
  source_revision: string | null;
  references: SnapshotReference[];
  timeline: Array<Record<string, unknown>>;
  read_metadata: ReadMetadata;
  duration_ms: number | null;
  log_ref: string | null;
  run_id: string | null;
  attempt_id: string | null;
};

export type JobSummary = {
  job_id: string;
  spec_id: string;
  project_id: string;
  milestone_id: string;
  revision: number;
  authority_epoch: number;
  state: JobState;
  phase: string;
  primary_action: ActionId | null;
  progress: Progress;
  scientific_status: ScientificStatus;
};

export type RuntimeEvent = {
  protocol_version: 1;
  event_id: string;
  cursor: string;
  sequence: number;
  authority_epoch: number;
  project_id: string;
  job_id: string | null;
  operation_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  task_id: string | null;
  message_id: string | null;
  type: EventType;
  timestamp: string;
  revision: number;
  payload: Record<string, unknown>;
};

export type CrashHook =
  | "before_receipt"
  | "before_index"
  | "after_dispatch_intent"
  | null;
