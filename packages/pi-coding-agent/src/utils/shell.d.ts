export interface ShellConfig {
    shell: string;
    args: string[];
}
/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export declare function getShellConfig(customShellPath?: string): ShellConfig;
export declare function getShellEnv(): NodeJS.ProcessEnv;
/** GSD compat: normalize Windows NUL redirects for bash compatibility. */
export declare function sanitizeCommand(command: string): string;
/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export declare function sanitizeBinaryOutput(str: string): string;
export declare function trackDetachedChildPid(pid: number): void;
export declare function untrackDetachedChildPid(pid: number): void;
export declare function killTrackedDetachedChildren(): void;
/**
 * Grace period (ms) between SIGTERM and SIGKILL.
 * Canonical source of truth for the graceful-kill timing ladder — imported by the
 * async_bash and GSD exec-sandbox kill paths. The pi-agent-core harness keeps a
 * deliberate local mirror (it must not depend on this package); a parity test
 * locks the two. Update both together.
 */
export declare const SIGKILL_GRACE_MS = 5000;
/** Hard deadline (ms) after SIGKILL to force-resolve the job promise — consumed by the sync-bash, async_bash, and exec-sandbox kill paths. */
export declare const HARD_DEADLINE_MS = 3000;
/**
 * Kill a process and all its children (cross-platform).
 *
 * Returns immediately; the SIGKILL escalation fires asynchronously after `graceMs`,
 * so the target is not guaranteed dead by the time this returns.
 *
 * On Unix: sends SIGTERM immediately, then escalates to SIGKILL after `graceMs`
 * (default: SIGKILL_GRACE_MS = 5 s). The escalation timer is `.unref()`'d so it
 * never keeps the event loop alive after the parent process has nothing else to do.
 *
 * On Windows: there is no reliable graceful signal for the hidden console
 * processes pi spawns (`windowsHide: true` means no window to receive WM_CLOSE
 * and no console for CTRL_BREAK), so `taskkill /T` without /F is a no-op here.
 * We therefore force-terminate the tree immediately with `taskkill /F /T /PID`.
 * Graceful (SIGTERM-first) semantics are Unix-primary; `opts.graceMs` is ignored
 * on Windows.
 */
export declare function killProcessTree(pid: number, opts?: {
    graceMs?: number;
}): void;
