// Project/App: gsd-pi
// File Purpose: Generic create/import milestone behind POST /projects/{id}/jobs.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { invalidRequest, requestIdConflict, revisionConflict, RuntimeControlError } from "./errors.ts";
import { fingerprintImport } from "./fingerprint.ts";
import { defaultSpecId } from "./job-catalog.ts";
import { atomicWriteJson } from "./atomic-json.ts";
import type { AdmissionHost } from "./admission.ts";
import type { JobRecord, Operation, ResolvedProject, StoredOperation } from "./types.ts";

export const IMPORT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export type JobImportDocument = {
  path: string;
  content: string;
  sha256: string;
};

export type JobImport = {
  protocol_version: 1;
  request_id: string;
  import_digest: string;
  spec_id: string | null;
  title: string;
  source: { kind: "prompt" | "legacy"; path: string; sha256: string };
  tasks: unknown[];
  source_job_status: string;
  documents: JobImportDocument[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NativeImportWriter = (input: {
  project: ResolvedProject;
  milestoneId: string;
  title: string;
  documents: JobImportDocument[];
}) => { milestoneId: string; revision: number };

let importWriter: NativeImportWriter | null = null;

export function registerImportWriterForTest(writer: NativeImportWriter | null): void {
  importWriter = writer;
}

export function resetImportWriterForTest(): void {
  importWriter = null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function parseJobImport(raw: unknown): JobImport {
  if (!raw || typeof raw !== "object") throw invalidRequest("JobImport must be a JSON object");
  const record = raw as Record<string, unknown>;
  if (record.protocol_version !== 1) throw invalidRequest("protocol_version must be 1");
  if (typeof record.request_id !== "string" || !UUID_RE.test(record.request_id)) {
    throw invalidRequest("request_id must be a UUID");
  }
  if (typeof record.import_digest !== "string" || !record.import_digest.trim()) {
    throw invalidRequest("import_digest is required");
  }
  if (record.spec_id !== null && typeof record.spec_id !== "string") {
    throw invalidRequest("spec_id must be a string or null");
  }
  if (typeof record.title !== "string" || !record.title.trim()) throw invalidRequest("title is required");
  if (!record.source || typeof record.source !== "object") throw invalidRequest("source is required");
  const source = record.source as Record<string, unknown>;
  if (source.kind !== "prompt" && source.kind !== "legacy") throw invalidRequest("source.kind must be prompt or legacy");
  if (typeof source.path !== "string" || typeof source.sha256 !== "string") {
    throw invalidRequest("source.path and source.sha256 are required");
  }
  if (!Array.isArray(record.tasks)) throw invalidRequest("tasks must be an array");
  if (typeof record.source_job_status !== "string") throw invalidRequest("source_job_status is required");
  if (!Array.isArray(record.documents)) throw invalidRequest("documents must be an array");
  const documents = record.documents.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw invalidRequest(`documents[${index}] must be an object`);
    const doc = entry as Record<string, unknown>;
    if (typeof doc.path !== "string" || typeof doc.content !== "string" || typeof doc.sha256 !== "string") {
      throw invalidRequest(`documents[${index}] requires path, content, sha256`);
    }
    if (!/^[0-9a-f]{64}$/.test(doc.sha256)) throw invalidRequest(`documents[${index}].sha256 must be SHA256 hex`);
    if (sha256(doc.content) !== doc.sha256) {
      throw invalidRequest(`documents[${index}] SHA256 does not match content`);
    }
    if (doc.path.includes("..") || doc.path.startsWith("/") || doc.path.includes("\\")) {
      throw invalidRequest(`documents[${index}].path is metadata relative to the source spec, not a server file`);
    }
    return { path: doc.path, content: doc.content, sha256: doc.sha256 };
  });
  return {
    protocol_version: 1,
    request_id: record.request_id,
    import_digest: record.import_digest.trim(),
    spec_id: record.spec_id,
    title: record.title.trim(),
    source: { kind: source.kind, path: source.path, sha256: source.sha256 },
    tasks: record.tasks,
    source_job_status: record.source_job_status,
    documents,
  };
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nextMilestoneId(existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = /^M(\d+)/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `M${String(max + 1).padStart(3, "0")}`;
}

function writeImportDocuments(project: ResolvedProject, digest: string, documents: JobImportDocument[]): void {
  const root = join(project.target_realpath, ".gsd", "imports", digest);
  for (const doc of documents) {
    const dest = join(root, doc.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, doc.content, "utf-8");
  }
}

function identityPath(project: ResolvedProject, digest: string): string {
  return join(project.target_realpath, ".gsd", "imports", digest, "identity.json");
}

function readPersistedIdentity(project: ResolvedProject, digest: string): { milestoneId: string; specId: string } | null {
  const path = identityPath(project, digest);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { milestoneId?: string; specId?: string };
    if (parsed.milestoneId && parsed.specId) return { milestoneId: parsed.milestoneId, specId: parsed.specId };
  } catch {
    // Recreate identity on the next write.
  }
  return null;
}

function nativeWriteMilestone(input: {
  project: ResolvedProject;
  milestoneId: string;
  specId: string;
  digest: string;
  title: string;
  documents: JobImportDocument[];
}): { milestoneId: string; revision: number } {
  if (importWriter) {
    return importWriter({
      project: input.project,
      milestoneId: input.milestoneId,
      title: input.title,
      documents: input.documents,
    });
  }
  atomicWriteJson(identityPath(input.project, input.digest), {
    milestoneId: input.milestoneId,
    specId: input.specId,
    title: input.title,
  });
  writeImportDocuments(input.project, input.digest, input.documents);
  try {
    // Runtime-v1 JobImport is not GSD markdown Import Application
    // (applyLegacyImport requires preview/backup/consent). Identity is
    // insertMilestone plus the durable catalog fingerprint.
    const gsdDb = require("../resources/extensions/gsd/gsd-db.js") as {
      insertMilestone?: (row: { id: string; title: string; status: string }) => boolean;
    };
    gsdDb.insertMilestone?.({ id: input.milestoneId, title: input.title, status: "queued" });
  } catch {
    // Catalog identity is still recorded when the project DB is not open.
  }
  return { milestoneId: input.milestoneId, revision: 1 };
}

const ACTIVE_OR_COMPLETED = new Set(["running", "prepared", "completed", "active"]);

export async function admitImport(
  host: AdmissionHost,
  projectId: string,
  raw: unknown,
  bodyBytes?: number,
): Promise<{ ok: true; status: 202; operation: Operation } | { ok: false; status: number; body: { error: import("./types.ts").RuntimeError } }> {
  try {
    return await host.store.withWriter(() => admitImportLocked(host, projectId, raw, bodyBytes));
  } catch (error) {
    if (error instanceof RuntimeControlError) {
      return { ok: false, status: error.status, body: error.body };
    }
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          code: "runtime_unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      },
    };
  }
}

async function admitImportLocked(
  host: AdmissionHost,
  projectId: string,
  raw: unknown,
  bodyBytes?: number,
): Promise<{ ok: true; status: 202; operation: Operation }> {
  if (typeof bodyBytes === "number" && bodyBytes > IMPORT_BODY_LIMIT_BYTES) {
    throw invalidRequest("Import body exceeds 8 MiB; use registered hashed references");
  }
  const decodedProjectId = decodeURIComponent(projectId);
  const project = host.registration.getById(decodedProjectId);
  if (!project) throw invalidRequest(`Project ${decodedProjectId} is not registered`);
  const parsed = parseJobImport(raw);
  const fingerprint = fingerprintImport({
    project_id: decodedProjectId,
    import_digest: parsed.import_digest,
    payload: { ...parsed, request_id: undefined },
  });

  const existing = host.store.lookupByRequest(parsed.request_id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw requestIdConflict("Same request_id with a different fingerprint", existing.operation.operation_id);
    }
    if (existing.operation.state === "succeeded" && existing.operation.job_id) {
      return { ok: true, status: 202, operation: existing.operation };
    }
  }

  const digestMatch = host.jobs.findByDigest(decodedProjectId, parsed.import_digest);
  if (digestMatch) {
    if (digestMatch.import_fingerprint && digestMatch.import_fingerprint !== fingerprint) {
      throw revisionConflict(
        `Changed import data cannot overwrite ${ACTIVE_OR_COMPLETED.has(digestMatch.status ?? "") ? "an active or completed" : "an existing"} milestone ${digestMatch.milestone_id} without explicit replan`,
      );
    }
    const admittedAt = nowIso(host.clock);
    const operationId = existing?.operation.operation_id ?? randomUUID();
    const operation: Operation = {
      protocol_version: 1,
      operation_id: operationId,
      request_id: parsed.request_id,
      job_id: digestMatch.job_id,
      action: "import",
      state: "succeeded",
      admitted_at: existing?.operation.admitted_at ?? admittedAt,
      updated_at: admittedAt,
      result: {
        kind: "import",
        job_id: digestMatch.job_id,
        milestone_id: digestMatch.milestone_id,
        spec_id: digestMatch.spec_id,
        import_digest: parsed.import_digest,
        idempotent: true,
      },
      error: null,
      target_operation_id: null,
    };
    const stored: StoredOperation = {
      operation,
      fingerprint,
      kind: "import",
      dispatch_intent: false,
    };
    if (existing) host.store.update(stored);
    else host.store.writeAccepted(stored);
    return { ok: true, status: 202, operation: stored.operation };
  }

  if (parsed.spec_id) {
    const collision = host.jobs.findBySpecId(parsed.spec_id);
    if (collision && collision.project_id !== decodedProjectId) {
      throw invalidRequest(`spec_id ${parsed.spec_id} already aliases ${collision.job_id}`);
    }
    if (collision && collision.import_digest && collision.import_digest !== parsed.import_digest) {
      const status = collision.status ?? "queued";
      if (ACTIVE_OR_COMPLETED.has(status) || status === "completed") {
        throw revisionConflict(
          `Changed import data cannot overwrite active or completed milestone ${collision.milestone_id} without explicit replan`,
        );
      }
    }
  }

  const persisted = readPersistedIdentity(project, parsed.import_digest);
  const milestoneId = persisted?.milestoneId
    ?? nextMilestoneId(host.jobs.list().filter((job) => job.project_id === decodedProjectId).map((job) => job.milestone_id));
  const specId = persisted?.specId ?? parsed.spec_id ?? defaultSpecId(decodedProjectId, milestoneId);
  if (host.jobs.findBySpecId(specId) && !digestMatch) {
    throw invalidRequest(`spec_id ${specId} is not unique across registered projects`);
  }

  const admittedAt = nowIso(host.clock);
  const operationId = existing?.operation.operation_id ?? randomUUID();
  const operation: Operation = existing?.operation ?? {
    protocol_version: 1,
    operation_id: operationId,
    request_id: parsed.request_id,
    job_id: null,
    action: "import",
    state: "accepted",
    admitted_at: admittedAt,
    updated_at: admittedAt,
    result: null,
    error: null,
    target_operation_id: null,
  };
  const stored: StoredOperation = existing ?? {
    operation,
    fingerprint,
    kind: "import",
    dispatch_intent: false,
  };
  if (!existing) host.store.writeAccepted(stored);

  const written = nativeWriteMilestone({
    project,
    milestoneId,
    specId,
    digest: parsed.import_digest,
    title: parsed.title,
    documents: parsed.documents,
  });
  const job: JobRecord = {
    job_id: `${decodedProjectId}:${written.milestoneId}`,
    project_id: decodedProjectId,
    milestone_id: written.milestoneId,
    revision: written.revision,
    authority_epoch: 1,
    spec_id: specId,
    import_digest: parsed.import_digest,
    import_fingerprint: fingerprint,
    status: parsed.source_job_status || "queued",
  };
  host.jobs.seed(job);
  stored.operation.job_id = job.job_id;
  stored.operation.state = "succeeded";
  stored.operation.updated_at = nowIso(host.clock);
  stored.operation.result = {
    kind: "import",
    job_id: job.job_id,
    milestone_id: job.milestone_id,
    spec_id: job.spec_id,
    import_digest: parsed.import_digest,
    source_mapping: { spec_id: specId, source_path: parsed.source.path },
  };
  host.store.update(stored);
  return { ok: true, status: 202, operation: stored.operation };
}
