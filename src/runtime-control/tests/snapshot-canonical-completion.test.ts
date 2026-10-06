// Project/App: gsd-pi
// File Purpose: Canonical DB completion must project as verified completion without trusting process exit.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isCanonicalDbCompletion } from "../snapshots.ts";

const complete = {
  phase: "complete",
  milestones: { total: 1, done: 1, active: 0, pending: 0 },
  slices: { total: 1, done: 1, active: 0, pending: 0 },
  tasks: { total: 1, done: 1, pending: 0 },
  blockerCount: 0,
};

test("DB-authoritative terminal hierarchy is verified completion", () => {
  assert.equal(isCanonicalDbCompletion(complete), true);
});

test("phase text, partial hierarchy, and blockers cannot manufacture completion", () => {
  assert.equal(isCanonicalDbCompletion({ ...complete, phase: "executing" }), false);
  assert.equal(isCanonicalDbCompletion({
    ...complete,
    tasks: { total: 1, done: 0, pending: 1 },
  }), false);
  assert.equal(isCanonicalDbCompletion({ ...complete, blockerCount: 1 }), false);
  assert.equal(isCanonicalDbCompletion({
    ...complete,
    milestones: { total: 0, done: 0, active: 0, pending: 0 },
  }), false);
});
