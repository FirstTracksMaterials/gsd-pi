/**
 * Disk-based cache for discovered models.
 * Stores results at {agentDir}/discovery-cache.json with per-provider TTLs.
 */
import { type DiscoveredModel } from "./model-discovery.js";
export interface DiscoveryCacheEntry {
    models: DiscoveredModel[];
    fetchedAt: number;
    ttlMs: number;
}
export interface DiscoveryCacheData {
    version: 1;
    entries: Record<string, DiscoveryCacheEntry>;
}
export declare class ModelDiscoveryCache {
    private data;
    private cachePath;
    constructor(cachePath?: string);
    get(provider: string): DiscoveryCacheEntry | undefined;
    set(provider: string, models: DiscoveredModel[], ttlMs?: number): void;
    isStale(provider: string): boolean;
    clear(provider?: string): void;
    getAll(includeStale?: boolean): Map<string, DiscoveryCacheEntry>;
    load(): void;
    save(): void;
}
