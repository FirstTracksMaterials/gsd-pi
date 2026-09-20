// Project/App: gsd-pi
// File Purpose: Public runtime-control surface for HTTP routes and tests.

export { admitCommand, getOperation, getOperationByRequest, parseCommandRequest } from "./admission.ts";
export { buildCapabilities, buildProjectList } from "./capabilities.ts";
export { registerCommandHandlerForTest, resetCommandHandlerForTest } from "./command-handlers.ts";
export {
  getRuntimeControl,
  resetRuntimeControlForTest,
  resolveStateRoot,
  RuntimeControl,
  setRuntimeControlForTest,
} from "./control.ts";
export { guardManagedEntry, isReadOnlyRpcType } from "./entry-guard.ts";
export { RuntimeControlError } from "./errors.ts";
export { fingerprintCommand } from "./fingerprint.ts";
export { REGISTRATION_ENV } from "./registration.ts";
export type { CommandRequest, JobRecord, Operation, RegistrationFile } from "./types.ts";
