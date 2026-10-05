import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { Container, Text, truncateToWidth } from "@gsd/pi-tui";
import { spawn } from "child_process";
import { Type } from "typebox";
import { keyHint } from "../tool-ui/keybinding-hints.js";
import { truncateToVisualLines } from "../tool-ui/visual-truncate.js";
import { theme } from "../../theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import { getShellConfig, getShellEnv, HARD_DEADLINE_MS, killProcessTree, SIGKILL_GRACE_MS, trackDetachedChildPid, untrackDetachedChildPid, } from "../../utils/shell.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getDisplayReason, getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.js";
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)." })),
});
let bashArgvGuard = null;
export function setBashArgvGuard(guard) {
    bashArgvGuard = guard;
}
export function createLocalBashOperations(options) {
    const killGraceMs = options?.killGraceMs ?? SIGKILL_GRACE_MS;
    const forceResolveDelayMs = options?.forceResolveDelayMs ?? SIGKILL_GRACE_MS + HARD_DEADLINE_MS;
    return {
        exec: async (command, cwd, { onData, signal, timeout, env }) => {
            const { shell, args } = getShellConfig(options?.shellPath);
            try {
                await fsAccess(cwd, constants.F_OK);
            }
            catch {
                throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
            }
            if (signal?.aborted) {
                throw new Error("aborted");
            }
            let spawnFile = shell;
            let spawnArgs = [...args, command];
            if (bashArgvGuard) {
                const wrapped = bashArgvGuard(cwd, spawnFile, spawnArgs);
                if ("blocked" in wrapped) {
                    throw new Error(wrapped.blocked);
                }
                spawnFile = wrapped.file;
                spawnArgs = wrapped.args;
            }
            const child = spawn(spawnFile, spawnArgs, {
                cwd,
                detached: process.platform !== "win32",
                env: env ?? getShellEnv(),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            if (child.pid)
                trackDetachedChildPid(child.pid);
            let timedOut = false;
            let timeoutHandle;
            // Hard deadline: a true D-state (uninterruptible-sleep) child never emits
            // `exit`/`close`, so waitForChildProcess(child) would hang forever even after
            // SIGKILL. killProcessTree can send the signals but cannot force-resolve
            // the awaiting caller — the deadline MUST live here, in the caller. It is only
            // ARMED once a kill has been initiated (timeout or abort), and fires
            // `forceResolveDelayMs` later so SIGKILL has had its full grace window first.
            let deadlineHandle;
            let resolveDeadline;
            const hardDeadlinePromise = new Promise((resolve) => {
                resolveDeadline = resolve;
            });
            const armHardDeadline = () => {
                if (deadlineHandle)
                    return; // already armed by a prior kill
                deadlineHandle = setTimeout(() => {
                    resolveDeadline?.({ forceKilled: true });
                }, forceResolveDelayMs);
                if (typeof deadlineHandle === "object" && "unref" in deadlineHandle)
                    deadlineHandle.unref();
            };
            const initiateKill = () => {
                if (child.pid)
                    killProcessTree(child.pid, { graceMs: killGraceMs });
                armHardDeadline();
            };
            const onAbort = () => {
                initiateKill();
            };
            try {
                // Set timeout if provided.
                if (timeout !== undefined && timeout > 0) {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        initiateKill();
                    }, timeout * 1000);
                }
                // Stream stdout and stderr.
                child.stdout?.on("data", onData);
                child.stderr?.on("data", onData);
                // Handle abort signal by killing the entire process tree.
                if (signal) {
                    if (signal.aborted)
                        onAbort();
                    else
                        signal.addEventListener("abort", onAbort, { once: true });
                }
                // Race the real termination against the hard deadline. Promise.race ensures
                // the deadline and the real `close` cannot double-resolve the caller.
                const exitPromise = waitForChildProcess(child).then((code) => ({ forceKilled: false, code }));
                const raceResult = await Promise.race([exitPromise, hardDeadlinePromise]);
                if (raceResult.forceKilled) {
                    // Child never closed (D-state symptom). Stop tracking and force-resolve
                    // the awaiting caller with a distinct marker the bash tool renders sanely.
                    if (child.pid)
                        untrackDetachedChildPid(child.pid);
                    throw new Error("force-killed");
                }
                if (signal?.aborted) {
                    throw new Error("aborted");
                }
                if (timedOut) {
                    throw new Error(`timeout:${timeout}`);
                }
                return { exitCode: raceResult.code };
            }
            finally {
                if (child.pid)
                    untrackDetachedChildPid(child.pid);
                if (timeoutHandle)
                    clearTimeout(timeoutHandle);
                if (deadlineHandle)
                    clearTimeout(deadlineHandle);
                if (signal)
                    signal.removeEventListener("abort", onAbort);
            }
        },
    };
}
function resolveSpawnContext(command, cwd, spawnHook) {
    const baseContext = { command, cwd, env: { ...getShellEnv() } };
    return spawnHook ? spawnHook(baseContext) : baseContext;
}
const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;
class BashResultRenderComponent extends Container {
    state = {
        cachedWidth: undefined,
        cachedLines: undefined,
        cachedSkipped: undefined,
    };
}
function formatDuration(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}
function formatBashCall(args) {
    const command = str(args?.command);
    const timeout = args?.timeout;
    const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
    const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
    return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(component, result, options, showImages, startedAt, endedAt) {
    const state = component.state;
    component.clear();
    let output = getDisplayReason(result.details) ?? getTextOutput(result, showImages).trim();
    const truncation = result.details?.truncation;
    const fullOutputPath = result.details?.fullOutputPath;
    if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
        const footerStart = output.lastIndexOf("\n\n[");
        if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
            output = output.slice(0, footerStart).trimEnd();
        }
    }
    if (output) {
        const styledOutput = output
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n");
        if (options.expanded) {
            component.addChild(new Text(`\n${styledOutput}`, 0, 0));
        }
        else {
            component.addChild({
                render: (width) => {
                    if (state.cachedLines === undefined || state.cachedWidth !== width) {
                        const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
                        state.cachedLines = preview.visualLines;
                        state.cachedSkipped = preview.skippedCount;
                        state.cachedWidth = width;
                    }
                    if (state.cachedSkipped && state.cachedSkipped > 0) {
                        const hint = theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
                            ` ${keyHint("app.tools.expand", "to expand")})`;
                        return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
                    }
                    return ["", ...(state.cachedLines ?? [])];
                },
                invalidate: () => {
                    state.cachedWidth = undefined;
                    state.cachedLines = undefined;
                    state.cachedSkipped = undefined;
                },
            });
        }
    }
    if (truncation?.truncated || fullOutputPath) {
        const warnings = [];
        if (fullOutputPath) {
            warnings.push(`Full output: ${fullOutputPath}`);
        }
        if (truncation?.truncated) {
            if (truncation.truncatedBy === "lines") {
                warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
            }
            else {
                warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
            }
        }
        component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
    }
    if (startedAt !== undefined) {
        const label = options.isPartial ? "Elapsed" : "Took";
        const endTime = endedAt ?? Date.now();
        component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
    }
}
export function createBashToolDefinition(cwd, options) {
    const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
    const commandPrefix = options?.commandPrefix;
    const spawnHook = options?.spawnHook;
    return {
        name: "bash",
        label: "bash",
        description: `Execute a bash command. Returns stdout/stderr, truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Full output saved to temp file when truncated.`,
        promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
        parameters: bashSchema,
        async execute(_toolCallId, { command, timeout }, signal, onUpdate, _ctx) {
            const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
            const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
            const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
            let updateTimer;
            let updateDirty = false;
            let lastUpdateAt = 0;
            const emitOutputUpdate = () => {
                if (!onUpdate || !updateDirty)
                    return;
                updateDirty = false;
                lastUpdateAt = Date.now();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                onUpdate({
                    content: [{ type: "text", text: snapshot.content || "" }],
                    details: {
                        truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
                        fullOutputPath: snapshot.fullOutputPath,
                    },
                });
            };
            const clearUpdateTimer = () => {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                    updateTimer = undefined;
                }
            };
            const scheduleOutputUpdate = () => {
                if (!onUpdate)
                    return;
                updateDirty = true;
                const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
                if (delay <= 0) {
                    clearUpdateTimer();
                    emitOutputUpdate();
                    return;
                }
                updateTimer ??= setTimeout(() => {
                    updateTimer = undefined;
                    emitOutputUpdate();
                }, delay);
            };
            if (onUpdate) {
                onUpdate({ content: [], details: undefined });
            }
            const handleData = (data) => {
                output.append(data);
                scheduleOutputUpdate();
            };
            const finishOutput = async () => {
                output.finish();
                clearUpdateTimer();
                emitOutputUpdate();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                await output.closeTempFile();
                return snapshot;
            };
            const formatOutput = (snapshot, emptyText = "(no output)") => {
                const truncation = snapshot.truncation;
                let text = snapshot.content || emptyText;
                let details;
                if (truncation.truncated) {
                    details = { truncation, fullOutputPath: snapshot.fullOutputPath };
                    const startLine = truncation.totalLines - truncation.outputLines + 1;
                    const endLine = truncation.totalLines;
                    if (truncation.lastLinePartial) {
                        const lastLineSize = formatSize(output.getLastLineBytes());
                        text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
                    }
                    else if (truncation.truncatedBy === "lines") {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
                    }
                    else {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
                    }
                }
                return { text, details };
            };
            const appendStatus = (text, status) => `${text ? `${text}\n\n` : ""}${status}`;
            try {
                let exitCode;
                try {
                    const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
                        onData: handleData,
                        signal,
                        timeout,
                        env: spawnContext.env,
                    });
                    exitCode = result.exitCode;
                }
                catch (err) {
                    const snapshot = await finishOutput();
                    const { text } = formatOutput(snapshot, "");
                    if (err instanceof Error && err.message === "aborted") {
                        throw new Error(appendStatus(text, "Command aborted"));
                    }
                    if (err instanceof Error && err.message.startsWith("timeout:")) {
                        const timeoutSecs = err.message.split(":")[1];
                        throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
                    }
                    if (err instanceof Error && err.message === "force-killed") {
                        // Hard-deadline force-resolve: the child never closed even after SIGKILL
                        // (D-state symptom). Surface a distinct marker so an operator/agent can
                        // tell this apart from a clean SIGTERM exit. Partial output is preserved.
                        const suffix = timeout ? `Command timed out after ${timeout} seconds (force-killed)` : "Command force-killed";
                        throw new Error(appendStatus(text, suffix));
                    }
                    throw err;
                }
                const snapshot = await finishOutput();
                const { text: outputText, details } = formatOutput(snapshot);
                if (exitCode !== 0 && exitCode !== null) {
                    throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
                }
                return { content: [{ type: "text", text: outputText }], details };
            }
            finally {
                clearUpdateTimer();
            }
        },
        renderCall(args, _theme, context) {
            const state = context.state;
            if (context.executionStarted && state.startedAt === undefined) {
                state.startedAt = Date.now();
                state.endedAt = undefined;
            }
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatBashCall(args));
            return text;
        },
        renderResult(result, options, _theme, context) {
            const state = context.state;
            if (state.startedAt !== undefined && options.isPartial && !state.interval) {
                state.interval = setInterval(() => context.invalidate(), 1000);
            }
            if (!options.isPartial || context.isError) {
                state.endedAt ??= Date.now();
                if (state.interval) {
                    clearInterval(state.interval);
                    state.interval = undefined;
                }
            }
            const component = context.lastComponent ?? new BashResultRenderComponent();
            rebuildBashResultRenderComponent(component, result, options, context.showImages, state.startedAt, state.endedAt);
            component.invalidate();
            return component;
        },
    };
}
export function createBashTool(cwd, options) {
    return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
