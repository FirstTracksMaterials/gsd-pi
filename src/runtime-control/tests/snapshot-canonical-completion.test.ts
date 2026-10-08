// Project/App: gsd-pi
// File Purpose: Canonical DB completion must project as verified completion without trusting process exit.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCanonicalDbCompletion,
  isCanonicalMilestoneCompletion,
  nativeTimelineForJob,
} from "../snapshots.ts";

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

const completedMilestone = {
  id: "M001",
  title: "Accepted milestone",
  status: "complete",
  slices: [{
    id: "S01",
    title: "Accepted slice",
    status: "complete",
    tasks: [{ id: "T01", title: "Accepted task", status: "complete" }],
  }],
};

test("a completed job milestone remains complete when another project milestone is queued", () => {
  assert.equal(isCanonicalMilestoneCompletion({ milestone: completedMilestone, blockerCount: 0 }), true);
});

test("a milestone-scoped job timeline excludes another project milestone", () => {
  const queuedMilestone = {
    id: "M002",
    title: "Unrelated queued milestone",
    status: "queued",
    slices: [],
  };
  const timeline = nativeTimelineForJob([completedMilestone, queuedMilestone], "M001");
  assert.deepEqual(timeline.map((row) => row.id), ["M001", "S01", "T01"]);
});

test("milestone completion fails closed for blockers or an incomplete hierarchy", () => {
  assert.equal(isCanonicalMilestoneCompletion({ milestone: completedMilestone, blockerCount: 1 }), false);
  assert.equal(isCanonicalMilestoneCompletion({
    milestone: {
      ...completedMilestone,
      slices: [{ ...completedMilestone.slices[0]!, tasks: [] }],
    },
    blockerCount: 0,
  }), false);
  assert.equal(isCanonicalMilestoneCompletion({
    milestone: {
      ...completedMilestone,
      slices: [{
        ...completedMilestone.slices[0]!,
        tasks: [{ ...completedMilestone.slices[0]!.tasks[0]!, status: "queued" }],
      }],
    },
    blockerCount: 0,
  }), false);
});
