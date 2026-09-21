// Project/App: gsd-pi
// File Purpose: File-backed pending questions for the packaged web daemon (same process as runtime-v1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PendingQuestion = {
  question_id: string;
  job_id: string;
  session_id: string;
  title?: string;
  summary?: string;
  method?: "select" | "confirm" | "input" | "editor";
};

export type DaemonPendingRecord = PendingQuestion & {
  cwd?: string;
  created_at: string;
};

export type DaemonAnswerRecord = {
  question_id: string;
  job_id: string;
  response: unknown;
  answered_at: string;
};

function stateRoot(): string {
  return (process.env.GSD_STATE_DIR ?? "").trim();
}

function pendingPath(): string {
  return join(stateRoot(), "runtime-control", "pending-questions.json");
}

function answersDir(): string {
  return join(stateRoot(), "runtime-control", "daemon-answers");
}

function leasePath(): string {
  return join(stateRoot(), "runtime-control", "lease.json");
}

function jobsPath(): string {
  return join(stateRoot(), "runtime-control", "jobs.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function resolveDaemonJobId(cwd?: string): string | null {
  const lease = readJson<{ lease?: { job_id?: string | null } | null }>(leasePath(), {});
  if (lease.lease?.job_id) return lease.lease.job_id;
  const jobs = readJson<{ jobs?: Array<{ job_id: string; project_id: string }> }>(jobsPath(), { jobs: [] });
  const registrationPath = (process.env.GSD_RUNTIME_REGISTRATION ?? "").trim();
  if (cwd && registrationPath && existsSync(registrationPath)) {
    const registration = readJson<{ projects?: Array<{ project_id: string; target_worktree?: string }> }>(
      registrationPath,
      {},
    );
    const project = (registration.projects ?? []).find((item) => item.target_worktree === cwd);
    if (project) {
      const match = (jobs.jobs ?? []).find((job) => job.project_id === project.project_id);
      if (match) return match.job_id;
    }
  }
  return (jobs.jobs ?? [])[0]?.job_id ?? null;
}

export function listDaemonPendingQuestions(): DaemonPendingRecord[] {
  if (!stateRoot()) return [];
  const parsed = readJson<{ questions?: DaemonPendingRecord[] }>(pendingPath(), { questions: [] });
  return parsed.questions ?? [];
}

export function persistDaemonPendingQuestion(question: PendingQuestion & { cwd?: string }): void {
  if (!stateRoot()) return;
  const path = pendingPath();
  mkdirSync(join(stateRoot(), "runtime-control"), { recursive: true });
  const existing = listDaemonPendingQuestions().filter(
    (item) => !(item.job_id === question.job_id && item.question_id === question.question_id),
  );
  existing.push({ ...question, created_at: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify({ questions: existing }, null, 2)}\n`, "utf-8");
}

export function clearDaemonPendingQuestion(jobId: string, questionId: string): void {
  if (!stateRoot()) return;
  const remaining = listDaemonPendingQuestions().filter(
    (item) => !(item.job_id === jobId && item.question_id === questionId),
  );
  writeFileSync(pendingPath(), `${JSON.stringify({ questions: remaining }, null, 2)}\n`, "utf-8");
}

export function persistDaemonAnswer(record: DaemonAnswerRecord): void {
  if (!stateRoot()) return;
  mkdirSync(answersDir(), { recursive: true });
  writeFileSync(
    join(answersDir(), `${record.question_id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8",
  );
}

export function readDaemonAnswer(questionId: string): DaemonAnswerRecord | null {
  if (!stateRoot()) return null;
  const path = join(answersDir(), `${questionId}.json`);
  if (!existsSync(path)) return null;
  return readJson<DaemonAnswerRecord | null>(path, null);
}

export async function waitForDaemonAnswer(
  questionId: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<DaemonAnswerRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const found = readDaemonAnswer(questionId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
