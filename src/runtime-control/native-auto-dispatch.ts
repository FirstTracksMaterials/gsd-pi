// Project/App: gsd-pi
// File Purpose: C06 start/resume dispatch of existing native auto. Does not await generation.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type NativeAutoDispatchInput = {
  basePath: string;
  milestoneId: string;
  resume: boolean;
};

export type NativeAutoDispatcher = (input: NativeAutoDispatchInput) => Promise<void> | void;

let testDispatcher: NativeAutoDispatcher | null = null;

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
      };
      const message = input.resume ? "/gsd auto" : "/gsd auto";
      await loaded.sendBridgeInput({ type: "prompt", message }, input.basePath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function dispatchNativeScopedAuto(input: NativeAutoDispatchInput): Promise<{ dispatched: boolean }> {
  if (testDispatcher) {
    await testDispatcher(input);
    return { dispatched: true };
  }
  if (process.env.GSD_WEB_DAEMON_MODE !== "1") {
    return { dispatched: false };
  }
  await sendExistingBridgeAuto(input);
  return { dispatched: true };
}
