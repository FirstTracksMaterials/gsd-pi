// Project/App: gsd-pi
// File Purpose: Public runtime-control surface for HTTP routes and tests.

export { admitCommand, getOperation, getOperationByRequest, parseCommandRequest } from "./admission.ts";
export { buildCapabilities, buildProjectList } from "./capabilities.ts";
export { registerCommandHandlerForTest, resetCommandHandlerForTest } from "./command-handlers.ts";
export {
  ensureRuntimeControl,
  getRuntimeControl,
  loadRequiredPolicyModule,
  REQUIRED_POLICY_MODULE_ENV,
  requiredPolicyModuleError,
  resetRuntimeControlForTest,
  resolveStateRoot,
  RuntimeControl,
  setRuntimeControlForTest,
} from "./control.ts";
export { guardManagedEntry, isReadOnlyRpcType } from "./entry-guard.ts";
export { RuntimeControlError } from "./errors.ts";
export { fingerprintAnswer, fingerprintCommand, fingerprintImport } from "./fingerprint.ts";
export { REGISTRATION_ENV } from "./registration.ts";
export { admitImport } from "./import-jobs.ts";
export { admitAnswer, registerPendingQuestion } from "./answers.ts";
export { buildJobSnapshot, listProjectJobs, registerNativeSnapshotReaderForTest, reconcileBufferedEvents } from "./snapshots.ts";
export { subscribeProjectEvents, ingestNativeEvent, ingestVerifiedMilestone, cursorSemantics, configureEventHubForTest } from "./event-hub.ts";
export { readJobHistory } from "./history.ts";
export { attachSameWorker, buildQuestionSessionUrl, workerKeyForCwd } from "./deep-links.ts";
export { modelCallCount, resetModelCallsForTest } from "./model-calls.ts";
export {
  applyPrepareDispatchBoundary,
  beginPrepareMode,
  endPrepareMode,
  isPrepareMode,
} from "./prepare-boundary.ts";
export { registerNativeWorkflowOpsForTest, getLastMilestoneLock } from "./native-commands.ts";
export { registerNativeAutoDispatch, registerNativeAutoDispatchForTest } from "./native-auto-dispatch.ts";
export { registerIdleProbeForTest } from "./idle-probe.ts";
export { registerCancelNativeOpsForTest } from "./cancel.ts";
export type { CommandRequest, JobRecord, Operation, RegistrationFile } from "./types.ts";
