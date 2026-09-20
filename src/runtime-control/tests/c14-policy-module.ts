// Project/App: gsd-pi
// File Purpose: Explicit C14/C03 test-only RequiredPolicy export. Never auto-selected.

import type { RequiredPolicy } from "../../resources/extensions/gsd/required-policy.ts";

const policy: RequiredPolicy = {
  id: "test-policy/v1",
  version: "1",
  async selfCheck() {
    return { ready: true };
  },
  async validatePlan() {
    return { policy_id: "test-policy/v1", version: "1", verdict: "pass", checks: [], evidence: [] };
  },
  async verifyTask() {
    return { policy_id: "test-policy/v1", version: "1", verdict: "pass", checks: [], evidence: [] };
  },
};

export default policy;
