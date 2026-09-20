// Project/App: gsd-pi
// File Purpose: Shared policy + lease guard for registered FTM native entry points.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { isRequiredPolicyReady } from "../resources/extensions/gsd/required-policy.ts";
import { modelBusy, policyUnavailable, RuntimeControlError } from "./errors.ts";
import type { RuntimeControl } from "./control.ts";
import { ensureRuntimeControl } from "./control.ts";

export type ManagedEntryKind = "readonly" | "prompt" | "terminal";

export type EntryGuardAllow = { allow: true };
export type EntryGuardDeny = { allow: false; status: number; body: { error: import("./types.ts").RuntimeError } };
export type EntryGuardResult = EntryGuardAllow | EntryGuardDeny;

const READ_ONLY_RPC_TYPES = new Set([
  "get_state",
  "get_project_progress",
  "get_project_snapshot",
  "get_available_models",
  "get_session_stats",
  "get_messages",
  "get_last_assistant_text",
  "get_fork_messages",
  "get_commands",
]);

export function isReadOnlyRpcType(type: string): boolean {
  return READ_ONLY_RPC_TYPES.has(type);
}

function canonicalCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export async function guardManagedEntry(
  cwd: string,
  kind: ManagedEntryKind,
  control?: RuntimeControl,
): Promise<EntryGuardResult> {
  const resolved = control ?? await ensureRuntimeControl();
  const project = resolved.registration.getByCwd(canonicalCwd(cwd));
  if (!project) return { allow: true };

  if (kind === "readonly") return { allow: true };

  try {
    const policy = await isRequiredPolicyReady(project.target_realpath);
    if (!policy.ready) {
      throw policyUnavailable(
        policy.reason ?? `Required policy ${project.required_policy} is not registered or not ready`,
      );
    }
    const lease = resolved.lease.current();
    if (lease) {
      throw modelBusy("A model-producing operation already owns admission", lease.operation_id);
    }
    return { allow: true };
  } catch (error) {
    if (error instanceof RuntimeControlError) {
      return { allow: false, status: error.status, body: error.body };
    }
    throw error;
  }
}
