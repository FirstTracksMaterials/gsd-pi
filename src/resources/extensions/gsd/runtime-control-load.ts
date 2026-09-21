// Project/App: gsd-pi
// File Purpose: Load runtime-control from extension emit graph without pulling it into rootDir src/resources.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function existingModule(path: string): string | null {
  if (existsSync(path)) return path;
  if (path.endsWith(".ts")) {
    const javascript = path.slice(0, -3) + ".js";
    if (existsSync(javascript)) return javascript;
  }
  return null;
}

export function resolveRuntimeControlModule(basename: string, here = dirname(fileURLToPath(import.meta.url))): string {
  const packaged = process.env.GSD_WEB_PACKAGE_ROOT?.trim();
  const candidates = [
    join(here, "../../../runtime-control", basename),
    packaged ? join(packaged, "src", "runtime-control", basename) : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const found = existingModule(candidate);
    if (found) return found;
  }
  throw new Error(`runtime-control/${basename} was not found beside the extension or GSD_WEB_PACKAGE_ROOT`);
}

export type ManagedSpawn =
  | { ok: true; file: string; args: string[] }
  | { ok: false; diagnostics: string };

export type WriteDecision = {
  allow: boolean;
  reason?: string;
  role: "target" | "reference" | "scratch" | "planning" | "outside";
};

export type WorkspaceProfile = {
  projectId: string;
  targetRealpath: string;
  referenceRealpaths: string[];
  cacheRealpaths: string[];
  phase: string;
  allowedEdits: string[];
};

export type ContractDiffFinding = {
  path: string;
  reason: string;
};

type WorkspaceProfileModule = {
  wrapManagedCommand: (cwd: string, file: string, args: string[]) => ManagedSpawn;
  assertTrustedGitRepo: (repoPath: string, cwd?: string) => void;
  evaluateWrite: (absolutePath: string, cwd?: string) => WriteDecision;
  getWorkspaceProfileByTarget: (targetRealpath: string) => WorkspaceProfile | undefined;
  rejectOutOfContractTargetChanges: (
    profile: WorkspaceProfile,
    changedRelativePaths: string[],
  ) => ContractDiffFinding[];
};

type PrepareBoundaryModule = {
  isPrepareMode: (basePath: string) => boolean;
  applyPrepareDispatchBoundary: (
    dispatch: { action: string; unitType?: string; unitId?: string },
    options: { prepareMode: boolean; milestoneLock?: string | null },
  ) => { kind: string; reason?: string; unitType?: string; unitId?: string; action?: unknown };
};

function workspaceProfile(): WorkspaceProfileModule {
  return require(resolveRuntimeControlModule("workspace-profile.ts")) as WorkspaceProfileModule;
}

function prepareBoundary(): PrepareBoundaryModule {
  return require(resolveRuntimeControlModule("prepare-boundary.ts")) as PrepareBoundaryModule;
}

export function wrapManagedCommand(cwd: string, file: string, args: string[]): ManagedSpawn {
  return workspaceProfile().wrapManagedCommand(cwd, file, args);
}

export function assertTrustedGitRepo(repoPath: string, cwd?: string): void {
  workspaceProfile().assertTrustedGitRepo(repoPath, cwd);
}

export function evaluateWrite(absolutePath: string, cwd?: string): WriteDecision {
  return workspaceProfile().evaluateWrite(absolutePath, cwd);
}

export function getWorkspaceProfileByTarget(targetRealpath: string): WorkspaceProfile | undefined {
  return workspaceProfile().getWorkspaceProfileByTarget(targetRealpath);
}

export function rejectOutOfContractTargetChanges(
  profile: WorkspaceProfile,
  changedRelativePaths: string[],
): ContractDiffFinding[] {
  return workspaceProfile().rejectOutOfContractTargetChanges(profile, changedRelativePaths);
}

export function isPrepareMode(basePath: string): boolean {
  return prepareBoundary().isPrepareMode(basePath);
}

export function applyPrepareDispatchBoundary(
  dispatch: { action: string; unitType?: string; unitId?: string },
  options: { prepareMode: boolean; milestoneLock?: string | null },
): { kind: string; reason?: string; unitType?: string; unitId?: string; action?: unknown } {
  return prepareBoundary().applyPrepareDispatchBoundary(dispatch, options);
}
