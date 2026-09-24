#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const source = join(root, "src/resources/extensions/gsd/auto-dispatch.ts");
const loaded = join(root, "dist/resources/extensions/gsd/auto-dispatch.js");
const needle = 'task.status === "pending" || task.status === "in_progress"';

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sourceText = readFileSync(source, "utf-8");
const loadedText = readFileSync(loaded, "utf-8");
const sourceNewer = statSync(source).mtimeMs > statSync(loaded).mtimeMs + 1000;
if (sourceNewer) {
  console.error("RPC worker auto-dispatch.js is older than auto-dispatch.ts. Run pnpm run copy-resources before packaging the host.");
  process.exit(1);
}
if (sourceText.includes(needle) && !loadedText.includes(needle)) {
  console.error("RPC worker auto-dispatch.js is missing the pending-task guard present in source.");
  process.exit(1);
}
console.log(sha256(source), "src/resources/extensions/gsd/auto-dispatch.ts");
console.log(sha256(loaded), "dist/resources/extensions/gsd/auto-dispatch.js");
