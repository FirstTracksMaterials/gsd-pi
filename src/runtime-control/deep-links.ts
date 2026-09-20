// Project/App: gsd-pi
// File Purpose: Read-only GSD web UI question/session URLs. Same-worker identity via project cwd.

import { canonicalRealpath } from "./workspace-profile.ts";

const attached = new Map<string, { cwd: string; session_id: string | null }>();

export function workerKeyForCwd(cwd: string): string {
  return canonicalRealpath(cwd);
}

export function attachSameWorker(cwd: string, sessionId?: string | null): {
  key: string;
  created: boolean;
  cwd: string;
  session_id: string | null;
} {
  const key = workerKeyForCwd(cwd);
  const existing = attached.get(key);
  if (existing) {
    if (sessionId && !existing.session_id) existing.session_id = sessionId;
    return { key, created: false, cwd: existing.cwd, session_id: existing.session_id };
  }
  const created = { cwd: key, session_id: sessionId ?? null };
  attached.set(key, created);
  return { key, created: true, ...created };
}

export function resetWorkersForTest(): void {
  attached.clear();
}

export function buildQuestionSessionUrl(input: {
  targetRealpath: string;
  sessionId: string;
  questionId: string;
  origin?: string;
}): string {
  const params = new URLSearchParams({
    project: workerKeyForCwd(input.targetRealpath),
    session: input.sessionId,
    question: input.questionId,
  });
  const path = `/?${params.toString()}`;
  if (!input.origin) return path;
  return `${input.origin.replace(/\/$/, "")}${path}`;
}
