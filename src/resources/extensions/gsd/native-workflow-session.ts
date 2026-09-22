// Project/App: gsd-pi
// File Purpose: Bind a native review or replan invocation to the operation that started it.

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type NativeWorkflowSession = {
  kind: "review" | "replan";
  operation_id: string;
  job_id: string;
  milestone_id: string;
  revision: number;
  started_at: string;
  completed_task_ids: string[];
};

export type NativeReviewArtifact = {
  operation_id: string;
  job_id: string;
  milestone_id: string;
  revision: number;
  executed: true;
  findings: unknown[];
  product_mutated: false;
};

export type NativeReplanArtifact = {
  operation_id: string;
  job_id: string;
  milestone_id: string;
  revision: number;
  plan_path: string;
  replan_path: string;
  preserved_completed: true;
  completed_task_ids: string[];
};

function sessionPath(basePath: string): string {
  return join(basePath, ".gsd", "runtime", "native-workflow.json");
}

export function reviewArtifactPath(basePath: string, milestoneId: string): string {
  return join(basePath, ".gsd", "reviews", `${milestoneId}.json`);
}

export function replanArtifactPath(basePath: string): string {
  return join(basePath, ".gsd", "runtime", "native-replan.json");
}

export function completedTaskIdsInTree(basePath: string): string[] {
  const ids = new Set<string>();
  const root = join(basePath, ".gsd");
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        visit(path);
        continue;
      }
      if (!name.name.endsWith(".md")) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/\[x\][^\n]*\b(T\d+)\b/gi)) {
        if (match[1]) ids.add(match[1].toUpperCase());
      }
    }
  };
  visit(root);
  return [...ids];
}

export function beginNativeWorkflow(basePath: string, session: NativeWorkflowSession): void {
  const path = sessionPath(basePath);
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });
  writeFileSync(path, JSON.stringify(session), "utf8");
}

export function readNativeWorkflow(basePath: string): NativeWorkflowSession | null {
  const path = sessionPath(basePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeWorkflowSession>;
    if (parsed.kind !== "review" && parsed.kind !== "replan") return null;
    if (typeof parsed.operation_id !== "string" || typeof parsed.job_id !== "string") return null;
    if (typeof parsed.milestone_id !== "string" || typeof parsed.revision !== "number") return null;
    return {
      kind: parsed.kind,
      operation_id: parsed.operation_id,
      job_id: parsed.job_id,
      milestone_id: parsed.milestone_id,
      revision: parsed.revision,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
      completed_task_ids: Array.isArray(parsed.completed_task_ids)
        ? parsed.completed_task_ids.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function clearNativeWorkflow(basePath: string): void {
  const path = sessionPath(basePath);
  if (existsSync(path)) unlinkSync(path);
}

function messageText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "assistant") continue;
    const content = record.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") parts.push(part);
        else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n");
}

export function extractReviewFindings(messages: unknown[]): unknown[] {
  const text = messageText(messages);
  const marker = text.indexOf('"findings"');
  if (marker < 0) return [];
  const start = text.lastIndexOf("{", marker);
  if (start < 0) return [];
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1)) as { findings?: unknown };
          return Array.isArray(parsed.findings) ? parsed.findings : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export function publishReviewCompletion(basePath: string, messages: unknown[], aborted: boolean): void {
  const session = readNativeWorkflow(basePath);
  if (!session || session.kind !== "review") return;
  clearNativeWorkflow(basePath);
  if (aborted) return;
  const artifact: NativeReviewArtifact = {
    operation_id: session.operation_id,
    job_id: session.job_id,
    milestone_id: session.milestone_id,
    revision: session.revision,
    executed: true,
    findings: extractReviewFindings(messages),
    product_mutated: false,
  };
  const path = reviewArtifactPath(basePath, session.milestone_id);
  mkdirSync(join(basePath, ".gsd", "reviews"), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact), "utf8");
}

export function recordReplanPersistence(
  basePath: string,
  result: { milestoneId: string; planPath: string; replanPath: string },
): void {
  const session = readNativeWorkflow(basePath);
  if (!session || session.kind !== "replan") return;
  if (session.milestone_id !== result.milestoneId) return;
  let plan = "";
  try {
    plan = readFileSync(result.planPath, "utf8");
  } catch {
    return;
  }
  for (const taskId of session.completed_task_ids) {
    if (!plan.includes(taskId)) return;
  }
  const artifact: NativeReplanArtifact = {
    operation_id: session.operation_id,
    job_id: session.job_id,
    milestone_id: session.milestone_id,
    revision: session.revision,
    plan_path: result.planPath,
    replan_path: result.replanPath,
    preserved_completed: true,
    completed_task_ids: session.completed_task_ids,
  };
  writeFileSync(replanArtifactPath(basePath), JSON.stringify(artifact), "utf8");
}

export function finishReplanSession(basePath: string, aborted: boolean): void {
  const session = readNativeWorkflow(basePath);
  if (!session || session.kind !== "replan") return;
  clearNativeWorkflow(basePath);
  if (aborted && existsSync(replanArtifactPath(basePath))) unlinkSync(replanArtifactPath(basePath));
}
