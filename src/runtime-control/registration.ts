// Project/App: gsd-pi
// File Purpose: Read-only FTM project registration. Clients submit IDs, never arbitrary cwd.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  clearProjectRequiredPolicy,
  configureProjectRequiredPolicy,
} from "../resources/extensions/gsd/required-policy.ts";
import { assertSharedBindingDigest, parseBackendBinding } from "./backend-binding.ts";
import { invalidRequest, runtimeUnavailable } from "./errors.ts";
import type { LeaseAdmissionGate } from "./model-lease.ts";
import type { BackendBinding, ProjectRegistration, RegistrationFile, ResolvedProject } from "./types.ts";
import { buildWorkspaceProfile, registerWorkspaceProfile, unregisterWorkspaceProfile } from "./workspace-profile.ts";

export const REGISTRATION_ENV = "GSD_RUNTIME_REGISTRATION";

function canonicalRealpath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`Registration field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseProject(raw: unknown): ProjectRegistration {
  if (!raw || typeof raw !== "object") {
    throw invalidRequest("Each registration project must be an object");
  }
  const record = raw as Record<string, unknown>;
  const referencesRaw = Array.isArray(record.reference_repositories) ? record.reference_repositories : [];
  const cacheRaw = Array.isArray(record.writable_cache_roots) ? record.writable_cache_roots : [];
  return {
    project_id: asString(record.project_id, "project_id"),
    target_worktree: asString(record.target_worktree, "target_worktree"),
    contract_root: typeof record.contract_root === "string" && record.contract_root.trim()
      ? record.contract_root.trim()
      : ".gsd/ftm/contracts",
    reference_repositories: referencesRaw.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw invalidRequest(`reference_repositories[${index}] must be an object`);
      }
      const ref = entry as Record<string, unknown>;
      return {
        project_id: asString(ref.project_id, `reference_repositories[${index}].project_id`),
        root: asString(ref.root, `reference_repositories[${index}].root`),
      };
    }),
    writable_cache_roots: cacheRaw.map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw invalidRequest(`writable_cache_roots[${index}] must be a non-empty string`);
      }
      return entry.trim();
    }),
    required_policy: asString(record.required_policy, "required_policy"),
    provider: typeof record.provider === "string" ? record.provider : null,
    backend_idle_probe: typeof record.backend_idle_probe === "string" ? record.backend_idle_probe : null,
    backend_binding: parseOptionalBinding(record.backend_binding, record.backend_idle_probe),
  };
}

function parseOptionalBinding(raw: unknown, probe: unknown): BackendBinding | null {
  if (raw === undefined || raw === null) return null;
  const binding = parseBackendBinding(raw);
  if (typeof probe === "string" && probe.trim() && probe.trim() !== binding.slot_probe_url) {
    throw invalidRequest("backend_idle_probe does not match the backend binding");
  }
  return binding;
}

function resolveProject(project: ProjectRegistration): ResolvedProject {
  if (project.target_worktree.includes("~") || project.target_worktree.includes("$")) {
    throw invalidRequest(`target_worktree for ${project.project_id} must be an absolute path; JSON does not expand ~ or $HOME`);
  }
  const target = canonicalRealpath(project.target_worktree);
  const references = project.reference_repositories.map((ref) => {
    if (ref.root.includes("~") || ref.root.includes("$")) {
      throw invalidRequest(`reference root for ${ref.project_id} must be an absolute path`);
    }
    return { ...ref, realpath: canonicalRealpath(ref.root) };
  });
  return {
    project_id: project.project_id,
    target_worktree: resolve(project.target_worktree),
    target_realpath: target,
    contract_root: project.contract_root,
    reference_repositories: references,
    writable_cache_roots: project.writable_cache_roots.map((root) => canonicalRealpath(root)),
    required_policy: project.required_policy,
    provider: project.backend_binding?.provider ?? project.provider ?? null,
    backend_idle_probe: project.backend_binding?.slot_probe_url ?? project.backend_idle_probe ?? null,
    backend_binding: project.backend_binding ?? null,
  };
}

function assertNoOverlap(projects: ResolvedProject[]): void {
  const seenIds = new Set<string>();
  const seenRoots = new Map<string, string>();
  for (const project of projects) {
    if (seenIds.has(project.project_id)) {
      throw invalidRequest(`Duplicate project_id ${project.project_id}`);
    }
    seenIds.add(project.project_id);
    const local: Array<{ id: string; path: string }> = [
      { id: "target", path: project.target_realpath },
      ...project.reference_repositories.map((ref) => ({ id: `reference:${ref.project_id}`, path: ref.realpath })),
    ];
    for (let i = 0; i < local.length; i++) {
      for (let j = i + 1; j < local.length; j++) {
        const a = local[i]!;
        const b = local[j]!;
        if (a.path === b.path) {
          throw invalidRequest(`Overlapping or aliased workspace roots ${a.id} and ${b.id} at ${a.path}`);
        }
        const aPrefix = a.path.endsWith("/") ? a.path : `${a.path}/`;
        const bPrefix = b.path.endsWith("/") ? b.path : `${b.path}/`;
        if (a.path.startsWith(bPrefix) || b.path.startsWith(aPrefix)) {
          throw invalidRequest(`Nested workspace roots make the write target ambiguous: ${a.id} vs ${b.id}`);
        }
      }
    }
    const roots = [project.target_realpath, ...project.reference_repositories.map((ref) => ref.realpath)];
    for (const root of roots) {
      const owner = seenRoots.get(root);
      if (owner && owner !== project.project_id) {
        throw invalidRequest(`Overlapping or aliased root ${root} between ${owner} and ${project.project_id}`);
      }
      seenRoots.set(root, project.project_id);
    }
  }
}

export class RegistrationRegistry {
  private projects = new Map<string, ResolvedProject>();
  private byRealpath = new Map<string, ResolvedProject>();
  private sourcePath: string | null = null;
  private loadError: string | null = null;
  private readonly leaseGate: () => LeaseAdmissionGate;

  constructor(leaseGate: () => LeaseAdmissionGate) {
    this.leaseGate = leaseGate;
  }

  get path(): string | null {
    return this.sourcePath;
  }

  get error(): string | null {
    return this.loadError;
  }

  list(): ResolvedProject[] {
    return [...this.projects.values()];
  }

  getById(projectId: string): ResolvedProject | undefined {
    return this.projects.get(projectId);
  }

  getByCwd(cwd: string): ResolvedProject | undefined {
    return this.byRealpath.get(canonicalRealpath(cwd));
  }

  loadFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const path = env[REGISTRATION_ENV];
    if (!path || !path.trim()) {
      this.replace([], null, null);
      return;
    }
    this.loadFromPath(path.trim());
  }

  loadFromPath(path: string): void {
    if (!existsSync(path) || !statSync(path).isFile()) {
      this.replace([], path, `Registration file is missing: ${path}`);
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as RegistrationFile;
      const projects = Array.isArray(parsed.projects) ? parsed.projects.map(parseProject).map(resolveProject) : [];
      assertNoOverlap(projects);
      this.replace(projects, path, null);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      this.replace([], path, error instanceof Error ? error.message : String(error));
    }
  }

  loadFromObject(file: RegistrationFile, sourcePath = "<memory>"): void {
    const projects = (file.projects ?? []).map(parseProject).map(resolveProject);
    assertNoOverlap(projects);
    this.replace(projects, sourcePath, null);
  }

  reload(): void {
    if (this.sourcePath && this.sourcePath !== "<memory>" && existsSync(this.sourcePath)) {
      this.loadFromPath(this.sourcePath);
      return;
    }
    this.loadFromEnv();
  }

  clear(): void {
    this.replace([], null, null);
  }

  private assertInstallable(projects: ResolvedProject[]): void {
    const digest = assertSharedBindingDigest(projects.map((project) => project.backend_binding?.digest ?? null));
    const gate = this.leaseGate();
    if (gate.unknown) {
      throw runtimeUnavailable("Registration load refused while lease ownership is unknown");
    }
    if (gate.held && digest !== gate.bindingDigest) {
      throw runtimeUnavailable("Backend binding change refused while a model operation is held");
    }
  }

  private replace(projects: ResolvedProject[], sourcePath: string | null, loadError: string | null): void {
    this.assertInstallable(projects);
    for (const existing of this.projects.values()) {
      clearProjectRequiredPolicy(existing.target_realpath);
      unregisterWorkspaceProfile(existing.target_realpath);
    }
    this.projects.clear();
    this.byRealpath.clear();
    this.sourcePath = sourcePath;
    this.loadError = loadError;
    for (const project of projects) {
      this.projects.set(project.project_id, project);
      this.byRealpath.set(project.target_realpath, project);
      configureProjectRequiredPolicy(project.target_realpath, project.required_policy);
      registerWorkspaceProfile(buildWorkspaceProfile(project, { phase: "implement" }));
    }
  }
}
