import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DAEMON_BOOTSTRAP_ABORT_REASON,
  recordDaemonBootstrapAbort,
} from "../auto-start.ts";

test("daemon bootstrap abort writes a visible runtime-control record", () => {
  const root = mkdtempSync(join(tmpdir(), "c15l-bootstrap-abort-"));
  const previous = process.env.GSD_STATE_DIR;
  process.env.GSD_STATE_DIR = root;
  try {
    recordDaemonBootstrapAbort(DAEMON_BOOTSTRAP_ABORT_REASON);
    const recorded = JSON.parse(
      readFileSync(join(root, "runtime-control", "bootstrap-abort.json"), "utf-8"),
    ) as { reason: string };
    assert.equal(recorded.reason, DAEMON_BOOTSTRAP_ABORT_REASON);
    assert.match(recorded.reason, /interactive init wizard/);
  } finally {
    if (previous === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged RPC UI context is marked non-interactive", async () => {
  const { readFileSync: read } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const rpcMode = read(
    resolve(here, "../../../../../packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts"),
    "utf-8",
  );
  assert.match(
    rpcMode,
    /mode:\s*"rpc"/,
    "RPC extension UI must set mode rpc so packaged auto cannot hang on TUI select",
  );
});
