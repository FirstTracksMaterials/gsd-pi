// Project/App: gsd-pi
// File Purpose: S6 workspace profiles. One writable target; neighbours read-only.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import type { ResolvedProject } from "./types.ts";

export type WorkspacePhase = "plan" | "review" | "implement" | "verify";

export type WorkspaceProfile = {
  projectId: string;
  targetRealpath: string;
  referenceRealpaths: string[];
  cacheRealpaths: string[];
  phase: WorkspacePhase;
  allowedEdits: string[];
};

export type WriteDecision = {
  allow: boolean;
  reason?: string;
  role: "target" | "reference" | "scratch" | "planning" | "outside";
};

export type BubblewrapPreflight =
  | { ok: true; bwrap: string }
  | { ok: false; code: "bwrap_unavailable" | "userns_unavailable"; diagnostics: string };

const profiles = new Map<string, WorkspaceProfile>();
const phases = new Map<string, WorkspacePhase>();

export function canonicalRealpath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    let dir = resolved;
    const tail: string[] = [];
    while (dir && dir !== resolve(dir, "..")) {
      try {
        const real = realpathSync(dir);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const idx = dir.lastIndexOf(sep);
        if (idx <= 0) break;
        tail.push(dir.slice(idx + 1));
        dir = dir.slice(0, idx) || sep;
      }
    }
    return resolved;
  }
}

export function isPathContained(target: string, container: string): boolean {
  if (target === container) return true;
  const prefix = container.endsWith(sep) ? container : container + sep;
  return target.startsWith(prefix);
}

export function assertDistinctWorkspaceRoots(project: ResolvedProject): void {
  const entries: Array<{ id: string; path: string }> = [
    { id: "target", path: project.target_realpath },
    ...project.reference_repositories.map((ref) => ({ id: `reference:${ref.project_id}`, path: ref.realpath })),
  ];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (a.path === b.path) {
        throw new Error(`Overlapping or aliased workspace roots ${a.id} and ${b.id} at ${a.path}`);
      }
      if (isPathContained(a.path, b.path) || isPathContained(b.path, a.path)) {
        throw new Error(`Nested workspace roots make the write target ambiguous: ${a.id} (${a.path}) vs ${b.id} (${b.path})`);
      }
    }
  }
}

export function buildWorkspaceProfile(
  project: ResolvedProject,
  options: { phase?: WorkspacePhase; allowedEdits?: string[] } = {},
): WorkspaceProfile {
  assertDistinctWorkspaceRoots(project);
  return {
    projectId: project.project_id,
    targetRealpath: project.target_realpath,
    referenceRealpaths: project.reference_repositories.map((ref) => ref.realpath),
    cacheRealpaths: project.writable_cache_roots.map((root) => canonicalRealpath(root)),
    phase: options.phase ?? "implement",
    allowedEdits: options.allowedEdits ?? ["**"],
  };
}

export function registerWorkspaceProfile(profile: WorkspaceProfile): void {
  profiles.set(profile.targetRealpath, profile);
  phases.set(profile.targetRealpath, profile.phase);
  installWriteGuards();
}

export function unregisterWorkspaceProfile(targetRealpath: string): void {
  profiles.delete(targetRealpath);
  phases.delete(targetRealpath);
}

export function setWorkspacePhase(targetRealpath: string, phase: WorkspacePhase): void {
  phases.set(targetRealpath, phase);
  const existing = profiles.get(targetRealpath);
  if (existing) existing.phase = phase;
}

export function getWorkspaceProfileForPath(absolutePath: string): WorkspaceProfile | undefined {
  const real = canonicalRealpath(absolutePath);
  for (const profile of profiles.values()) {
    if (isPathContained(real, profile.targetRealpath)) return profile;
    if (profile.referenceRealpaths.some((root) => isPathContained(real, root))) return profile;
    if (profile.cacheRealpaths.some((root) => isPathContained(real, root))) return profile;
  }
  return undefined;
}

export function getWorkspaceProfileByTarget(targetRealpath: string): WorkspaceProfile | undefined {
  return profiles.get(canonicalRealpath(targetRealpath));
}

function matchesAllowedEdit(rel: string, allowedEdits: string[]): boolean {
  if (allowedEdits.includes("**") || allowedEdits.includes("*")) return true;
  const normalized = rel.replaceAll("\\", "/");
  for (const pattern of allowedEdits) {
    const p = pattern.replaceAll("\\", "/");
    if (p === normalized) return true;
    if (p.endsWith("/**") && normalized.startsWith(p.slice(0, -3))) return true;
    if (p.endsWith("/*")) {
      const dir = p.slice(0, -2);
      if (normalized.startsWith(`${dir}/`) && !normalized.slice(dir.length + 1).includes("/")) return true;
    }
    if (p.includes("**")) {
      const prefix = p.split("**")[0] ?? "";
      if (normalized.startsWith(prefix)) return true;
    }
  }
  return false;
}

function isPlanningPath(real: string, target: string): boolean {
  const rel = relative(target, real).replaceAll("\\", "/");
  return rel === ".gsd" || rel.startsWith(".gsd/");
}

export function evaluateWrite(absolutePath: string, cwd?: string): WriteDecision {
  const real = canonicalRealpath(absolutePath);
  const profile = cwd
    ? getWorkspaceProfileByTarget(canonicalRealpath(cwd)) ?? getWorkspaceProfileForPath(real)
    : getWorkspaceProfileForPath(real);
  if (!profile) return { allow: true, role: "outside" };

  if (profile.cacheRealpaths.some((root) => isPathContained(real, root))) {
    return { allow: true, role: "scratch" };
  }
  if (profile.referenceRealpaths.some((root) => isPathContained(real, root))) {
    return {
      allow: false,
      role: "reference",
      reason: `Write into read-only neighbour is forbidden: ${real}`,
    };
  }
  if (isPathContained(real, profile.targetRealpath)) {
    if (isPlanningPath(real, profile.targetRealpath)) {
      return { allow: true, role: "planning" };
    }
    if (profile.phase === "plan" || profile.phase === "review") {
      return {
        allow: false,
        role: "target",
        reason: `Plan/review cannot mutate product code: ${relative(profile.targetRealpath, real)}`,
      };
    }
    const rel = relative(profile.targetRealpath, real).replaceAll("\\", "/");
    if (rel.startsWith(".git/") || rel === ".git") {
      return { allow: false, role: "target", reason: "Git administration paths are host-owned, not product outputs" };
    }
    if (!matchesAllowedEdit(rel, profile.allowedEdits)) {
      return {
        allow: false,
        role: "target",
        reason: `Path ${rel} is outside allowed_edits`,
      };
    }
    return { allow: true, role: "target" };
  }
  return {
    allow: false,
    role: "outside",
    reason: `Write outside the registered workspace target is forbidden: ${real}`,
  };
}

export function evaluateRead(absolutePath: string, cwd?: string): WriteDecision {
  const real = canonicalRealpath(absolutePath);
  const profile = cwd
    ? getWorkspaceProfileByTarget(canonicalRealpath(cwd)) ?? getWorkspaceProfileForPath(real)
    : getWorkspaceProfileForPath(real);
  if (!profile) return { allow: true, role: "outside" };
  if (profile.referenceRealpaths.some((root) => isPathContained(real, root))) {
    return { allow: true, role: "reference" };
  }
  if (isPathContained(real, profile.targetRealpath)) return { allow: true, role: "target" };
  if (profile.cacheRealpaths.some((root) => isPathContained(real, root))) return { allow: true, role: "scratch" };
  return { allow: true, role: "outside" };
}

export function enforceNativeWrite(absolutePath: string, cwd?: string): void {
  const decision = evaluateWrite(absolutePath, cwd);
  if (!decision.allow) {
    throw new Error(decision.reason ?? "Workspace write denied");
  }
}

export type ManagedSpawn =
  | { ok: true; file: string; args: string[] }
  | { ok: false; diagnostics: string };

export function wrapManagedCommand(cwd: string, file: string, args: string[]): ManagedSpawn {
  const profile = getWorkspaceProfileByTarget(canonicalRealpath(cwd));
  if (!profile) return { ok: true, file, args };
  const preflight = preflightBubblewrap();
  if (!preflight.ok) return { ok: false, diagnostics: preflight.diagnostics };
  const wrapped = buildBubblewrapArgv(profile, { file, args });
  return { ok: true, file: wrapped[0]!, args: wrapped.slice(1) };
}

export function assertTrustedGitRepo(repoPath: string, cwd?: string): void {
  const profile = cwd
    ? getWorkspaceProfileByTarget(canonicalRealpath(cwd))
    : getWorkspaceProfileForPath(repoPath);
  if (!profile) return;
  const real = canonicalRealpath(repoPath);
  if (profile.referenceRealpaths.some((root) => isPathContained(real, root))) {
    throw new Error(`Git operations cannot write neighbouring product repositories: ${real}`);
  }
}

let testPreflight: BubblewrapPreflight | null = null;

export function registerBubblewrapPreflightForTest(result: BubblewrapPreflight | null): void {
  testPreflight = result;
}

export function preflightBubblewrap(): BubblewrapPreflight {
  if (testPreflight) return testPreflight;
  try {
    const bwrap = execFileSync("command", ["-v", "bwrap"], { encoding: "utf-8" }).trim();
    if (!bwrap) {
      return {
        ok: false,
        code: "bwrap_unavailable",
        diagnostics: "bubblewrap (bwrap) is not installed. Linux user-namespace read-only mounts are required; no Mac sandbox substitute is used.",
      };
    }
    try {
      execFileSync(bwrap, ["--unshare-user", "--die-with-parent", "true"], { encoding: "utf-8", timeout: 5000 });
    } catch (error) {
      return {
        ok: false,
        code: "userns_unavailable",
        diagnostics: `bubblewrap user namespaces are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, bwrap };
  } catch {
    try {
      execSync("command -v bwrap", { encoding: "utf-8" });
    } catch {
      return {
        ok: false,
        code: "bwrap_unavailable",
        diagnostics: `bubblewrap (bwrap) is not available on ${process.platform}. Linux user-namespace read-only mounts are required for shell/program/validator execution. Do not disable this protection.`,
      };
    }
    return {
      ok: false,
      code: "userns_unavailable",
      diagnostics: "bwrap exists but user-namespace operation could not be verified.",
    };
  }
}

export function buildBubblewrapArgv(
  profile: WorkspaceProfile,
  command: { file: string; args: string[] },
): string[] {
  const argv = [
    "bwrap",
    "--unshare-user",
    "--die-with-parent",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
  ];
  if (existsSync("/lib64")) argv.push("--ro-bind", "/lib64", "/lib64");
  if (existsSync("/etc")) argv.push("--ro-bind", "/etc", "/etc");
  const targetRw = profile.phase === "implement" || profile.phase === "verify";
  argv.push(targetRw ? "--bind" : "--ro-bind", profile.targetRealpath, profile.targetRealpath);
  for (const ref of profile.referenceRealpaths) {
    argv.push("--ro-bind", ref, ref);
  }
  for (const cache of profile.cacheRealpaths) {
    argv.push("--bind", cache, cache);
  }
  argv.push("--", command.file, ...command.args);
  return argv;
}

export type ContractDiffFinding = {
  path: string;
  reason: string;
};

export function rejectOutOfContractTargetChanges(
  profile: WorkspaceProfile,
  changedRelativePaths: string[],
): ContractDiffFinding[] {
  const findings: ContractDiffFinding[] = [];
  for (const rel of changedRelativePaths) {
    const normalized = rel.replaceAll("\\", "/");
    if (normalized.startsWith(".gsd/") || normalized === ".gsd") continue;
    if (!matchesAllowedEdit(normalized, profile.allowedEdits)) {
      findings.push({
        path: normalized,
        reason: `Out-of-contract target change left in place (not deleted): ${normalized}`,
      });
    }
  }
  return findings;
}

export function listChangedRelativeFiles(root: string, before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path);
  }
  return changed;
}

export function snapshotFileHashes(root: string, files: string[]): Map<string, string> {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const out = new Map<string, string>();
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    out.set(rel.replaceAll("\\", "/"), createHash("sha256").update(readFileSync(abs)).digest("hex"));
  }
  return out;
}

function installWriteGuards(): void {
  void import("../../packages/pi-coding-agent/src/core/tools/write.ts")
    .then((mod) => {
      mod.setWritePathGuard((absolutePath: string, cwd: string) => {
        enforceNativeWrite(absolutePath, cwd);
      });
    })
    .catch(() => {
      // Write-tool package may be unavailable in isolated tests.
    });
  void import("../../packages/pi-coding-agent/src/core/tools/bash.ts")
    .then((mod) => {
      mod.setBashArgvGuard((cwd: string, file: string, args: string[]) => {
        const wrapped = wrapManagedCommand(cwd, file, args);
        if (!wrapped.ok) return { blocked: wrapped.diagnostics };
        return { file: wrapped.file, args: wrapped.args };
      });
    })
    .catch(() => {
      // Bash-tool package may be unavailable in isolated tests.
    });
}

export function resetWorkspaceProfilesForTest(): void {
  profiles.clear();
  phases.clear();
  testPreflight = null;
}

export function trustedGitAdminPath(worktree: string): string {
  const gitPath = join(worktree, ".git");
  if (!existsSync(gitPath)) return gitPath;
  const stat = lstatSync(gitPath);
  if (stat.isDirectory()) return canonicalRealpath(gitPath);
  const content = readFileSync(gitPath, "utf-8").trim();
  if (content.startsWith("gitdir: ")) {
    return canonicalRealpath(resolve(worktree, content.slice("gitdir: ".length).trim()));
  }
  return canonicalRealpath(gitPath);
}

export function readNeighbourFile(absolutePath: string, cwd?: string): string {
  const decision = evaluateRead(absolutePath, cwd);
  if (!decision.allow) throw new Error(decision.reason ?? "Read denied");
  return readFileSync(canonicalRealpath(absolutePath), "utf-8");
}
