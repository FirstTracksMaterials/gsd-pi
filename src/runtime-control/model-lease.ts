// Project/App: gsd-pi
// File Purpose: One global model-admission lease across registered projects.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";

export type LeaseRecord = {
  operation_id: string;
  job_id: string | null;
  action: string;
  acquired_at: string;
  recovery_required: boolean;
};

export class ModelLease {
  private record: LeaseRecord | null = null;
  private readonly path: string;

  constructor(stateRoot: string) {
    this.path = join(stateRoot, "runtime-control", "lease.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.record = null;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as { lease?: LeaseRecord | null };
      this.record = parsed.lease ?? null;
    } catch {
      this.record = null;
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, { lease: this.record });
  }

  current(): LeaseRecord | null {
    return this.record;
  }

  isHeld(): boolean {
    return this.record !== null;
  }

  acquire(record: LeaseRecord): void {
    this.record = record;
    this.persist();
  }

  release(operationId?: string): void {
    if (operationId && this.record && this.record.operation_id !== operationId) return;
    this.record = null;
    this.persist();
  }

  retainForRecovery(operationId: string): void {
    if (!this.record) return;
    if (this.record.operation_id === operationId) {
      this.record = { ...this.record, recovery_required: true };
      this.persist();
    }
  }
}
