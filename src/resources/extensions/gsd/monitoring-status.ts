// Project/App: gsd-pi
// File Purpose: Pure builders for the structured GSD monitoring contract.

import type { DbProjectSnapshot } from "./state/project-snapshot.js";
import type { DbProjectProgressResult } from "./state/progress-from-db.js";
import type { AutoRuntimeSnapshot } from "./auto-runtime-state.js";
import type { ProgressScore } from "./progress-score.js";
import {
  aggregateByModel,
  aggregateByPhase,
  aggregateBySlice,
  filterUnitsForMilestone,
  getProjectTotals,
  type UnitMetrics,
} from "./metrics.js";

export type GsdMonitoringStatus = {
  captured_at: string;
  authority: { source: "database"; revision: number; authority_epoch: number };
  current: {
    milestone: { id: string; title: string } | null;
    slice: { id: string; title: string } | null;
    task: { id: string; title: string } | null;
    phase: string;
    next_action: string;
  };
  progress: {
    milestones: DbProjectProgressResult["milestones"];
    slices: DbProjectProgressResult["slices"];
    tasks: DbProjectProgressResult["tasks"];
    active_slice_tasks: { done: number; total: number };
  };
  runtime: {
    mode: "AUTO" | "NEXT" | "IDLE";
    unit_label: string | null;
    unit_type: string | null;
    model: string | null;
    elapsed_ms: number;
    eta_ms: number | null;
  };
  health: ProgressScore;
  metrics: {
    units: number;
    duration_ms: number;
    tokens: number;
    cost: number;
    by_phase: Array<{ phase: string; units: number; duration_ms: number; tokens: number; cost: number }>;
    by_slice: Array<{ slice_id: string; units: number; duration_ms: number; tokens: number; cost: number }>;
    by_model: Array<{ model: string; units: number; tokens: number; cost: number }>;
  };
  hierarchy: Array<{
    id: string;
    title: string;
    status: string;
    slices: Array<{
      id: string;
      title: string;
      status: string;
      tasks: Array<{ id: string; title: string; status: string }>;
    }>;
  }>;
  blockers: string[];
  open_questions: Array<{ question_id: string; title: string; created_at: string }>;
  verification: DbProjectSnapshot["verification"];
};

export function estimateTimeRemainingMsFrom(
  units: UnitMetrics[],
  sliceProgress: { milestoneId?: string | null; done: number; total: number } | null,
): number | null {
  if (units.length < 2 || !sliceProgress || sliceProgress.total === 0) return null;
  const remainingSlices = sliceProgress.total - sliceProgress.done;
  if (remainingSlices <= 0) return null;
  const completed = filterUnitsForMilestone(units, sliceProgress.milestoneId).filter(
    (unit) => unit.finishedAt > 0 && unit.startedAt > 0,
  );
  if (completed.length < 2) return null;
  const duration = completed.reduce((sum, unit) => sum + (unit.finishedAt - unit.startedAt), 0);
  const estimate = remainingSlices * (completed.length / (sliceProgress.done || 1)) * (duration / completed.length);
  return estimate >= 5_000 ? Math.floor(estimate) : null;
}

export function formatTimeRemaining(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `~${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `~${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `~${hours}h ${remainingMinutes}m remaining` : `~${hours}h remaining`;
}

export function buildGsdRuntimeProgressSnapshot(input: {
  snapshot: DbProjectSnapshot;
  progress: DbProjectProgressResult;
  runtime: AutoRuntimeSnapshot;
  health: ProgressScore;
  units: UnitMetrics[];
  now?: number;
}): GsdMonitoringStatus {
  const { snapshot, progress, runtime, health, units } = input;
  const now = input.now ?? Date.now();
  const activeMilestone = snapshot.current.activeMilestone ?? progress.activeMilestone;
  const activeSlice = snapshot.current.activeSlice ?? progress.activeSlice;
  const activeTask = snapshot.current.activeTask ?? progress.activeTask;
  const activeMilestoneDetail = progress.milestoneDetails?.find((item) => item.id === activeMilestone?.id);
  const activeSliceDetail = activeMilestoneDetail?.slices.find((item) => item.id === activeSlice?.id);
  const activeSliceTasks = activeSliceDetail?.tasks ?? [];
  const activeSliceDone = activeSliceTasks.filter((task) =>
    ["complete", "completed", "done", "closed", "passed"].includes(task.status.trim().toLowerCase())
  ).length;
  const activeMilestoneSlices = activeMilestoneDetail?.slices ?? [];
  const activeMilestoneSlicesDone = activeMilestoneSlices.filter((slice) =>
    ["complete", "completed", "done", "closed", "passed"].includes(slice.status.trim().toLowerCase())
  ).length;
  const totals = getProjectTotals(units);
  const eta = estimateTimeRemainingMsFrom(units, {
    milestoneId: activeMilestone?.id,
    done: activeMilestoneSlicesDone,
    total: activeMilestoneSlices.length,
  });

  return {
    captured_at: snapshot.capturedAt,
    authority: {
      source: "database",
      revision: snapshot.authority.revision,
      authority_epoch: snapshot.authority.authorityEpoch,
    },
    current: {
      milestone: activeMilestone ?? null,
      slice: activeSlice ?? null,
      task: activeTask ?? null,
      phase: snapshot.current.phase ?? progress.phase,
      next_action: snapshot.current.nextAction ?? progress.nextAction,
    },
    progress: {
      milestones: { ...progress.milestones },
      slices: { ...progress.slices },
      tasks: { ...progress.tasks },
      active_slice_tasks: { done: activeSliceDone, total: activeSliceTasks.length },
    },
    runtime: {
      mode: runtime.active || runtime.paused ? (runtime.stepMode ? "NEXT" : "AUTO") : "IDLE",
      unit_label: runtime.currentUnit?.id ?? null,
      unit_type: runtime.currentUnit?.type ?? null,
      model: runtime.currentDispatchedModelId,
      elapsed_ms: runtime.autoStartTime > 0 ? Math.max(0, now - runtime.autoStartTime) : 0,
      eta_ms: eta,
    },
    health: { level: health.level, summary: health.summary, signals: health.signals.map((signal) => ({ ...signal })) },
    metrics: {
      units: totals.units,
      duration_ms: totals.duration,
      tokens: totals.tokens.total,
      cost: totals.cost,
      by_phase: aggregateByPhase(units).map((row) => ({ phase: row.phase, units: row.units, duration_ms: row.duration, tokens: row.tokens.total, cost: row.cost })),
      by_slice: aggregateBySlice(units).map((row) => ({ slice_id: row.sliceId, units: row.units, duration_ms: row.duration, tokens: row.tokens.total, cost: row.cost })),
      by_model: aggregateByModel(units).map((row) => ({ model: row.model, units: row.units, tokens: row.tokens.total, cost: row.cost })),
    },
    hierarchy: (progress.milestoneDetails ?? []).map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      slices: milestone.slices.map((slice) => ({
        id: slice.id,
        title: slice.title,
        status: slice.status,
        tasks: slice.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
      })),
    })),
    blockers: snapshot.blockers.map((blocker) => blocker.description),
    open_questions: snapshot.openQuestions.map((question) => ({
      question_id: question.questionId,
      title: question.questionText,
      created_at: question.createdAt,
    })),
    verification: { ...snapshot.verification },
  };
}
