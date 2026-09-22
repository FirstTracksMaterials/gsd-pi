// Project/App: gsd-pi
// File Purpose: One global model-admission lease across registered projects.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import { parseBackendBinding } from "./backend-binding.ts";
import type { BackendBinding } from "./types.ts";

export type LeaseRecord = {
  operation_id: string;
  job_id: string | null;
  action: string;
  acquired_at: string;
  recovery_required: boolean;
  backend_binding?: BackendBinding | null;
};

export type LeaseAdmissionGate = {
  held: boolean;
  unknown: boolean;
  bindingDigest: string | null;
};

type LeaseState =
  | { kind: "empty" }
  | { kind: "held"; record: LeaseRecord }
  | { kind: "unknown"; reason: string };

export class ModelLease {
  private state: LeaseState = { kind: "empty" };
  private readonly path: string;

  constructor(stateRoot: string) {
    this.path = join(stateRoot, "runtime-control", "lease.json");
    this.load();
  }

  get filePath(): string {
    return this.path;
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.state = { kind: "empty" };
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      this.state = { kind: "unknown", reason: "lease.json is not valid JSON" };
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.state = { kind: "unknown", reason: "lease.json is not an object" };
      return;
    }
    const lease = (parsed as { lease?: unknown }).lease;
    if (lease === null || lease === undefined) {
      this.state = { kind: "empty" };
      return;
    }
    if (typeof lease !== "object" || Array.isArray(lease)) {
      this.state = { kind: "unknown", reason: "lease.json lease is not a record" };
      return;
    }
    const record = lease as Partial<LeaseRecord> & { backend_binding?: unknown };
    if (typeof record.operation_id !== "string" || !record.operation_id.trim()) {
      this.state = { kind: "unknown", reason: "lease.json is missing operation_id" };
      return;
    }
    let binding: BackendBinding | null = null;
    if (record.backend_binding !== undefined && record.backend_binding !== null) {
      try {
        binding = parseBackendBinding(record.backend_binding);
      } catch {
        this.state = { kind: "unknown", reason: "lease.json backend binding is unreadable" };
        return;
      }
    }
    this.state = {
      kind: "held",
      record: {
        operation_id: record.operation_id,
        job_id: typeof record.job_id === "string" || record.job_id === null ? record.job_id : null,
        action: typeof record.action === "string" ? record.action : "unknown",
        acquired_at: typeof record.acquired_at === "string" ? record.acquired_at : "",
        recovery_required: record.recovery_required === true,
        backend_binding: binding,
      },
    };
  }

  private persist(): void {
    const record = this.state.kind === "held" ? this.state.record : null;
    atomicWriteJson(this.path, { lease: record });
  }

  ownershipUnknown(): boolean {
    return this.state.kind === "unknown";
  }

  unknownReason(): string | null {
    return this.state.kind === "unknown" ? this.state.reason : null;
  }

  admissionGate(): LeaseAdmissionGate {
    if (this.state.kind === "unknown") {
      return { held: false, unknown: true, bindingDigest: null };
    }
    if (this.state.kind === "held") {
      return {
        held: true,
        unknown: false,
        bindingDigest: this.state.record.backend_binding?.digest ?? null,
      };
    }
    return { held: false, unknown: false, bindingDigest: null };
  }

  current(): LeaseRecord | null {
    return this.state.kind === "held" ? this.state.record : null;
  }

  isHeld(): boolean {
    return this.state.kind === "held";
  }

  acquire(record: LeaseRecord): void {
    if (this.state.kind === "unknown") {
      throw new Error("Refusing to replace an unreadable lease");
    }
    this.state = { kind: "held", record };
    this.persist();
  }

  release(operationId?: string): void {
    if (this.state.kind !== "held") return;
    if (operationId && this.state.record.operation_id !== operationId) return;
    this.state = { kind: "empty" };
    this.persist();
  }

  retainForRecovery(operationId: string): void {
    if (this.state.kind !== "held") return;
    if (this.state.record.operation_id !== operationId) return;
    this.state = {
      kind: "held",
      record: { ...this.state.record, recovery_required: true },
    };
    this.persist();
  }
}
