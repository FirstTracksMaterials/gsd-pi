// Project/App: gsd-pi
// File Purpose: /slots idle parsing for the configured llama.cpp proxy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSlots, probeBackendIdle } from "../idle-probe.ts";

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
