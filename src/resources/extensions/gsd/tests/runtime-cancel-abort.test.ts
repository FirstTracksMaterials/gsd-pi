// Project/App: gsd-pi
// File Purpose: Runtime abort sets the existing cancellation gate before another dispatch.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAutoCancellationRequested,
  resetAutoCancellationForTest,
} from "../auto-cancellation.ts";

test("RPC abort hook requests cancellation so transient retries are refused", () => {
  resetAutoCancellationForTest();
  const hook = (globalThis as Record<symbol, unknown>)[Symbol.for("gsd.runtimeCancelAbort")];
  assert.equal(typeof hook, "function");
  (hook as () => void)();
  assert.equal(isAutoCancellationRequested(), true);
  resetAutoCancellationForTest();
});
