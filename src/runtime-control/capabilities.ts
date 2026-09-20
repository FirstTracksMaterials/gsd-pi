// Project/App: gsd-pi
// File Purpose: GET /capabilities and GET /projects. No model calls.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRequiredPolicyReady } from "../resources/extensions/gsd/required-policy.ts";
import type { RegistrationRegistry } from "./registration.ts";
import { PROTOCOL_VERSION } from "./types.ts";

const C00_UPSTREAM_SHA = "fa83b795f3ef5fd7d2c02b37d4e96cbd9dc94f88";

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function gitSha(): string {
  try {
    const cwd = packageRoot();
    if (!existsSync(join(cwd, ".git")) && !existsSync(join(cwd, "..", ".git"))) {
      return "unknown";
    }
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export type FeatureFlags = {
  durable_operations: boolean;
  milestone_scope: boolean;
  required_policy_gate: boolean;
  cancellable_verification: boolean;
  project_snapshots: boolean;
  event_history: boolean;
  readonly_references: boolean;
  single_model_admission: boolean;
};

export async function buildCapabilities(registration: RegistrationRegistry): Promise<Record<string, unknown>> {
  const projects = registration.list();
  const diagnostics: string[] = [];
  if (registration.error) diagnostics.push(registration.error);
  if (!registration.path) diagnostics.push("No GSD_RUNTIME_REGISTRATION file configured");

  let requiredPolicy: string | null = null;
  let policyReady = !registration.error;
  for (const project of projects) {
    requiredPolicy = requiredPolicy ?? project.required_policy;
    const status = await isRequiredPolicyReady(project.target_realpath);
    if (!status.ready) {
      policyReady = false;
      if (status.reason) diagnostics.push(`${project.project_id}: ${status.reason}`);
    }
  }
  if (projects.length === 0 && !registration.error) policyReady = true;

  const features: FeatureFlags = {
    durable_operations: true,
    milestone_scope: true,
    required_policy_gate: true,
    cancellable_verification: true,
    project_snapshots: false,
    event_history: false,
    readonly_references: true,
    single_model_admission: true,
  };

  return {
    protocol: PROTOCOL_VERSION,
    runtime: {
      version: readVersion(),
      build_sha: gitSha(),
      upstream_sha: C00_UPSTREAM_SHA,
    },
    required_policy: requiredPolicy,
    policy_ready: policyReady,
    features,
    diagnostics,
  };
}

export async function buildProjectList(registration: RegistrationRegistry): Promise<{ projects: Record<string, unknown>[] }> {
  const projects = [];
  for (const project of registration.list()) {
    const status = await isRequiredPolicyReady(project.target_realpath);
    projects.push({
      project_id: project.project_id,
      target_worktree: project.target_worktree,
      required_policy: project.required_policy,
      policy_ready: status.ready,
      policy_reason: status.reason ?? null,
      references: project.reference_repositories.map((ref) => ({
        project_id: ref.project_id,
        root: ref.root,
      })),
    });
  }
  return { projects };
}
