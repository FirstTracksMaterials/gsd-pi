// Project/App: gsd-pi
// File Purpose: GSD-owned append-only event journal. Outside source snapshots. R9 retention.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json.ts";
import type { RuntimeEvent } from "./types.ts";

export const DEFAULT_MAX_SEGMENT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_SEGMENTS = 5;

export type JournalOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type JournalIndex = {
  sequence: number;
  segment: number;
};

export function formatCursor(authorityEpoch: number, sequence: number): string {
  return `epoch${authorityEpoch}:sequence${sequence}`;
}

export function parseCursor(cursor: string): { epoch: number; sequence: number } | null {
  const match = /^epoch(\d+):sequence(\d+)$/.exec(cursor);
  if (!match) return null;
  return { epoch: Number(match[1]), sequence: Number(match[2]) };
}

export class EventJournal {
  readonly dir: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private readonly eventIds = new Set<string>();
  private index: JournalIndex;

  constructor(dir: string, options: JournalOptions = {}) {
    this.dir = dir;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    mkdirSync(dir, { recursive: true });
    this.index = this.loadIndex();
    this.rebuildIdSet();
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  private segmentPath(segment: number): string {
    return join(this.dir, `segment-${String(segment).padStart(3, "0")}.jsonl`);
  }

  private loadIndex(): JournalIndex {
    if (!existsSync(this.indexPath())) return { sequence: 0, segment: 1 };
    try {
      return JSON.parse(readFileSync(this.indexPath(), "utf-8")) as JournalIndex;
    } catch {
      return { sequence: 0, segment: 1 };
    }
  }

  private persistIndex(): void {
    atomicWriteJson(this.indexPath(), this.index);
  }

  private rebuildIdSet(): void {
    this.eventIds.clear();
    for (const event of this.readAll()) this.eventIds.add(event.event_id);
  }

  hasEventId(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }

  hasCursor(cursor: string): boolean {
    const parsed = parseCursor(cursor);
    if (!parsed) return false;
    return this.readAll().some((event) => event.sequence === parsed.sequence);
  }

  nextSequence(): number {
    return this.index.sequence + 1;
  }

  append(event: Omit<RuntimeEvent, "cursor" | "sequence"> & { sequence?: number; cursor?: string }): RuntimeEvent | null {
    if (this.eventIds.has(event.event_id)) return null;
    this.rotateIfNeeded();
    const sequence = event.sequence ?? this.index.sequence + 1;
    const stored: RuntimeEvent = {
      ...event,
      sequence,
      cursor: event.cursor ?? formatCursor(event.authority_epoch, sequence),
    };
    appendFileSync(this.segmentPath(this.index.segment), `${JSON.stringify(stored)}\n`, "utf-8");
    this.index.sequence = sequence;
    this.eventIds.add(stored.event_id);
    this.persistIndex();
    return stored;
  }

  readAll(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const segment of this.segmentNumbers()) {
      const path = this.segmentPath(segment);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as RuntimeEvent);
        } catch {
          // skip corrupt line
        }
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  readAfter(cursor: string | null): { gap: boolean; events: RuntimeEvent[] } {
    const all = this.readAll();
    if (!cursor) return { gap: false, events: all };
    if (!this.hasCursor(cursor)) return { gap: true, events: [] };
    const parsed = parseCursor(cursor);
    if (!parsed) return { gap: true, events: [] };
    return { gap: false, events: all.filter((event) => event.sequence > parsed.sequence) };
  }

  private segmentNumbers(): number[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((name) => /^segment-(\d+)\.jsonl$/.exec(name))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  }

  private rotateIfNeeded(): void {
    const path = this.segmentPath(this.index.segment);
    if (!existsSync(path)) {
      writeFileSync(path, "", "utf-8");
      return;
    }
    if (statSync(path).size < this.maxSegmentBytes) return;
    this.index.segment += 1;
    writeFileSync(this.segmentPath(this.index.segment), "", "utf-8");
    const segments = this.segmentNumbers();
    while (segments.length > this.maxSegments) {
      const oldest = segments.shift();
      if (oldest === undefined) break;
      const oldPath = this.segmentPath(oldest);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    this.rebuildIdSet();
    this.persistIndex();
  }
}

const journals = new Map<string, EventJournal>();

export function journalFor(stateRoot: string, projectId: string, options?: JournalOptions): EventJournal {
  const key = `${stateRoot}:${projectId}`;
  const existing = journals.get(key);
  if (existing) return existing;
  const created = new EventJournal(join(stateRoot, "runtime-control", "events", projectId), options);
  journals.set(key, created);
  return created;
}

export function resetJournalsForTest(): void {
  journals.clear();
}
