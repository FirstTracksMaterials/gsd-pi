// Project/App: gsd-pi
// File Purpose: Lightweight job catalog for admission revision/epoch checks. Not a scheduler.

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

export class JobCatalog {
  private jobs = new Map<string, JobRecord>();

  seed(job: JobRecord): JobRecord {
    const expectedId = `${job.project_id}:${job.milestone_id}`;
    if (job.job_id !== expectedId) {
      throw unknownJob(`job_id ${job.job_id} does not match ${expectedId}`);
    }
    this.jobs.set(job.job_id, { ...job });
    return this.jobs.get(job.job_id)!;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  require(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw unknownJob(`Unknown job ${jobId}`);
    return job;
  }

  clear(): void {
    this.jobs.clear();
  }
}
