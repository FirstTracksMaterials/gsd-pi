// Project/App: gsd-pi
// File Purpose: Read-only backend idle probe. No trial generation.

import type { BackendBinding } from "./types.ts";

export type IdleProbeResult =
  | { idle: true; source: string }
  | { idle: false; source: string; reason: string };

export type IdleProbeFn = (url: string) => Promise<IdleProbeResult>;

export type SlotCoverage = {
  expectedSlotIds: number[];
  expectedSlotCount: number;
  expectedContextCapacity: number;
};

let testProbe: IdleProbeFn | null = null;

export function registerIdleProbeForTest(probe: IdleProbeFn | null): void {
  testProbe = probe;
}

export function resetIdleProbeForTest(): void {
  testProbe = null;
}

function slotRecords(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { slots?: unknown }).slots)) {
    return (parsed as { slots: unknown[] }).slots;
  }
  return null;
}

export function parseSlots(body: string, coverage?: SlotCoverage | null): IdleProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { idle: false, source: "slots", reason: "Could not parse /slots idle signal" };
  }
  const slots = slotRecords(parsed);
  if (!slots || slots.length === 0) {
    return { idle: false, source: "slots", reason: "Could not parse /slots idle signal" };
  }
  const flags: boolean[] = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      return { idle: false, source: "slots", reason: "Could not parse /slots idle signal" };
    }
    const flag = (slot as { is_processing?: unknown }).is_processing;
    if (typeof flag !== "boolean") {
      return { idle: false, source: "slots", reason: "Could not parse /slots idle signal" };
    }
    flags.push(flag);
  }
  if (flags.some((flag) => flag)) {
    return { idle: false, source: "slots", reason: "A backend slot is still processing" };
  }
  if (coverage) {
    const covered = coverageResult(slots, coverage);
    if (covered) return covered;
  }
  return { idle: true, source: "slots" };
}

function coverageResult(slots: unknown[], coverage: SlotCoverage): IdleProbeResult | null {
  if (slots.length !== coverage.expectedSlotCount) {
    return { idle: false, source: "slots", reason: "Slot coverage does not match the backend binding" };
  }
  const seen = new Set<number>();
  for (const slot of slots) {
    const record = slot as { id?: unknown; n_ctx?: unknown };
    if (typeof record.id !== "number" || !Number.isInteger(record.id)) {
      return { idle: false, source: "slots", reason: "Slot coverage does not match the backend binding" };
    }
    if (record.n_ctx !== coverage.expectedContextCapacity) {
      return { idle: false, source: "slots", reason: "Slot context does not match the backend binding" };
    }
    seen.add(record.id);
  }
  for (const id of coverage.expectedSlotIds) {
    if (!seen.has(id)) {
      return { idle: false, source: "slots", reason: "Slot coverage does not match the backend binding" };
    }
  }
  if (seen.size !== coverage.expectedSlotIds.length) {
    return { idle: false, source: "slots", reason: "Slot coverage does not match the backend binding" };
  }
  return null;
}

function unboundResult(): IdleProbeResult {
  return {
    idle: false,
    source: "unbound",
    reason: "Operation has no backend binding; ownership is unknown. Retain recovery_required.",
  };
}

export async function probeBackendIdle(
  probeUrl: string | null | undefined,
  coverage?: SlotCoverage | null,
): Promise<IdleProbeResult> {
  if (testProbe) {
    if (!probeUrl) return testProbe("");
    return testProbe(probeUrl);
  }
  if (!probeUrl || !probeUrl.trim()) {
    return {
      idle: false,
      source: "unconfigured",
      reason: "backend_idle_probe is not configured; cannot confirm backend idleness. Do not release model admission.",
    };
  }
  const url = probeUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { idle: false, source: "slots", reason: "Managed idle observation accepts /slots only" };
  }
  if (!parsed.pathname.endsWith("/slots")) {
    return { idle: false, source: "slots", reason: "Managed idle observation accepts /slots only" };
  }
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    if (!response.ok) {
      return { idle: false, source: "slots", reason: `Idle probe HTTP ${response.status}` };
    }
    return parseSlots(body, coverage);
  } catch (error) {
    return {
      idle: false,
      source: "probe",
      reason: `Idle probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function probeManagedIdle(binding: BackendBinding | null | undefined): Promise<IdleProbeResult> {
  if (!binding) return unboundResult();
  return probeBackendIdle(binding.slot_probe_url, {
    expectedSlotIds: binding.expected_slot_ids,
    expectedSlotCount: binding.expected_slot_count,
    expectedContextCapacity: binding.expected_context_capacity,
  });
}
