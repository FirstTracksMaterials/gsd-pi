import { type FileEntry } from "./session-manager-types.js";
/** Generate a unique short ID (8 hex chars, collision-checked) */
export declare function generateSessionEntryId(byId: {
    has(id: string): boolean;
}): string;
declare function migrateToCurrentVersion(entries: FileEntry[]): boolean;
/** Exported for testing */
export declare function migrateSessionEntries(entries: FileEntry[]): void;
/** Exported for compaction.test.ts */
export declare function parseSessionEntries(content: string): FileEntry[];
export { migrateToCurrentVersion };
