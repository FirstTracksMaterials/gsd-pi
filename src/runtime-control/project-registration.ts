// Project/App: gsd-pi
// File Purpose: Validated, durable onboarding of explicitly described projects.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import type { AdmissionHost } from "./admission.ts";
import { invalidRequest, revisionConflict, RuntimeControlError, runtimeUnavailable } from "./errors.ts";
import { parseProjectRegistration, resolveProjectRegistration } from "./registration.ts";
import type { ProjectRegistration, RegistrationFile } from "./types.ts";

const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_POLICY = "ftm-science/v1";

export type ProjectRegistrationResult = {
  project: {
    project_id: string;
    target_worktree: string;
    source_repository: string | null;
    required_policy: string;
  };
  idempotent: boolean;
};

function registrationFile(host: AdmissionHost): { path: string; file: RegistrationFile } {
  const path = host.registration.path;
  if (!path || path === "<memory>") {
    throw runtimeUnavailable("Dynamic project registration requires a managed registration file");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw runtimeUnavailable(`Registration file is missing: ${path}`);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RegistrationFile;
    return { path, file: { ...parsed, projects: Array.isArray(parsed.projects) ? parsed.projects : [] } };
  } catch (error) {
    throw runtimeUnavailable(`Registration file is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trustedRoots(file: RegistrationFile): string[] {
  const roots = (file.trusted_project_roots ?? []).map((root) => realpathSync(resolve(root)));
  if (roots.length === 0) throw invalidRequest("No trusted project roots are configured");
  return roots;
}

function assertTrustedPath(path: string, roots: string[], field: string): string {
  if (!isAbsolute(path) || path.includes("~") || path.includes("$")) {
    throw invalidRequest(`${field} must be an absolute path without shell expansion`);
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw invalidRequest(`${field} does not exist`);
  const canonical = realpathSync(resolved);
  const allowed = roots.some((root) => {
    const rel = relative(root, canonical);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw invalidRequest(`${field} is outside the configured trusted project roots`);
  return canonical;
}

function normalizeDescriptor(raw: unknown, file: RegistrationFile): ProjectRegistration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidRequest("Project descriptor must be an object");
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) throw invalidRequest("Project descriptor version must be 1");
  if (typeof record.project_id !== "string" || !PROJECT_ID_RE.test(record.project_id)) {
    throw invalidRequest("project_id must contain lowercase letters, digits, and hyphens");
  }
  if (record.required_policy !== REQUIRED_POLICY) {
    throw invalidRequest(`required_policy must be ${REQUIRED_POLICY}`);
  }
  const roots = trustedRoots(file);
  const target = assertTrustedPath(String(record.target_worktree ?? ""), roots, "target_worktree");
  const source = assertTrustedPath(String(record.source_repo ?? record.source_repository ?? target), roots, "source_repo");
  if (!existsSync(target) || !statSync(target).isDirectory() || !existsSync(join(target, ".git"))) {
    throw invalidRequest("target_worktree must be an existing Git repository");
  }
  if (!existsSync(source) || !statSync(source).isDirectory() || !existsSync(join(source, ".git"))) {
    throw invalidRequest("source_repo must be an existing Git repository");
  }
  const contractRoot = typeof record.contract_root === "string" ? record.contract_root.trim() : ".gsd/ftm/contracts";
  if (!contractRoot || isAbsolute(contractRoot) || contractRoot.split(/[\\/]+/).includes("..")) {
    throw invalidRequest("contract_root must be a relative path within target_worktree");
  }
  const contractPath = join(target, contractRoot);
  if (!existsSync(contractPath)) {
    throw invalidRequest("contract_root does not exist beneath target_worktree");
  }
  assertTrustedPath(contractPath, [target], "contract_root");
  const references = Array.isArray(record.reference_repositories) ? record.reference_repositories : [];
  for (const [index, entry] of references.entries()) {
    if (!entry || typeof entry !== "object") throw invalidRequest(`reference_repositories[${index}] must be an object`);
    assertTrustedPath(String((entry as Record<string, unknown>).root ?? ""), roots, `reference_repositories[${index}].root`);
  }
  const caches = Array.isArray(record.writable_cache_roots) ? record.writable_cache_roots : [];
  for (const [index, cache] of caches.entries()) {
    assertTrustedPath(String(cache ?? ""), roots, `writable_cache_roots[${index}]`);
  }
  const template = file.projects[0];
  return parseProjectRegistration({
    project_id: record.project_id,
    target_worktree: target,
    source_repository: source,
    contract_root: contractRoot,
    reference_repositories: references,
    writable_cache_roots: caches,
    required_policy: REQUIRED_POLICY,
    provider: template?.provider ?? null,
    backend_idle_probe: template?.backend_idle_probe ?? null,
    backend_binding: template?.backend_binding ?? null,
  });
}

function sameProject(existing: ReturnType<typeof resolveProjectRegistration>, proposed: ReturnType<typeof resolveProjectRegistration>): boolean {
  return existing.target_realpath === proposed.target_realpath
    && (existing.source_repository ?? null) === (proposed.source_repository ?? null)
    && existing.contract_root === proposed.contract_root
    && existing.required_policy === proposed.required_policy;
}

export async function admitProjectRegistration(host: AdmissionHost, raw: unknown): Promise<ProjectRegistrationResult> {
  return host.store.withWriter(() => {
    const { path, file } = registrationFile(host);
    const proposed = normalizeDescriptor(raw, file);
    const resolved = resolveProjectRegistration(proposed);
    const existing = host.registration.getById(proposed.project_id);
    if (existing) {
      if (!sameProject(existing, resolved)) {
        throw revisionConflict(`Project ${proposed.project_id} is already registered with different paths or policy`);
      }
      return {
        project: {
          project_id: existing.project_id,
          target_worktree: existing.target_worktree,
          source_repository: existing.source_repository ?? null,
          required_policy: existing.required_policy,
        },
        idempotent: true,
      };
    }
    atomicWriteJson(path, { ...file, projects: [...file.projects, proposed] });
    try {
      host.registration.reload();
    } catch (error) {
      atomicWriteJson(path, file);
      host.registration.reload();
      throw error;
    }
    const registered = host.registration.getById(proposed.project_id);
    if (!registered) throw runtimeUnavailable(`Project ${proposed.project_id} was not visible after registration`);
    return {
      project: {
        project_id: registered.project_id,
        target_worktree: registered.target_worktree,
        source_repository: registered.source_repository ?? null,
        required_policy: registered.required_policy,
      },
      idempotent: false,
    };
  }).catch((error) => {
    if (error instanceof RuntimeControlError) throw error;
    throw runtimeUnavailable(error instanceof Error ? error.message : String(error));
  });
}
