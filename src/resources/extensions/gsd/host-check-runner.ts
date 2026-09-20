// Project/App: gsd-pi
// File Purpose: Async process-group host-check runner for verification and trusted FTM validators.

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  wrapManagedCommand,
} from "../../../runtime-control/workspace-profile.ts";

/** R8 graceful SIGTERM budget (ms). Tests may shorten this. */
export const DEFAULT_TERM_GRACE_MS = 10_000;
/** R8 force-cleanup verification budget after SIGKILL (ms). */
export const DEFAULT_KILL_VERIFY_MS = 5_000;
/** Bounded in-memory stdout/stderr retained per check. */
export const MAX_CAPTURED_OUTPUT_BYTES = 10 * 1024;
/** Fast follow-up kill after a per-command timeout (not the abort path). */
const DEFAULT_TIMEOUT_CLEANUP_MS = 250;

export const HOST_CHECK_LOG_EXCLUDE_PATHS = [
  ".gsd/evidence/host-checks",
  ".gsd/evidence/host-checks/**",
] as const;

export type HostCheckFailureClass = "timeout" | "command-not-found" | "shell-parse" | "cancelled";

export interface HostCheckRequest {
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  logDir?: string;
  env?: NodeJS.ProcessEnv;
  shellCommand?: string;
  argv?: string[];
  termGraceMs?: number;
  killVerifyMs?: number;
  timeoutCleanupMs?: number;
  windowsVerbatimArguments?: boolean;
}

export interface HostCheckResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  durableOutputRef: string;
  stdoutPath: string;
  stderrPath: string;
  spawnError?: NodeJS.ErrnoException & { killed?: boolean };
  failureClass?: HostCheckFailureClass;
  pid?: number;
}

interface CleanupBudgets {
  termGraceMs: number;
  killVerifyMs: number;
  timeoutCleanupMs: number;
}

let testBudgets: Partial<CleanupBudgets> | null = null;

export function setHostCheckCleanupBudgetsForTest(budgets: Partial<CleanupBudgets> | null): void {
  testBudgets = budgets;
}

export function hostCheckSourceExclusions(cwd: string, logDir?: string): string[] {
  const exclusions: string[] = [...HOST_CHECK_LOG_EXCLUDE_PATHS];
  if (!logDir) return exclusions;
  const repoRoot = resolve(cwd);
  let relativeLog: string;
  try {
    relativeLog = relative(repoRoot, resolve(logDir)).replaceAll("\\", "/");
  } catch {
    return exclusions;
  }
  if (!relativeLog || relativeLog === ".." || relativeLog.startsWith("../") || isAbsolute(relativeLog)) {
    return exclusions;
  }
  exclusions.push(relativeLog, `${relativeLog}/**`);
  return exclusions;
}

export function createHostCheckLogDir(cwd: string): string {
  const managed = join(cwd, ".gsd", "evidence", "host-checks", randomUUID());
  try {
    mkdirSync(managed, { recursive: true });
    return managed;
  } catch {
    const fallback = join(tmpdir(), "gsd-host-checks", randomUUID());
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function truncateCapturedOutput(value: string | null | undefined, maxBytes = MAX_CAPTURED_OUTPUT_BYTES): string {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n…[truncated]";
}

export function readBoundedCommandOutput(path: string, maxBytes = MAX_CAPTURED_OUTPUT_BYTES): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return readFileSync(path, "utf-8");
    const marker = Buffer.from("\n…[truncated]\n", "utf-8");
    const retainedBytes = maxBytes - marker.byteLength;
    const headBytes = Math.floor(retainedBytes / 2);
    const tailBytes = retainedBytes - headBytes;
    const head = Buffer.allocUnsafe(headBytes);
    const tail = Buffer.allocUnsafe(tailBytes);
    readSync(fd, head, 0, headBytes, 0);
    readSync(fd, tail, 0, tailBytes, size - tailBytes);
    return Buffer.concat([head, marker, tail]).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function resolveBudgets(request: HostCheckRequest): CleanupBudgets {
  return {
    termGraceMs: request.termGraceMs ?? testBudgets?.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
    killVerifyMs: request.killVerifyMs ?? testBudgets?.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS,
    timeoutCleanupMs: request.timeoutCleanupMs
      ?? testBudgets?.timeoutCleanupMs
      ?? DEFAULT_TIMEOUT_CLEANUP_MS,
  };
}

function shellInvocation(command: string): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return {
      file: "cmd",
      args: ["/d", "/s", "/c", command],
      windowsVerbatimArguments: true,
    };
  }
  return {
    file: "sh",
    args: [
      "-c",
      "if command -v bash >/dev/null 2>&1; then exec bash -o pipefail -c \"$1\" verification-gate; fi\nexec sh -c \"$1\" verification-gate",
      "verification-gate",
      command,
    ],
    windowsVerbatimArguments: false,
  };
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("error", onError);
      child.off("exit", onExit);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function processGroupHasMembers(pgid: number): boolean {
  if (process.platform === "win32") {
    try {
      process.kill(pgid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    try {
      process.kill(pgid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function terminateProcessGroup(
  child: ChildProcess,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  graceMs: number,
  killVerifyMs: number,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  // Always signal the process group, even if the spawn child (parent) has
  // already exited while a descendant still holds stdout.
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(pid, "SIGTERM");
    await Promise.race([
      exitPromise.then(() => true),
      sleep(graceMs).then(() => false),
    ]);
  }
  if (processGroupHasMembers(pid)) {
    signalProcessGroup(pid, "SIGKILL");
    await Promise.race([
      exitPromise.then(() => undefined),
      sleep(killVerifyMs),
    ]);
    const deadline = Date.now() + killVerifyMs;
    while (processGroupHasMembers(pid) && Date.now() < deadline) {
      signalProcessGroup(pid, "SIGKILL");
      await sleep(Math.min(50, deadline - Date.now()));
    }
  }
}

export function hostCheckProcessGroupAlive(pid: number): boolean {
  return processGroupHasMembers(pid);
}

function classifyFailure(input: {
  timedOut: boolean;
  cancelled: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}): HostCheckFailureClass | undefined {
  if (input.cancelled) return "cancelled";
  if (input.timedOut) return "timeout";
  if (input.spawnError) {
    if (input.spawnError.code === "ENOENT" || /enoent|not found/i.test(input.spawnError.message)) {
      return "command-not-found";
    }
  }
  if (
    input.exitCode === 127
    || /command not found/i.test(input.stderr)
    || /is not recognized as an internal or external command/i.test(input.stderr)
  ) {
    return "command-not-found";
  }
  if (
    input.exitCode === 1
    && input.stdout.trim() === ""
    && (
      /unterminated string constant/i.test(input.stderr)
      || /syntax error: unterminated quoted string/i.test(input.stderr)
      || /unexpected eof while looking for matching/i.test(input.stderr)
      || /syntax error near unexpected token/i.test(input.stderr)
      || /was unexpected at this time/i.test(input.stderr)
    )
  ) {
    return "shell-parse";
  }
  return undefined;
}

/**
 * Run one host check. The runner owns subprocess lifecycle: process-group
 * spawn, abort, approved timeout (never clamped), bounded capture, full log
 * artefacts, and TERM then KILL cleanup. Ordinary checks pass `shellCommand`;
 * trusted FTM/test-policy validators pass `argv`.
 */
export async function runHostCheck(request: HostCheckRequest): Promise<HostCheckResult> {
  if (request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
    throw new Error("Host check timeoutMs must be a positive finite number; approved budgets are not clamped");
  }
  if (!request.shellCommand && !request.argv) {
    throw new Error("Host check requires shellCommand or argv");
  }
  if (request.shellCommand && request.argv) {
    throw new Error("Host check accepts either shellCommand or argv, not both");
  }

  const cwd = request.cwd;
  const logDir = request.logDir ?? createHostCheckLogDir(cwd);
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, "stdout");
  const stderrPath = join(logDir, "stderr");
  const durableOutputRef = `file://${logDir}`;
  const budgets = resolveBudgets(request);
  const started = Date.now();

  if (request.abortSignal?.aborted) {
    return {
      exitCode: 1,
      signal: "SIGTERM",
      stdout: "",
      stderr: "cancelled before start",
      durationMs: 0,
      timedOut: false,
      cancelled: true,
      durableOutputRef,
      stdoutPath,
      stderrPath,
      failureClass: "cancelled",
    };
  }

  const invocation = request.argv
    ? {
      file: request.argv[0]!,
      args: request.argv.slice(1),
      windowsVerbatimArguments: request.windowsVerbatimArguments === true,
    }
    : shellInvocation(request.shellCommand!);

  const wrapped = wrapManagedCommand(cwd, invocation.file, invocation.args);
  if (!wrapped.ok) {
    writeFileSync(stderrPath, wrapped.diagnostics, "utf-8");
    return {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: wrapped.diagnostics,
      durationMs: Date.now() - started,
      timedOut: false,
      cancelled: false,
      durableOutputRef,
      stdoutPath,
      stderrPath,
      failureClass: "command-not-found",
    };
  }
  const spawnFile = wrapped.file;
  const spawnArgs = wrapped.args;

  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let child: ChildProcess | undefined;
  let spawnError: (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
  let timedOut = false;
  let cancelled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    child = spawn(spawnFile, spawnArgs, {
      cwd,
      env: request.env ?? { ...process.env },
      stdio: ["ignore", stdoutFd, stderrFd],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    spawnError = error as NodeJS.ErrnoException & { killed?: boolean };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  if (!child) {
    const stderr = truncateCapturedOutput(
      `${readBoundedCommandOutput(stderrPath)}\n${spawnError?.message ?? "spawn failed"}`.trim(),
    );
    const failureClass = classifyFailure({
      timedOut: false,
      cancelled: false,
      exitCode: 127,
      stdout: "",
      stderr,
      spawnError,
    });
    return {
      exitCode: 127,
      signal: null,
      stdout: readBoundedCommandOutput(stdoutPath),
      stderr,
      durationMs: Date.now() - started,
      timedOut: false,
      cancelled: false,
      durableOutputRef,
      stdoutPath,
      stderrPath,
      spawnError,
      failureClass,
    };
  }

  const exitPromise = waitForExit(child);
  const spawnedPid = child.pid;

  const abort = async (reason: "timeout" | "cancel") => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    await terminateProcessGroup(
      child!,
      exitPromise,
      reason === "timeout" ? budgets.timeoutCleanupMs : budgets.termGraceMs,
      budgets.killVerifyMs,
    );
  };

  timeoutHandle = setTimeout(() => {
    void abort("timeout");
  }, request.timeoutMs);

  if (request.abortSignal) {
    abortListener = () => {
      void abort("cancel");
    };
    if (request.abortSignal.aborted) abortListener();
    else request.abortSignal.addEventListener("abort", abortListener, { once: true });
  }

  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    const exit = await exitPromise;
    code = exit.code;
    signal = exit.signal;
  } catch (error) {
    spawnError = error as NodeJS.ErrnoException & { killed?: boolean };
    if (spawnError.code === "ENOENT") {
      code = 127;
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (abortListener && request.abortSignal) {
      request.abortSignal.removeEventListener("abort", abortListener);
    }
    if ((cancelled || timedOut) && spawnedPid !== undefined) {
      await terminateProcessGroup(child, exitPromise, 0, budgets.killVerifyMs);
    }
  }

  const stdout = readBoundedCommandOutput(stdoutPath);
  let stderr = readBoundedCommandOutput(stderrPath);
  let exitCode = code ?? 1;

  if (cancelled) {
    exitCode = code ?? 1;
    stderr = truncateCapturedOutput(`${stderr}\ncancelled`.trim());
  } else if (timedOut || spawnError?.code === "ETIMEDOUT") {
    timedOut = true;
    exitCode = 124;
    stderr = truncateCapturedOutput(
      `${stderr}\ntimed out after ${request.timeoutMs}ms. Raise verification_timeout_ms if this command is expected to run longer.`.trim(),
    );
  } else if (spawnError && classifyFailure({
    timedOut: false,
    cancelled: false,
    exitCode: exitCode,
    stdout,
    stderr: spawnError.message,
    spawnError,
  }) === "command-not-found") {
    exitCode = 127;
    stderr = truncateCapturedOutput(`${stderr}\n${spawnError.message}`.trim());
  }

  const failureClass = classifyFailure({
    timedOut,
    cancelled,
    exitCode,
    stdout,
    stderr,
    spawnError,
  });

  return {
    exitCode,
    signal,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
    cancelled,
    durableOutputRef,
    stdoutPath,
    stderrPath,
    spawnError,
    failureClass,
    pid: spawnedPid,
  };
}
