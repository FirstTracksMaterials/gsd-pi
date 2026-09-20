// Project/App: gsd-pi
// File Purpose: Explicit recovery IDs from native diagnostics. Never auto-replay shell.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";

export type RecoveryRecord = {
  recovery_id: string;
  operation_id: string;
  job_id: string | null;
  reason: string;
  issued_at: string;
  next_state: string;
  applied: boolean;
};

const records = new Map<string, RecoveryRecord>();
let diagnosticsDir: string | null = null;

export function configureRecoveryStore(stateRoot: string): void {
  diagnosticsDir = join(stateRoot, "runtime-control", "recovery");
}

export function issueRecoveryId(input: {
  operation_id: string;
  job_id: string | null;
  reason: string;
  issued_at: string;
  next_state?: string;
}): RecoveryRecord {
  const record: RecoveryRecord = {
    recovery_id: randomUUID(),
    operation_id: input.operation_id,
    job_id: input.job_id,
    reason: input.reason,
    issued_at: input.issued_at,
    next_state: input.next_state ?? "idle",
    applied: false,
  };
  records.set(record.recovery_id, record);
  persist(record);
  return record;
}

export function getRecovery(recoveryId: string): RecoveryRecord | undefined {
  const existing = records.get(recoveryId);
  if (existing) return existing;
  if (!diagnosticsDir) return undefined;
  const path = join(diagnosticsDir, `${recoveryId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RecoveryRecord;
    records.set(parsed.recovery_id, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export function applyRecovery(recoveryId: string): RecoveryRecord {
  const record = getRecovery(recoveryId);
  if (!record) {
    throw new Error(`Unknown recovery_id ${recoveryId}; recover only applies diagnostic IDs`);
  }
  if (record.applied) return record;
  record.applied = true;
  persist(record);
  return record;
}

function persist(record: RecoveryRecord): void {
  if (!diagnosticsDir) return;
  atomicWriteJson(join(diagnosticsDir, `${record.recovery_id}.json`), record);
}

export function listRecoveries(): RecoveryRecord[] {
  return [...records.values()];
}

export function latestOpenRecoveryForJob(jobId: string): RecoveryRecord | undefined {
  const matches = listRecoveries().filter((record) => record.job_id === jobId && !record.applied);
  return matches.at(-1);
}

export function resetRecoveryForTest(): void {
  records.clear();
  diagnosticsDir = null;
}
