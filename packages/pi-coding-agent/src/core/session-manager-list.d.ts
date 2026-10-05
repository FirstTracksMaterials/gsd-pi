import { type FileEntry, type SessionInfo } from "./session-manager-types.js";
export declare function getDefaultSessionDir(cwd: string, agentDir?: string): string;
export declare function loadEntriesFromFile(filePath: string): FileEntry[];
export declare function findMostRecentSession(sessionDir: string): string | null;
export type SessionListProgress = (loaded: number, total: number) => void;
export declare function buildSessionInfosWithConcurrency(files: string[], onLoaded: () => void): Promise<(SessionInfo | null)[]>;
export declare function listSessionsFromDir(dir: string, onProgress?: SessionListProgress, progressOffset?: number, progressTotal?: number): Promise<SessionInfo[]>;
