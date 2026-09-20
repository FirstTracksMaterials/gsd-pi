// Project/App: gsd-pi
// File Purpose: Daemon runtime-control singleton. Reconstruct from the same state root to simulate restart.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { gsdHome } from "../resources/extensions/gsd/gsd-home.ts";
import { JobCatalog } from "./job-catalog.ts";
import { ModelLease } from "./model-lease.ts";
import { OperationStore } from "./operation-store.ts";
import { RegistrationRegistry } from "./registration.ts";
import type { CrashHook, JobRecord, RegistrationFile } from "./types.ts";

export type RuntimeControlOptions = {
  stateRoot: string;
  registrationPath?: string;
  registration?: RegistrationFile;
  clock?: () => Date;
  loadEnv?: boolean;
};

export class RuntimeControl {
  readonly registration: RegistrationRegistry;
  readonly jobs: JobCatalog;
  readonly store: OperationStore;
  readonly lease: ModelLease;
  readonly clock: () => Date;
  readonly stateRoot: string;

  constructor(options: RuntimeControlOptions) {
    this.stateRoot = options.stateRoot;
    mkdirSync(join(options.stateRoot, "runtime-control"), { recursive: true });
    this.lease = new ModelLease(options.stateRoot);
    this.registration = new RegistrationRegistry(() => this.lease.isHeld());
    this.jobs = new JobCatalog();
    this.store = new OperationStore(options.stateRoot);
    this.clock = options.clock ?? (() => new Date());
    const recovered = this.store.reconcile();
    for (const operationId of recovered.recoveryRequired) {
      this.lease.retainForRecovery(operationId);
    }
    if (options.registration) {
      this.registration.loadFromObject(options.registration, options.registrationPath ?? "<memory>");
    } else if (options.registrationPath) {
      this.registration.loadFromPath(options.registrationPath);
    } else if (options.loadEnv !== false) {
      this.registration.loadFromEnv();
    }
  }

  seedJob(job: JobRecord): JobRecord {
    return this.jobs.seed(job);
  }

  setCrashHookForTest(hook: CrashHook): void {
    this.store.setCrashHookForTest(hook);
  }

  static createForTest(options: Omit<RuntimeControlOptions, "loadEnv">): RuntimeControl {
    return new RuntimeControl({ ...options, loadEnv: false });
  }

  static reopen(stateRoot: string, options: Omit<RuntimeControlOptions, "stateRoot"> = {}): RuntimeControl {
    return new RuntimeControl({ stateRoot, loadEnv: false, ...options });
  }
}

let daemon: RuntimeControl | null = null;

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GSD_STATE_DIR && env.GSD_STATE_DIR.trim()) return env.GSD_STATE_DIR.trim();
  return gsdHome();
}

export function getRuntimeControl(): RuntimeControl {
  if (!daemon) {
    daemon = new RuntimeControl({ stateRoot: resolveStateRoot(), loadEnv: true });
  }
  return daemon;
}

export function setRuntimeControlForTest(control: RuntimeControl | null): void {
  daemon = control;
}

export function resetRuntimeControlForTest(): void {
  daemon = null;
}
