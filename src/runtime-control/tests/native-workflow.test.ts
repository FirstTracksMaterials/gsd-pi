// Project/App: gsd-pi
// File Purpose: Deterministic model-work budget checks for native review/replan workflows.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { clearGSDPreferencesCache } from "../../resources/extensions/gsd/preferences.ts";
import { resolveNativeWorkflowTimeoutMs, waitForWorkflowCompletion } from "../native-workflow.ts";
import { tempProject } from "./harness.ts";

test("native workflow completion uses the configured hard model-work budget", () => {
  const project = tempProject("native-workflow-budget");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  writeFileSync(join(project, ".gsd", "PREFERENCES.md"), [
    "---",
    "auto_supervisor:",
    "  soft_timeout_minutes: 20",
    "  idle_timeout_minutes: 10",
    "  hard_timeout_minutes: 31",
    "---",
    "",
  ].join("\n"));
  clearGSDPreferencesCache();
  assert.equal(resolveNativeWorkflowTimeoutMs(project), 31 * 60 * 1000);
});

test("healthy work crossing 90 seconds is not aborted and deadline expiry remains cancellable", async () => {
  let scheduledDelay = 0;
  let deadline: (() => void) | undefined;
  let listener: ((event: unknown) => void) | undefined;
  let cleared = false;
  let unsubscribed = false;
  const timer = { id: 1 } as unknown as ReturnType<typeof setTimeout>;
  const wait = waitForWorkflowCompletion(30 * 60 * 1000, {
    subscribe: (next) => {
      listener = next;
      return () => { unsubscribed = true; };
    },
    schedule: (next, delayMs) => {
      deadline = next;
      scheduledDelay = delayMs;
      return timer;
    },
    clear: (candidate) => {
      assert.equal(candidate, timer);
      cleared = true;
    },
  });

  assert.equal(scheduledDelay, 30 * 60 * 1000);
  assert.ok(scheduledDelay > 90_000);
  assert.equal(cleared, false);
  listener?.({ type: "agent_end" });
  await wait.promise;
  assert.equal(cleared, true);
  assert.equal(unsubscribed, true);

  let expiredUnsubscribed = false;
  const expired = waitForWorkflowCompletion(30 * 60 * 1000, {
    subscribe: () => () => { expiredUnsubscribed = true; },
    schedule: (next) => {
      deadline = next;
      return timer;
    },
    clear: () => undefined,
  });
  deadline?.();
  await assert.rejects(expired.promise, /native workflow did not finish/);
  assert.equal(expiredUnsubscribed, true);
  expired.cancel();
});
