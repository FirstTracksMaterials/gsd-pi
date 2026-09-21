import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimeControlModule } from "../runtime-control-load.ts";

const gsdRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

test("runtime-control-load uses GSD_WEB_PACKAGE_ROOT when copied away from src/resources", () => {
  const copiedHere = mkdtempSync(join(tmpdir(), "c15l-runtime-control-load-"));
  const previous = process.env.GSD_WEB_PACKAGE_ROOT;
  process.env.GSD_WEB_PACKAGE_ROOT = gsdRoot;
  try {
    const resolved = resolveRuntimeControlModule("workspace-profile.ts", copiedHere);
    assert.match(resolved, /runtime-control\/workspace-profile\.ts$/);
    assert.ok(resolved.startsWith(gsdRoot));
  } finally {
    if (previous === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT;
    else process.env.GSD_WEB_PACKAGE_ROOT = previous;
    rmSync(copiedHere, { recursive: true, force: true });
  }
});
