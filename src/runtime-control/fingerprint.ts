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

export function fingerprintImport(input: {
  project_id: string;
  import_digest: string;
  payload: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    kind: "import",
    project_id: input.project_id,
    import_digest: input.import_digest,
    payload: input.payload,
  }))).digest("hex");
}

export function fingerprintAnswer(input: {
  job_id: string;
  question_id: string;
  request_id: string;
  expected_revision: number;
  expected_epoch: number;
  response: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    kind: "answer",
    job_id: input.job_id,
    question_id: input.question_id,
    request_id: input.request_id,
    expected_revision: input.expected_revision,
    expected_epoch: input.expected_epoch,
    response: input.response,
  }))).digest("hex");
}
