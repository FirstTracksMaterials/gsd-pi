/**
 * Disk-based cache for discovered models.
 * Stores results at {agentDir}/discovery-cache.json with per-provider TTLs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";
import { getDefaultTTL } from "./model-discovery.js";
export class ModelDiscoveryCache {
    data;
    cachePath;
    constructor(cachePath) {
        this.cachePath = cachePath ?? join(getAgentDir(), "discovery-cache.json");
        this.data = { version: 1, entries: {} };
        this.load();
    }
    get(provider) {
        const entry = this.data.entries[provider];
        return entry;
    }
    set(provider, models, ttlMs) {
        // Re-read from disk to get the latest state before modifying
        this.load();
        this.data.entries[provider] = {
            models,
            fetchedAt: Date.now(),
            ttlMs: ttlMs ?? getDefaultTTL(provider),
        };
        this.save();
    }
    isStale(provider) {
        const entry = this.data.entries[provider];
        if (!entry)
            return true;
        return Date.now() - entry.fetchedAt > entry.ttlMs;
    }
    clear(provider) {
        // Re-read from disk to get the latest state before modifying
        this.load();
        if (provider) {
            delete this.data.entries[provider];
        }
        else {
            this.data.entries = {};
        }
        this.save();
    }
    getAll(includeStale = false) {
        const result = new Map();
        for (const [provider, entry] of Object.entries(this.data.entries)) {
            if (includeStale || !this.isStale(provider)) {
                result.set(provider, entry);
            }
        }
        return result;
    }
    load() {
        try {
            if (existsSync(this.cachePath)) {
                const content = readFileSync(this.cachePath, "utf-8");
                const parsed = JSON.parse(content);
                if (parsed.version === 1 && parsed.entries) {
                    this.data = parsed;
                }
            }
        }
        catch {
            // Corrupted or unreadable cache — start fresh
            this.data = { version: 1, entries: {} };
        }
    }
    save() {
        try {
            const dir = dirname(this.cachePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            // Atomic write: write to temp file then rename to avoid partial reads
            const tmpPath = this.cachePath + ".tmp";
            writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
            renameSync(tmpPath, this.cachePath);
        }
        catch {
            // Silently ignore write failures (read-only FS, permissions, etc.)
        }
    }
}
