// Project/App: gsd-pi
// File Purpose: Invalidate affected verification evidence on replan without deleting it.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function invalidateAffectedVerificationEvidence(input: {
  basePath: string;
  milestoneId: string;
  reason: string;
}): string[] {
  const evidenceDir = join(input.basePath, ".gsd", "evidence");
  const ids: string[] = [];
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      if (name.includes(input.milestoneId)) ids.push(name);
    }
  }
  if (ids.length === 0) ids.push(`evidence:${input.milestoneId}`);
  const stampDir = join(input.basePath, ".gsd", "runtime", "invalidated-evidence");
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(
    join(stampDir, `${input.milestoneId}.json`),
    JSON.stringify({
      milestoneId: input.milestoneId,
      reason: input.reason,
      evidence_ids: ids,
      deleted: false,
    }),
    "utf-8",
  );
  return ids;
}
