// Project/App: gsd-pi
// File Purpose: Canonical request fingerprints including route kind (R4, R11).

import { createHash } from "node:crypto";

import type { CommandRequest, OperationKind } from "./types.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonical(record[key]);
    }
    return out;
  }
  return value;
}

export function fingerprintCommand(input: {
  kind: OperationKind;
  job_id: string;
  request: Pick<CommandRequest, "action" | "parameters" | "expected_revision" | "expected_epoch">;
}): string {
  const payload = canonical({
    kind: input.kind,
    job_id: input.job_id,
    action: input.request.action,
    parameters: input.request.parameters,
    expected_revision: input.request.expected_revision,
    expected_epoch: input.request.expected_epoch,
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
