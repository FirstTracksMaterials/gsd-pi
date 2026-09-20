// Project/App: gsd-pi
// File Purpose: Durable operation files plus request-id index. Single daemon writer.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import type { CrashHook, Operation, StoredOperation } from "./types.ts";

export class OperationStore {
  readonly stateRoot: string;
  readonly operationsDir: string;
  readonly requestsDir: string;
  private crashHook: CrashHook = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.operationsDir = join(stateRoot, "runtime-control", "operations");
    this.requestsDir = join(stateRoot, "runtime-control", "requests");
    mkdirSync(this.operationsDir, { recursive: true });
    mkdirSync(this.requestsDir, { recursive: true });
  }

  setCrashHookForTest(hook: CrashHook): void {
    this.crashHook = hook;
  }

  async withWriter<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeChain;
    this.writeChain = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  reconcile(): { rebuilt: number; recoveryRequired: string[] } {
    mkdirSync(this.operationsDir, { recursive: true });
    mkdirSync(this.requestsDir, { recursive: true });
    let rebuilt = 0;
    const recoveryRequired: string[] = [];
    if (!existsSync(this.operationsDir)) return { rebuilt, recoveryRequired };
    for (const name of readdirSync(this.operationsDir)) {
      if (!name.endsWith(".json")) continue;
      const stored = this.readOperationFile(join(this.operationsDir, name));
      if (!stored) continue;
      const indexPath = join(this.requestsDir, `${stored.operation.request_id}.json`);
      if (!existsSync(indexPath)) {
        atomicWriteJson(indexPath, {
          operation_id: stored.operation.operation_id,
          fingerprint: stored.fingerprint,
        });
        rebuilt += 1;
      }
      if (this.isUncertainDispatch(stored)) {
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = stored.operation.updated_at;
        stored.operation.error = {
          code: "recovery_required",
          message: "Dispatch was interrupted; native recovery is required. Side effects were not replayed.",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        atomicWriteJson(this.operationPath(stored.operation.operation_id), stored);
        recoveryRequired.push(stored.operation.operation_id);
      }
    }
    return { rebuilt, recoveryRequired };
  }

  private isUncertainDispatch(stored: StoredOperation): boolean {
    if (!stored.dispatch_intent) return false;
    return stored.operation.state === "accepted" || stored.operation.state === "running";
  }

  operationPath(operationId: string): string {
    return join(this.operationsDir, `${operationId}.json`);
  }

  requestPath(requestId: string): string {
    return join(this.requestsDir, `${requestId}.json`);
  }

  read(operationId: string): StoredOperation | undefined {
    const path = this.operationPath(operationId);
    if (!existsSync(path)) return undefined;
    return this.readOperationFile(path);
  }

  lookupByRequest(requestId: string): StoredOperation | undefined {
    const path = this.requestPath(requestId);
    if (!existsSync(path)) return undefined;
    try {
      const index = JSON.parse(readFileSync(path, "utf-8")) as { operation_id?: string };
      if (!index.operation_id) return undefined;
      return this.read(index.operation_id);
    } catch {
      return undefined;
    }
  }

  writeAccepted(stored: StoredOperation): void {
    if (this.crashHook === "before_receipt") {
      throw new CrashWindowError("before_receipt");
    }
    atomicWriteJson(this.operationPath(stored.operation.operation_id), stored);
    if (this.crashHook === "before_index") {
      throw new CrashWindowError("before_index");
    }
    atomicWriteJson(this.requestPath(stored.operation.request_id), {
      operation_id: stored.operation.operation_id,
      fingerprint: stored.fingerprint,
    });
  }

  writeDispatchIntent(stored: StoredOperation): void {
    stored.dispatch_intent = true;
    if (stored.operation.state === "accepted") stored.operation.state = "running";
    atomicWriteJson(this.operationPath(stored.operation.operation_id), stored);
    if (this.crashHook === "after_dispatch_intent") {
      throw new CrashWindowError("after_dispatch_intent");
    }
  }

  update(stored: StoredOperation): void {
    atomicWriteJson(this.operationPath(stored.operation.operation_id), stored);
  }

  publicOperation(stored: StoredOperation): Operation {
    return stored.operation;
  }

  private readOperationFile(path: string): StoredOperation | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as StoredOperation;
      if (!parsed?.operation?.operation_id) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

export class CrashWindowError extends Error {
  readonly hook: Exclude<CrashHook, null>;
  constructor(hook: Exclude<CrashHook, null>) {
    super(`Injected crash window: ${hook}`);
    this.name = "CrashWindowError";
    this.hook = hook;
  }
}
