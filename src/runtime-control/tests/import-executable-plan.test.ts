import assert from "node:assert/strict";
import test from "node:test";

import { classifyMilestoneReadiness } from "../../resources/extensions/gsd/milestone-readiness.ts";
import { importedMilestoneRows, importedMilestoneSeed } from "../import-jobs.ts";

test("imported documents become a pending plan and stay queued", () => {
  const rows = importedMilestoneRows([
    { path: "technical-spec.md", content: "Implement the conversion.", sha256: "abc" },
  ]);
  assert.ok(rows);
  assert.equal(rows.status, "queued");
  assert.equal(rows.sliceStatus, "pending");
  assert.equal(rows.taskStatus, "pending");
  assert.equal(rows.status === "queued" && rows.taskStatus !== "executing", true);
  const readiness = classifyMilestoneReadiness({
    status: rows.status,
    hasContext: true,
    sliceCount: 1,
  });
  assert.equal(readiness.kind, "executable-plan");
});

test("an import with no document text stays a shell", () => {
  assert.equal(importedMilestoneRows([]), null);
});

test("prompt imports seed milestone context without synthetic slices or tasks", () => {
  const documents = [
    { path: "build-widget.md", content: "# Build widget\n\nUse native GSD planning.", sha256: "abc" },
  ];
  const seed = importedMilestoneSeed(documents, "prompt");
  assert.match(seed.context, /Use native GSD planning/);
  assert.equal(seed.plan, null);
  assert.equal(importedMilestoneSeed(documents, "legacy").plan?.taskId, "T01");
});
