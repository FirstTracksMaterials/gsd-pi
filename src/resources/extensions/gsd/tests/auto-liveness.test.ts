// Project/App: gsd-pi
// File Purpose: AT-L02/L03/L04 useful-progress identity, token churn, and input-wait fixtures.

import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startUnitSupervision, type SupervisionContext } from "../auto-timers.ts";
import {
  clearInFlightTools,
  markToolStart,
} from "../auto-tool-tracking.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import {
  readUnitRuntimeRecord,
  recordTransportActivity,
  writeUnitRuntimeRecord,
} from "../unit-runtime.ts";
import {
  captureUsefulProgressIdentity,
  observeUsefulProgress,
  resetUsefulProgressCacheForTest,
} from "../useful-progress.ts";
import {
  publicationBlockedByCancellation,
  recordCancelledAttempt,
  requestAutoCancellation,
  resetAutoCancellationForTest,
  shouldRefuseNewWork,
} from "../auto-cancellation.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { _setAutoActiveForTest } from "../auto.ts";

const SUPERVISOR_PREFS = [
  "auto_supervisor:",
  "  soft_timeout_minutes: 100",
  "  idle_timeout_minutes: 10",
  "  hard_timeout_minutes: 30",
  "  stalled_tool_timeout_minutes: 5",
];

interface Harness {
  home: string;
  base: string;
  notifications: string[];
  paused: boolean;
  s: any;
  sctx: SupervisionContext;
  previousGsdHome: string | undefined;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(base: string): void {
  git(base, ["init", "-q"]);
  git(base, ["config", "user.email", "test@example.com"]);
  git(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "product.txt"), "committed\n");
  git(base, ["add", "product.txt"]);
  git(base, ["commit", "-qm", "fixture"]);
  writeFileSync(join(base, "product.txt"), "dirty-old\n");
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "gsd-liveness-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-liveness-base-"));
  const previousGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "preferences.md"), ["---", ...SUPERVISOR_PREFS, "---", ""].join("\n"));
  clearGSDPreferencesCache();
  initRepo(base);

  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    model: { provider: "anthropic" },
    modelRegistry: { getAvailable: () => [] },
  } as any;
  const pi = {
    sendMessage: () => {},
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  } as any;
  const s = {
    active: true,
    verbose: false,
    basePath: base,
    currentUnit: { type: "validate-milestone", id: "M002", startedAt: 0 },
    cmdCtx: undefined,
    wrapupWarningHandle: null,
    idleWatchdogHandle: null,
    unitTimeoutHandle: null,
    continueHereHandle: null,
    lastTransportAt: 0,
    lastTransportKind: null,
    cancellationRequested: false,
  } as any;
  const harness: Harness = {
    home,
    base,
    notifications,
    paused: false,
    s,
    sctx: {
      s,
      ctx,
      pi,
      unitType: "validate-milestone",
      unitId: "M002",
      prefs: undefined,
      buildSnapshotOpts: () => ({}),
      buildRecoveryContext: () => ({
        basePath: base,
        verbose: false,
        currentUnitStartedAt: 0,
        unitRecoveryCount: new Map(),
      }),
      pauseAuto: async () => {
        harness.paused = true;
        s.active = false;
      },
    },
    previousGsdHome,
  };
  return harness;
}

function cleanup(h: Harness): void {
  h.s.active = false;
  if (h.s.wrapupWarningHandle) clearTimeout(h.s.wrapupWarningHandle);
  if (h.s.idleWatchdogHandle) clearInterval(h.s.idleWatchdogHandle);
  if (h.s.unitTimeoutHandle) clearTimeout(h.s.unitTimeoutHandle);
  if (h.s.continueHereHandle) clearInterval(h.s.continueHereHandle);
  mock.timers.reset();
  clearInFlightTools();
  clearGSDPreferencesCache();
  resetUsefulProgressCacheForTest();
  resetAutoCancellationForTest();
  if (h.previousGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = h.previousGsdHome;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.base, { recursive: true, force: true });
}

function startHarness(t: TestContext): Harness {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const h = makeHarness();
  t.after(() => cleanup(h));
  resetUsefulProgressCacheForTest();
  const identity = captureUsefulProgressIdentity(h.base, 0);
  writeUnitRuntimeRecord(h.base, "validate-milestone", "M002", 0, {
    phase: "dispatched",
    lastProgressAt: 0,
    lastProgressKind: "dispatch",
    lastSourceIdentity: identity,
    lastSourceChangeAt: 0,
  });
  startUnitSupervision(h.sctx);
  return h;
}

function mutateExcludedNoise(base: string): void {
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  mkdirSync(join(base, ".gsd", "journal"), { recursive: true });
  mkdirSync(join(base, ".gsd", "evidence", "host-checks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "audit"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "heartbeat.json"), `${Date.now()}\n`);
  writeFileSync(join(base, ".gsd", "journal", "2026-09-20.jsonl"), "{\"event\":\"tick\"}\n");
  writeFileSync(join(base, ".gsd", "evidence", "host-checks", "stdout"), "log\n");
  writeFileSync(join(base, ".gsd", "audit", "events.jsonl"), "{\"type\":\"heartbeat\"}\n");
  writeFileSync(join(base, ".gsd", "event-log.jsonl"), "{\"cmd\":\"tick\"}\n");
}

test("AT-L02: unchanged dirty tree and token churn do not rearm idle progress", (t) => {
  const h = startHarness(t);
  mutateExcludedNoise(h.base);
  recordTransportActivity(h.base, "validate-milestone", "M002", 0, "token", 1_000);
  h.s.lastTransportAt = 1_000;
  h.s.lastTransportKind = "token";

  mock.timers.tick(9 * 60_000);
  const mid = readUnitRuntimeRecord(h.base, "validate-milestone", "M002");
  assert.equal(mid?.lastProgressAt, 0);
  assert.equal(mid?.lastProgressKind, "dispatch");
  assert.equal(mid?.lastTransportAt, 1_000);
  assert.equal(h.paused, false);

  mock.timers.tick(60_000 + 15_000);
  const after = readUnitRuntimeRecord(h.base, "validate-milestone", "M002");
  assert.notEqual(after?.lastProgressKind, "filesystem-activity");
  assert.notEqual(after?.lastProgressAt, undefined);
  if (after?.lastProgressKind === "dispatch") {
    assert.equal(after.lastProgressAt, 0);
  }
});

test("AT-L03: genuine source/output change rearms useful progress", (t) => {
  const h = startHarness(t);
  writeFileSync(join(h.base, "product.txt"), "dirty-new\n");
  resetUsefulProgressCacheForTest();

  mock.timers.tick(15_000);
  const after = readUnitRuntimeRecord(h.base, "validate-milestone", "M002");
  assert.equal(after?.lastProgressKind, "filesystem-activity");
  assert.ok((after?.lastProgressAt ?? 0) > 0);
  assert.ok(after?.lastSourceChangeAt && after.lastSourceChangeAt > 0);
  assert.equal(h.paused, false);
});

test("pure token churn does not change useful progress identity", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-liveness-token-"));
  try {
    initRepo(base);
    resetUsefulProgressCacheForTest();
    const first = captureUsefulProgressIdentity(base);
    mutateExcludedNoise(base);
    resetUsefulProgressCacheForTest();
    const second = observeUsefulProgress(base, first);
    assert.equal(second.changed, false);
    assert.equal(second.identity, first);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AT-L04: user input wait is not treated as a hung model call", (t) => {
  const h = startHarness(t);
  markToolStart("ask-1", true, "ask_user_questions");

  mock.timers.tick(10 * 60_000 + 15_000);
  const runtime = readUnitRuntimeRecord(h.base, "validate-milestone", "M002");
  assert.equal(runtime?.lastProgressKind, "interactive-tool-waiting");
  assert.equal(runtime?.pendingInput, true);
  assert.equal(runtime?.activeTool, "ask_user_questions");
  assert.equal(h.paused, false);

  mock.timers.tick(30 * 60_000);
  const later = readUnitRuntimeRecord(h.base, "validate-milestone", "M002");
  assert.notEqual(h.s.unitTimeoutHandle, null);
  assert.notEqual(later?.phase, "timeout");
  assert.equal(h.paused, false);
});

test("cancellation requested blocks dispatch, compaction, continuation and late PASS", async (t) => {
  t.after(() => resetAutoCancellationForTest());
  resetAutoCancellationForTest();
  requestAutoCancellation("requested");
  assert.equal(shouldRefuseNewWork(), true);

  const handlers = new Map<string, Function>();
  registerHooks({
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
  } as any, []);
  const compact = handlers.get("session_before_compact");
  assert.ok(compact);
  _setAutoActiveForTest(true);
  try {
    const result = await compact(
      { preparation: { messagesToSummarize: [{ role: "user", content: "hello" }], turnPrefixMessages: [] } },
      {
        cwd: mkdtempSync(join(tmpdir(), "gsd-compact-cancel-")),
        ui: { notify() {}, setWidget() {} },
        getContextUsage: () => ({ percent: 120, tokens: 1_200_000, contextWindow: 1_000_000 }),
      },
    );
    assert.deepEqual(result, { cancel: true });
  } finally {
    _setAutoActiveForTest(false);
  }

  recordCancelledAttempt("attempt-cancelled");
  const dir = mkdtempSync(join(tmpdir(), "gsd-late-pass-"));
  writeUnitRuntimeRecord(dir, "execute-task", "M001/S01/T01", 1, {
    cancellationPhase: "cancelled",
  });
  assert.equal(publicationBlockedByCancellation({
    basePath: dir,
    attemptId: "attempt-cancelled",
    unitId: "M001/S01/T01",
  }), true);
  resetAutoCancellationForTest();
  rmSync(dir, { recursive: true, force: true });
});
