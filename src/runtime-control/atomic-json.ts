// Project/App: gsd-pi
// File Purpose: Atomic JSON writes for daemon operation receipts. Not GSD projection files.

import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  const fileFd = openSync(tmpPath, fsConstants.O_RDONLY);
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    throw error;
  }
  try {
    const dirFd = openSync(dirname(filePath), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort on hosts that reject O_DIRECTORY.
  }
}
