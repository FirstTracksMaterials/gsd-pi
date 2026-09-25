import assert from "node:assert/strict";
import test from "node:test";

import { autoSession } from "../auto-runtime-state.js";
import {
  clearAutoCancellationForAdmission,
  requestAutoCancellation,
  resetAutoCancellationForTest,
  shouldRefuseNewWork,
} from "../auto-cancellation.js";

function loopWouldSelectAUnit(): boolean {
  return autoSession.active && !autoSession.cancellationRequested;
}

test("a paused resume after cancel clears the refusal before the next loop", () => {
  resetAutoCancellationForTest();
  autoSession.active = true;
  requestAutoCancellation("aborting-model");
  autoSession.active = false;

  autoSession.active = true;
  assert.equal(shouldRefuseNewWork(), true);
  assert.equal(loopWouldSelectAUnit(), false);

  clearAutoCancellationForAdmission();
  autoSession.active = true;
  assert.equal(shouldRefuseNewWork(), false);
  assert.equal(loopWouldSelectAUnit(), true);
  resetAutoCancellationForTest();
  autoSession.active = false;
});
