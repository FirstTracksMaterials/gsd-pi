// Project/App: gsd-pi
// File Purpose: /slots idle parsing for the configured llama.cpp proxy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sealBackendBinding } from "../backend-binding.ts";
import { parseSlots, probeBackendIdle, probeManagedIdle } from "../idle-probe.ts";

const coverage = {
  expectedSlotIds: [0],
  expectedSlotCount: 1,
  expectedContextCapacity: 131072,
};

const codingBinding = sealBackendBinding({
  version: 1,
  backend_id: "llamacpp",
  provider: "llama-cpp",
  model_id: "blaskgpt",
  api_base_url: "http://127.0.0.1:9/v1",
  slot_probe_url: "http://127.0.0.1:9/slots",
  expected_slot_ids: [0],
  expected_slot_count: 1,
  expected_context_capacity: 131072,
});

const busyMetrics = "# HELP n_idle_slots idle slots\nn_idle_slots 0\nprompt_tokens_processed_total 12\n";

const observed = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "llama-slots-observed.json"),
  "utf8",
);
const observedSlots = JSON.parse(observed) as Array<{ is_processing: boolean }>;

test("observed top-level slots array confirms idle only when every flag is false", () => {
  const idle = parseSlots(observed);
  assert.equal(idle.idle, true);
  assert.equal(idle.source, "slots");
  const wrapped = parseSlots(JSON.stringify({ slots: observedSlots }));
  assert.equal(wrapped.idle, true);
});

test("busy, empty, malformed, and incomplete slot bodies are not idle", () => {
  const busy = structuredClone(observedSlots);
  busy[0].is_processing = true;
  assert.equal(parseSlots(JSON.stringify(busy)).idle, false);
  assert.equal(parseSlots(JSON.stringify({ slots: busy })).reason, "A backend slot is still processing");
  assert.equal(parseSlots("[]").idle, false);
  assert.equal(parseSlots('{"slots":[]}').idle, false);
  assert.equal(parseSlots("{").idle, false);
  assert.equal(parseSlots('[{"id":0}]').idle, false);
  assert.equal(parseSlots('[{"id":0,"is_processing":null}]').idle, false);
  assert.equal(parseSlots('[{"id":0,"is_processing":"false"}]').idle, false);
});

test("an unreachable slots probe is not confirmed idle", async () => {
  const result = await probeBackendIdle("http://127.0.0.1:9/slots");
  assert.equal(result.idle, false);
  assert.match(result.reason, /Idle probe failed/);
});

test("covered array and wrapper bodies are idle only when slot id, count, and context match", () => {
  assert.equal(parseSlots(observed, coverage).idle, true);
  assert.equal(parseSlots(JSON.stringify({ slots: observedSlots }), coverage).idle, true);
  assert.equal(parseSlots(observed, { ...coverage, expectedContextCapacity: 4096 }).idle, false);
  assert.equal(parseSlots(observed, { ...coverage, expectedSlotIds: [1] }).idle, false);
  assert.equal(parseSlots(observed, { ...coverage, expectedSlotCount: 2, expectedSlotIds: [0, 1] }).idle, false);
});

test("HTTP 503 with an idle-shaped slots body is not idle", async () => {
  const body = JSON.stringify([{ id: 0, is_processing: false, n_ctx: 131072 }]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 503 });
  try {
    const result = await probeManagedIdle(codingBinding);
    assert.equal(result.idle, false);
    assert.match(result.reason, /HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});

test("busy metrics text is not idle on the managed slots path", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(busyMetrics, { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const metrics = await probeBackendIdle("http://127.0.0.1:9/metrics");
    assert.equal(metrics.idle, false);
    assert.match(metrics.reason, /\/slots only/);
    const asSlots = await probeBackendIdle("http://127.0.0.1:9/slots");
    assert.equal(asSlots.idle, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("an unrelated idle server is not the bound probe", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    const idle = url.includes("unrelated");
    const body = JSON.stringify([{ id: 0, is_processing: !idle, n_ctx: 131072 }]);
    return new Response(body, { status: 200 });
  };
  try {
    const result = await probeManagedIdle(codingBinding);
    assert.equal(result.idle, false);
    assert.deepEqual(seen, [codingBinding.slot_probe_url]);
    assert.equal(seen.some((url) => url.includes("unrelated")), false);
  } finally {
    globalThis.fetch = original;
  }
});
