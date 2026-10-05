import { type CompactionEntry, type SessionContext, type SessionEntry } from "./session-manager-types.js";
export declare function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null;
/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export declare function buildSessionContext(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>): SessionContext;
