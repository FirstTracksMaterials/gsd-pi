// Project/App: gsd-pi
// File Purpose: Versioned coding-backend binding and its non-secret digest.

import { createHash } from "node:crypto";

import { invalidRequest } from "./errors.ts";
import type { BackendBinding } from "./types.ts";

export type BackendBindingInput = Omit<BackendBinding, "digest">;

const DIGEST_KEYS = [
  "api_base_url",
  "backend_id",
  "expected_context_capacity",
  "expected_slot_count",
  "expected_slot_ids",
  "model_id",
  "provider",
  "slot_probe_url",
  "version",
] as const;

export function canonicalBindingJson(input: BackendBindingInput): string {
  const payload = {
    api_base_url: input.api_base_url,
    backend_id: input.backend_id,
    expected_context_capacity: input.expected_context_capacity,
    expected_slot_count: input.expected_slot_count,
    expected_slot_ids: [...input.expected_slot_ids].sort((left, right) => left - right),
    model_id: input.model_id,
    provider: input.provider,
    slot_probe_url: input.slot_probe_url,
    version: input.version,
  };
  return JSON.stringify(payload);
}

export function bindingDigest(input: BackendBindingInput): string {
  return createHash("sha256").update(canonicalBindingJson(input)).digest("hex");
}

export function sealBackendBinding(input: BackendBindingInput): BackendBinding {
  const checked = validateBindingFields(input);
  return { ...checked, digest: bindingDigest(checked) };
}

export function parseBackendBinding(raw: unknown): BackendBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("backend_binding must be an object");
  }
  const record = raw as Record<string, unknown>;
  const sealed = sealBackendBinding({
    version: record.version as BackendBindingInput["version"],
    backend_id: requiredString(record.backend_id, "backend_binding.backend_id"),
    provider: requiredString(record.provider, "backend_binding.provider"),
    model_id: requiredString(record.model_id, "backend_binding.model_id"),
    api_base_url: requiredString(record.api_base_url, "backend_binding.api_base_url"),
    slot_probe_url: requiredString(record.slot_probe_url, "backend_binding.slot_probe_url"),
    expected_slot_ids: requiredSlotIds(record.expected_slot_ids),
    expected_slot_count: requiredCount(record.expected_slot_count),
    expected_context_capacity: requiredCount(record.expected_context_capacity, "backend_binding.expected_context_capacity"),
  });
  if (typeof record.digest !== "string" || record.digest !== sealed.digest) {
    throw invalidRequest("backend_binding digest does not match its non-secret fields");
  }
  return sealed;
}

export function assertSharedBindingDigest(digests: Array<string | null>): string | null {
  const unique = new Set(digests);
  if (unique.size > 1) {
    throw invalidRequest("Registered projects must share one backend binding");
  }
  return digests[0] ?? null;
}

function validateBindingFields(input: BackendBindingInput): BackendBindingInput {
  if (input.version !== 1) {
    throw invalidRequest("backend_binding.version must be 1");
  }
  const apiBase = requiredString(input.api_base_url, "backend_binding.api_base_url");
  const probeUrl = requiredString(input.slot_probe_url, "backend_binding.slot_probe_url");
  parseHttpUrl(apiBase, "backend_binding.api_base_url");
  const probe = parseHttpUrl(probeUrl, "backend_binding.slot_probe_url");
  if (!probe.pathname.endsWith("/slots")) {
    throw invalidRequest("backend_binding.slot_probe_url must be a /slots probe");
  }
  const ids = requiredSlotIds(input.expected_slot_ids);
  const count = requiredCount(input.expected_slot_count, "backend_binding.expected_slot_count");
  if (count !== ids.length) {
    throw invalidRequest("backend_binding.expected_slot_count must equal expected_slot_ids");
  }
  const capacity = requiredCount(input.expected_context_capacity, "backend_binding.expected_context_capacity");
  return {
    version: 1,
    backend_id: requiredString(input.backend_id, "backend_binding.backend_id"),
    provider: requiredString(input.provider, "backend_binding.provider"),
    model_id: requiredString(input.model_id, "backend_binding.model_id"),
    api_base_url: apiBase,
    slot_probe_url: probeUrl,
    expected_slot_ids: ids,
    expected_slot_count: count,
    expected_context_capacity: capacity,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredCount(value: unknown, field = "backend_binding.expected_slot_count"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidRequest(`${field} must be a positive integer`);
  }
  return value;
}

function requiredSlotIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("backend_binding.expected_slot_ids must be a non-empty array");
  }
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      throw invalidRequest("backend_binding.expected_slot_ids must be nonnegative integers");
    }
    ids.push(entry);
  }
  if (new Set(ids).size !== ids.length) {
    throw invalidRequest("backend_binding.expected_slot_ids must be unique");
  }
  return ids;
}

function parseHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidRequest(`${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidRequest(`${field} must be an absolute http(s) URL`);
  }
  return url;
}

export const BINDING_DIGEST_KEYS = DIGEST_KEYS;
