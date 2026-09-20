// Project/App: gsd-pi
// File Purpose: Job history paging from the event journal. Default 100, max 500.

import { invalidRequest, unknownJob } from "./errors.ts";
import { parseCursor } from "./event-journal.ts";
import { readProjectJournal } from "./event-hub.ts";
import type { RuntimeControl } from "./control.ts";
import type { RuntimeEvent } from "./types.ts";

const HISTORY_TYPES = new Set([
  "assistant_message",
  "tool_started",
  "tool_finished",
  "verification_updated",
  "input_required",
  "input_resolved",
  "job_updated",
  "operation_updated",
  "recovery_required",
]);

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 500;

export type HistoryPage = {
  records: RuntimeEvent[];
  next_cursor: string | null;
  gap: boolean;
};

export function readJobHistory(
  control: RuntimeControl,
  jobId: string,
  query: { cursor?: string | null; limit?: number | null },
): HistoryPage {
  const decoded = decodeURIComponent(jobId);
  const job = control.jobs.get(decoded);
  if (!job) throw unknownJob(`Unknown job ${decoded}`);
  const limitRaw = query.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limitRaw) || limitRaw < 1) throw invalidRequest("limit must be a positive integer");
  const limit = Math.min(limitRaw, MAX_HISTORY_LIMIT);
  const journal = readProjectJournal(control, job.project_id);
  const after = query.cursor ?? null;
  const replay = after ? journal.readAfter(after) : { gap: false, events: journal.readAll() };
  const records = replay.events.filter((event) => event.job_id === decoded && HISTORY_TYPES.has(event.type));
  if (after && replay.gap) {
    const retained = journal.readAll().filter((event) => event.job_id === decoded && HISTORY_TYPES.has(event.type));
    const page = retained.slice(0, limit);
    return {
      records: page,
      next_cursor: page.at(-1)?.cursor ?? null,
      gap: true,
    };
  }
  let start = 0;
  if (after) {
    const parsed = parseCursor(after);
    if (parsed) {
      const idx = records.findIndex((event) => event.sequence > parsed.sequence);
      start = idx === -1 ? records.length : idx;
    }
  }
  const page = records.slice(start, start + limit);
  return {
    records: page,
    next_cursor: page.length === limit ? page.at(-1)?.cursor ?? null : null,
    gap: false,
  };
}
