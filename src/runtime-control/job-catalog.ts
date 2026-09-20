// Project/App: gsd-pi
// File Purpose: Durable job identity catalog. Not a scheduler.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import { unknownJob } from "./errors.ts";
import type { JobRecord } from "./types.ts";

export function parseJobId(jobId: string): { project_id: string; milestone_id: string } {
  const separator = jobId.indexOf(":");
  if (separator <= 0 || separator === jobId.length - 1) {
    throw unknownJob(`job_id must be project_id:milestone_id`);
  }
  return {
    project_id: jobId.slice(0, separator),
    milestone_id: jobId.slice(separator + 1),
  };
}

export function defaultSpecId(projectId: string, milestoneId: string): string {
  return `${projectId}--${milestoneId}`;
}

export class JobCatalog {
  private jobs = new Map<string, JobRecord>();
  private readonly path: string;
  private revisionListener: ((job: JobRecord) => void) | null = null;

  constructor(stateRoot?: string) {
    this.path = stateRoot ? join(stateRoot, "runtime-control", "jobs.json") : "";
    if (this.path) this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as { jobs?: JobRecord[] };
      for (const job of parsed.jobs ?? []) {
        this.jobs.set(job.job_id, job);
      }
    } catch {
      // Reconcile from empty; writers will recreate.
    }
  }

  private persist(): void {
    if (!this.path) return;
    atomicWriteJson(this.path, { jobs: [...this.jobs.values()] });
  }

  seed(job: JobRecord): JobRecord {
    const expectedId = `${job.project_id}:${job.milestone_id}`;
    if (job.job_id !== expectedId) {
      throw unknownJob(`job_id ${job.job_id} does not match ${expectedId}`);
    }
    const stored = { ...job, spec_id: job.spec_id ?? defaultSpecId(job.project_id, job.milestone_id) };
    this.jobs.set(job.job_id, stored);
    this.persist();
    return stored;
  }

  onRevisionBump(listener: ((job: JobRecord) => void) | null): void {
    this.revisionListener = listener;
  }

  bumpRevision(jobId: string): JobRecord {
    const job = this.require(jobId);
    job.revision += 1;
    this.jobs.set(jobId, job);
    this.persist();
    this.revisionListener?.(job);
    return job;
  }

  patch(jobId: string, fields: Partial<JobRecord>): JobRecord {
    const job = this.require(jobId);
    const next = { ...job, ...fields, job_id: job.job_id, project_id: job.project_id, milestone_id: job.milestone_id };
    this.jobs.set(jobId, next);
    this.persist();
    return next;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  require(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw unknownJob(`Unknown job ${jobId}`);
    return job;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  findByDigest(projectId: string, importDigest: string): JobRecord | undefined {
    return this.list().find((job) => job.project_id === projectId && job.import_digest === importDigest);
  }

  findBySpecId(specId: string): JobRecord | undefined {
    return this.list().find((job) => job.spec_id === specId);
  }

  clear(): void {
    this.jobs.clear();
    this.persist();
  }
}
