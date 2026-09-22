// Project/App: gsd-pi
// File Purpose: Shared C05 admission test fixtures. Test-only.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetRequiredPolicyRegistryForTest } from "../../resources/extensions/gsd/required-policy.ts";
import {
  installTestRequiredPolicy,
  TEST_REQUIRED_POLICY_ID,
} from "../../resources/extensions/gsd/tests/required-policy-test-harness.ts";
import { resetCommandHandlerForTest } from "../command-handlers.ts";
import { RuntimeControl, resetRuntimeControlForTest, setRuntimeControlForTest } from "../control.ts";
import { resetNativeWorkflowOpsForTest } from "../native-commands.ts";
import { resetNativeAutoDispatchForTest } from "../native-auto-dispatch.ts";
import { resetIdleProbeForTest } from "../idle-probe.ts";
import { resetCancelNativeOpsForTest } from "../cancel.ts";
import { resetAnswersForTest } from "../answers.ts";
import { resetImportWriterForTest } from "../import-jobs.ts";
import { resetRecoveryForTest } from "../recovery.ts";
import { resetPrepareModeForTest } from "../prepare-boundary.ts";
import { resetWorkspaceProfilesForTest } from "../workspace-profile.ts";
import { resetAutoCancellationForTest } from "../../resources/extensions/gsd/auto-cancellation.ts";
import { resetJournalsForTest } from "../event-journal.ts";
import { resetEventHubForTest } from "../event-hub.ts";
import { resetObservationsForTest } from "../observation.ts";
import { resetSnapshotsForTest } from "../snapshots.ts";
import { resetWorkersForTest } from "../deep-links.ts";
import { resetModelCallsForTest } from "../model-calls.ts";
import { sealBackendBinding } from "../backend-binding.ts";
import type { BackendBinding, CommandRequest, JobRecord, RegistrationFile } from "../types.ts";

const DEFAULT_TEST_PROBE = "http://127.0.0.1:9/slots";

export function testBackendBinding(slotProbe = DEFAULT_TEST_PROBE): BackendBinding {
  return sealBackendBinding({
    version: 1,
    backend_id: "test-backend",
    provider: "llama-cpp",
    model_id: "test-model",
    api_base_url: "http://127.0.0.1:9/v1",
    slot_probe_url: slotProbe,
    expected_slot_ids: [0],
    expected_slot_count: 1,
    expected_context_capacity: 131072,
  });
}

function bindingForProject(project: {
  backend_idle_probe?: string | null;
  backend_binding?: BackendBinding | null;
}): BackendBinding | null {
  if (project.backend_binding === null) return null;
  if (project.backend_binding) return project.backend_binding;
  const probe = project.backend_idle_probe?.trim() ? project.backend_idle_probe : DEFAULT_TEST_PROBE;
  return testBackendBinding(probe);
}

export function uuid(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

export function startRequest(requestId: string, revision = 1, epoch = 1): CommandRequest {
  return {
    protocol_version: 1,
    request_id: requestId,
    expected_revision: revision,
    expected_epoch: epoch,
    action: "start",
    parameters: {},
  };
}

export function tempState(): string {
  return mkdtempSync(join(tmpdir(), "gsd-c05-state-"));
}

export function tempProject(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-c05-${label}-`));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

export function seedReadyProject(control: RuntimeControl, projectId: string, target: string, milestone = "M001"): JobRecord {
  installTestRequiredPolicy(target, { selfCheckReady: true });
  return control.seedJob({
    job_id: `${projectId}:${milestone}`,
    project_id: projectId,
    milestone_id: milestone,
    revision: 1,
    authority_epoch: 1,
  });
}

export function createControl(options: {
  projects: Array<{
    project_id: string;
    target: string;
    required_policy?: string;
    references?: Array<{ project_id: string; root: string }>;
    writable_cache_roots?: string[];
    backend_idle_probe?: string | null;
    backend_binding?: BackendBinding | null;
  }>;
  readyPolicy?: boolean;
  stateRoot?: string;
}): { control: RuntimeControl; stateRoot: string } {
  resetRequiredPolicyRegistryForTest();
  resetCommandHandlerForTest();
  const stateRoot = options.stateRoot ?? tempState();
  const registration: RegistrationFile = {
    projects: options.projects.map((project) => ({
      project_id: project.project_id,
      target_worktree: project.target,
      contract_root: ".gsd/ftm/contracts",
      reference_repositories: project.references ?? [],
      writable_cache_roots: project.writable_cache_roots ?? [],
      required_policy: project.required_policy ?? TEST_REQUIRED_POLICY_ID,
      backend_binding: bindingForProject(project),
      backend_idle_probe: bindingForProject(project)?.slot_probe_url ?? project.backend_idle_probe ?? null,
    })),
  };
  writeFileSync(join(stateRoot, "registration.json"), JSON.stringify(registration), "utf-8");
  const control = RuntimeControl.createForTest({
    stateRoot,
    registration,
    registrationPath: join(stateRoot, "registration.json"),
  });
  if (options.readyPolicy !== false) {
    for (const project of options.projects) {
      if ((project.required_policy ?? TEST_REQUIRED_POLICY_ID) === TEST_REQUIRED_POLICY_ID) {
        installTestRequiredPolicy(project.target, { selfCheckReady: true });
      }
    }
  }
  setRuntimeControlForTest(control);
  return { control, stateRoot };
}

export function reopenControl(stateRoot: string, projects: Array<{
  project_id: string;
  target: string;
  required_policy?: string;
  backend_idle_probe?: string | null;
  backend_binding?: BackendBinding | null;
}>): RuntimeControl {
  const registration: RegistrationFile = {
    projects: projects.map((project) => {
      const binding = bindingForProject(project);
      return {
        project_id: project.project_id,
        target_worktree: project.target,
        contract_root: ".gsd/ftm/contracts",
        reference_repositories: [],
        writable_cache_roots: [],
        required_policy: project.required_policy ?? TEST_REQUIRED_POLICY_ID,
        backend_binding: binding,
        backend_idle_probe: binding?.slot_probe_url ?? null,
      };
    }),
  };
  const control = RuntimeControl.reopen(stateRoot, { registration });
  setRuntimeControlForTest(control);
  return control;
}

export function resetC05(): void {
  resetRequiredPolicyRegistryForTest();
  resetCommandHandlerForTest();
  resetRuntimeControlForTest();
  resetNativeWorkflowOpsForTest();
  resetNativeAutoDispatchForTest();
  delete process.env.GSD_WEB_DAEMON_MODE;
  resetIdleProbeForTest();
  resetCancelNativeOpsForTest();
  resetAnswersForTest();
  resetImportWriterForTest();
  resetRecoveryForTest();
  resetPrepareModeForTest();
  resetWorkspaceProfilesForTest();
  resetAutoCancellationForTest();
  resetJournalsForTest();
  resetEventHubForTest();
  resetObservationsForTest();
  resetSnapshotsForTest();
  resetWorkersForTest();
  resetModelCallsForTest();
  delete process.env.GSD_MILESTONE_LOCK;
}
