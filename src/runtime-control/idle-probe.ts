// Project/App: gsd-pi
// File Purpose: Read-only backend idle probe. No trial generation.

export type IdleProbeResult =
  | { idle: true; source: string }
  | { idle: false; source: string; reason: string };

export type IdleProbeFn = (url: string) => Promise<IdleProbeResult>;

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

export function parseSlots(body: string): IdleProbeResult {
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
  return { idle: true, source: "slots" };
}

function parseMetrics(body: string): IdleProbeResult {
  const busy = /prompt_tokens_processed_total\s+[1-9]/.test(body) && /n_idle_slots\s+0/.test(body);
  if (/n_idle_slots\s+[1-9]/.test(body) || /idle/.test(body.toLowerCase())) {
    return { idle: true, source: "metrics" };
  }
  if (busy) return { idle: false, source: "metrics", reason: "Metrics indicate a busy slot" };
  return { idle: false, source: "metrics", reason: "Could not establish idleness from /metrics" };
}

export async function probeBackendIdle(probeUrl: string | null | undefined): Promise<IdleProbeResult> {
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
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    if (url.includes("/slots")) return parseSlots(body);
    if (url.includes("/metrics")) return parseMetrics(body);
    const slots = parseSlots(body);
    if (slots.idle || slots.source === "slots") return slots;
    return parseMetrics(body);
  } catch (error) {
    return {
      idle: false,
      source: "probe",
      reason: `Idle probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
