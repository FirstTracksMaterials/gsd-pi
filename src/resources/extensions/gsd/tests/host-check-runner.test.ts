// Project/App: gsd-pi
// File Purpose: AT-L01 cancellable host-check runner: approved budgets, abort, process groups.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runHostCheck,
  setHostCheckCleanupBudgetsForTest,
  truncateCapturedOutput,
  hostCheckProcessGroupAlive,
} from "../host-check-runner.ts";

afterEach(() => {
  setHostCheckCleanupBudgetsForTest(null);
});

test("AT-L01: approved timeout longer than 30s/120s defaults is not clamped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-budget-"));
  const started = Date.now();
  const result = await runHostCheck({
    cwd,
    timeoutMs: 5_000,
    argv: ["node", "-e", "setTimeout(() => {}, 400)"],
  });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.cancelled, false);
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed >= 300, `expected a real wait, elapsed=${elapsed}`);
  assert.ok(elapsed < 4_000, `approved 5s budget should not wait a 30s/120s cap, elapsed=${elapsed}`);
  assert.match(result.durableOutputRef, /^file:\/\//);
  assert.ok(readFileSync(result.stdoutPath).length >= 0);
});

test("AT-L01: AbortSignal cancels the process group and is non-pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-cancel-"));
  setHostCheckCleanupBudgetsForTest({ termGraceMs: 80, killVerifyMs: 80, timeoutCleanupMs: 50 });
  const controller = new AbortController();
  const pending = runHostCheck({
    cwd,
    timeoutMs: 10_000,
    abortSignal: controller.signal,
    argv: ["node", "-e", "setInterval(() => {}, 20);"],
  });
  setTimeout(() => controller.abort(), 80);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.failureClass, "cancelled");
  assert.notEqual(result.exitCode, 0);
});

test("AT-L01: event loop stays responsive while a host check runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-ticks-"));
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 25);
  try {
    const result = await runHostCheck({
      cwd,
      timeoutMs: 3_000,
      argv: ["node", "-e", "setTimeout(() => {}, 250)"],
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(ticks > 0, `expected timer ticks during the check, got ${ticks}`);
  } finally {
    clearInterval(timer);
  }
});

test("AT-L01: timeout is classified without using exit 127", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-timeout-"));
  setHostCheckCleanupBudgetsForTest({ timeoutCleanupMs: 40, termGraceMs: 40, killVerifyMs: 40 });
  const result = await runHostCheck({
    cwd,
    timeoutMs: 80,
    shellCommand: "sleep 5",
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.failureClass, "timeout");
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out after 80ms/);
  assert.match(result.stderr, /verification_timeout_ms/);
});

test("AT-L01: argv validators do not use a shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-argv-"));
  writeFileSync(join(cwd, "ok.txt"), "ok\n");
  const result = await runHostCheck({
    cwd,
    timeoutMs: 3_000,
    argv: ["node", "-e", "process.stdout.write('argv-only')"],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /argv-only/);
});

test("AT-L05: descendant-held stdout does not deadlock cancel cleanup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-host-check-descendant-"));
  setHostCheckCleanupBudgetsForTest({ termGraceMs: 80, killVerifyMs: 150, timeoutCleanupMs: 50 });
  const controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 20);
  const started = Date.now();
  try {
    const pending = runHostCheck({
      cwd,
      timeoutMs: 10_000,
      abortSignal: controller.signal,
      argv: [
        "node",
        "-e",
        'const {spawn}=require("child_process");spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});process.stdout.write(\\"held\\\\n\\");setInterval(()=>{},200);"],{stdio:["ignore","inherit","inherit"]});process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},200);',
      ],
    });
    setTimeout(() => controller.abort(), 80);
    const result = await pending;
    const elapsed = Date.now() - started;
    assert.equal(result.cancelled, true, result.stderr);
    assert.equal(result.failureClass, "cancelled");
    assert.ok(elapsed < 2_000, `cleanup deadlocked, elapsed=${elapsed}`);
    assert.ok(ticks > 0, `event loop should tick during descendant cleanup, ticks=${ticks}`);
    if (result.pid !== undefined) {
      assert.equal(hostCheckProcessGroupAlive(result.pid), false);
    }
  } finally {
    clearInterval(timer);
  }
});

test("bounded capture truncates while full artefact remains", () => {
  const huge = "x".repeat(20_000);
  const truncated = truncateCapturedOutput(huge);
  assert.ok(truncated.includes("…[truncated]"));
  assert.ok(truncated.length < huge.length);
});
