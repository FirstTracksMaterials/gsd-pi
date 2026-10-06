// Project/App: gsd-pi
// File Purpose: C06 start/resume dispatch of existing native auto. Does not await generation.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type NativeAutoDispatchInput = {
  basePath: string;
  milestoneId: string;
  resume: boolean;
  onEvent?: (event: unknown) => void;
};

export type NativeAutoDispatcher = (input: NativeAutoDispatchInput) => Promise<void> | void;

let installedDispatcher: NativeAutoDispatcher | null = null;
let testDispatcher: NativeAutoDispatcher | null = null;

export function registerNativeAutoDispatch(dispatcher: NativeAutoDispatcher | null): void {
  installedDispatcher = dispatcher;
}

export function registerNativeAutoDispatchForTest(dispatcher: NativeAutoDispatcher | null): void {
  testDispatcher = dispatcher;
}

export function resetNativeAutoDispatchForTest(): void {
  testDispatcher = null;
}

async function sendExistingBridgeAuto(input: NativeAutoDispatchInput): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = process.env.GSD_WEB_PACKAGE_ROOT?.trim();
  const candidates = [
    packaged ? join(packaged, "src", "web", "bridge-service.ts") : "",
    join(here, "..", "web", "bridge-service.ts"),
  ].filter((path) => path && existsSync(path));
  let lastError: unknown = new Error("bridge-service was not found beside the runtime or GSD_WEB_PACKAGE_ROOT");
  for (const candidate of candidates) {
    try {
      const loaded = await import(/* webpackIgnore: true */ pathToFileURL(candidate).href) as {
        sendBridgeInput: (command: { type: string; message: string }, cwd?: string) => Promise<unknown>;
        getProjectBridgeServiceForCwd: (cwd: string) => {
          subscribe: (listener: (event: unknown) => void) => () => void;
        };
      };
      let unsubscribe = (): void => undefined;
      if (input.onEvent) {
        const bridge = loaded.getProjectBridgeServiceForCwd(input.basePath);
        unsubscribe = bridge.subscribe((event) => {
          input.onEvent?.(event);
          if (event && typeof event === "object" && "type" in event && (event as { type?: string }).type === "agent_end") {
            unsubscribe();
          }
        });
      }
      const message = input.resume ? "/gsd auto --native-resume" : "/gsd auto";
      try {
        await loaded.sendBridgeInput({ type: "prompt", message }, input.basePath);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export class NativeDispatchError extends Error {
  readonly sideEffectsBegan: boolean;

  constructor(message: string, sideEffectsBegan: boolean) {
    super(message);
    this.name = "NativeDispatchError";
    this.sideEffectsBegan = sideEffectsBegan;
  }
}

export async function dispatchNativeScopedAuto(input: NativeAutoDispatchInput): Promise<{ dispatched: boolean }> {
  const dispatcher = testDispatcher ?? installedDispatcher;
  if (dispatcher) {
    await dispatcher(input);
    return { dispatched: true };
  }
  if (process.env.GSD_WEB_DAEMON_MODE !== "1") {
    return { dispatched: false };
  }
  await sendExistingBridgeAuto(input);
  return { dispatched: true };
}
