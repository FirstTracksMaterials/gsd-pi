#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const pairs = [
  {
    source: "src/resources/extensions/gsd/auto-dispatch.ts",
    loaded: "dist/resources/extensions/gsd/auto-dispatch.js",
    needle: 'task.status === "pending" || task.status === "in_progress"',
    missing: "RPC worker auto-dispatch.js is missing the pending-task guard present in source.",
  },
  {
    source: "src/resources/extensions/gsd/auto/dispatch.ts",
    loaded: "dist/resources/extensions/gsd/auto/dispatch.js",
    needle: "recordPrepareBoundaryStop",
    missing: "RPC worker auto/dispatch.js is missing the prepare-boundary stop present in source.",
  },
  {
    source: "src/runtime-control/prepare-boundary.ts",
    loaded: "dist/runtime-control/prepare-boundary.js",
    needle: "prepare-mode.json",
    missing: "RPC worker prepare-boundary.js is missing the on-disk prepare marker present in source.",
  },
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

for (const pair of pairs) {
  const source = join(root, pair.source);
  const loaded = join(root, pair.loaded);
  const sourceText = readFileSync(source, "utf-8");
  const loadedText = readFileSync(loaded, "utf-8");
  if (statSync(source).mtimeMs > statSync(loaded).mtimeMs + 1000) {
    console.error(`${pair.loaded} is older than ${pair.source}. Run pnpm run copy-resources before packaging the host.`);
    process.exit(1);
  }
  if (sourceText.includes(pair.needle) && !loadedText.includes(pair.needle)) {
    console.error(pair.missing);
    process.exit(1);
  }
  console.log(sha256(source), pair.source);
  console.log(sha256(loaded), pair.loaded);
}
