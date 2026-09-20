// Project/App: gsd-pi
// File Purpose: Cached content-identity of relevant source/output for idle progress.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HOST_CHECK_LOG_EXCLUDE_PATHS } from "./host-check-runner.js";

/** Paths that must never rearm idle progress even when dirty. */
export const USEFUL_PROGRESS_EXCLUDE_PATHS = [
  ...HOST_CHECK_LOG_EXCLUDE_PATHS,
  ".gsd/runtime",
  ".gsd/runtime/**",
  ".gsd/evidence",
  ".gsd/evidence/**",
  ".gsd/journal",
  ".gsd/journal/**",
  ".gsd/audit",
  ".gsd/audit/**",
  ".gsd/event-log.jsonl",
  ".gsd/event-log-*.jsonl.archived",
] as const;

export interface UsefulProgressObservation {
  identity: string;
  changed: boolean;
}

interface ContentCacheEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

const identityCache = new Map<string, { at: number; identity: string }>();
const contentCache = new Map<string, ContentCacheEntry>();
const IDENTITY_CACHE_TTL_MS = 15_000;

export function resetUsefulProgressCacheForTest(): void {
  identityCache.clear();
  contentCache.clear();
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isExcludedPath(path: string): boolean {
  const relative = normalizePath(path);
  if (
    relative === ".gsd/runtime"
    || relative.startsWith(".gsd/runtime/")
    || relative === ".gsd/evidence"
    || relative.startsWith(".gsd/evidence/")
    || relative === ".gsd/journal"
    || relative.startsWith(".gsd/journal/")
    || relative === ".gsd/audit"
    || relative.startsWith(".gsd/audit/")
    || relative === ".gsd/event-log.jsonl"
    || /^event-log-.*\.jsonl\.archived$/.test(relative)
    || relative.startsWith(".gsd/event-log-")
  ) {
    return true;
  }
  if (/(^|\/)heartbeat($|[./])/i.test(relative)) return true;
  return false;
}

function hashFile(cwd: string, relativePath: string): string {
  const absolute = join(cwd, relativePath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    return "missing";
  }
  if (stat.isDirectory()) return "dir";
  const cacheKey = `${absolute}\0${stat.size}\0${stat.mtimeMs}`;
  const cached = contentCache.get(absolute);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.hash;
  }
  const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  contentCache.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
  void cacheKey;
  return hash;
}

function relevantDirtyPaths(cwd: string): string[] {
  const exclusions = USEFUL_PROGRESS_EXCLUDE_PATHS.map((path) => `:(exclude)${path}`);
  const listed = gitOutput(cwd, [
    "ls-files",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ...exclusions,
  ])
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter((path) => !isExcludedPath(path));
  return [...new Set(listed)].sort();
}

export function captureUsefulProgressIdentity(cwd: string, nowMs = Date.now()): string {
  const cached = identityCache.get(cwd);
  if (cached && nowMs - cached.at < IDENTITY_CACHE_TTL_MS) return cached.identity;

  const head = gitOutput(cwd, ["rev-parse", "HEAD"]).trim() || "unborn";
  const hash = createHash("sha256");
  hash.update(`head:${head}\n`);
  for (const path of relevantDirtyPaths(cwd)) {
    hash.update(`${path}:${hashFile(cwd, path)}\n`);
  }
  const identity = `sha256:${hash.digest("hex")}`;
  identityCache.set(cwd, { at: nowMs, identity });
  return identity;
}

export function observeUsefulProgress(
  cwd: string,
  previousIdentity: string | null | undefined,
  nowMs = Date.now(),
): UsefulProgressObservation {
  const identity = captureUsefulProgressIdentity(cwd, nowMs);
  if (!previousIdentity) return { identity, changed: false };
  return { identity, changed: identity !== previousIdentity };
}

export function detectUsefulWorkingTreeProgress(
  cwd: string,
  previousIdentity: string | null | undefined,
): boolean {
  return observeUsefulProgress(cwd, previousIdentity).changed;
}
