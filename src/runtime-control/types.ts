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

export type CrashHook =
  | "before_receipt"
  | "before_index"
  | "after_dispatch_intent"
  | null;
