// Project/App: gsd-pi
// File Purpose: C03 GSD_REQUIRED_POLICY_MODULE loader. Owner C03; used by C14 real daemon.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { getRegisteredRequiredPolicy, resetRequiredPolicyRegistryForTest } from "../../resources/extensions/gsd/required-policy.ts";
import {
  loadRequiredPolicyModule,
  REQUIRED_POLICY_MODULE_ENV,
  requiredPolicyModuleError,
  resetRuntimeControlForTest,
} from "../control.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, "c14-policy-module.ts");

afterEach(() => {
  delete process.env[REQUIRED_POLICY_MODULE_ENV];
  resetRequiredPolicyRegistryForTest();
  resetRuntimeControlForTest();
});

test("unset GSD_REQUIRED_POLICY_MODULE leaves the registry empty (fail closed)", async () => {
  delete process.env[REQUIRED_POLICY_MODULE_ENV];
  await loadRequiredPolicyModule();
  assert.equal(getRegisteredRequiredPolicy("test-policy/v1"), undefined);
  assert.equal(requiredPolicyModuleError(), null);
});

test("GSD_REQUIRED_POLICY_MODULE registers the exported policy into the daemon Map", async () => {
  process.env[REQUIRED_POLICY_MODULE_ENV] = modulePath;
  await loadRequiredPolicyModule();
  const policy = getRegisteredRequiredPolicy("test-policy/v1");
  assert.equal(policy?.id, "test-policy/v1");
  assert.equal(requiredPolicyModuleError(), null);
  const ready = await policy!.selfCheck({
    basePath: here,
    phase: "task",
    runHostCheck: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
  });
  assert.equal(ready.ready, true);
});

test("missing GSD_REQUIRED_POLICY_MODULE file fails closed without throwing", async () => {
  process.env[REQUIRED_POLICY_MODULE_ENV] = join(here, "does-not-exist.ts");
  await loadRequiredPolicyModule();
  assert.equal(getRegisteredRequiredPolicy("test-policy/v1"), undefined);
  assert.match(requiredPolicyModuleError() ?? "", /missing/);
});
