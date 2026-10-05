import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage, } from "./messages.js";
export function getLatestCompactionEntry(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "compaction") {
            return entries[i];
        }
    }
    return null;
}
/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(entries, leafId, byId) {
    if (!byId) {
        byId = new Map();
        for (const entry of entries) {
            byId.set(entry.id, entry);
        }
    }
    let leaf;
    if (leafId === null) {
        return { messages: [], thinkingLevel: "off", model: null };
    }
    if (leafId) {
        leaf = byId.get(leafId);
    }
    if (!leaf) {
        leaf = entries[entries.length - 1];
    }
    if (!leaf) {
        return { messages: [], thinkingLevel: "off", model: null };
    }
    const path = [];
    let current = leaf;
    while (current) {
        path.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let thinkingLevel = "off";
    let model = null;
    let compaction = null;
    for (const entry of path) {
        if (entry.type === "thinking_level_change") {
            thinkingLevel = entry.thinkingLevel;
        }
        else if (entry.type === "model_change") {
            model = { provider: entry.provider, modelId: entry.modelId };
        }
        else if (entry.type === "message" && entry.message.role === "assistant") {
            model = { provider: entry.message.provider, modelId: entry.message.model };
        }
        else if (entry.type === "compaction") {
            compaction = entry;
        }
    }
    const messages = [];
    const appendMessage = (entry) => {
        if (entry.type === "message") {
            messages.push(entry.message);
        }
        else if (entry.type === "custom_message") {
            messages.push(createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp));
        }
        else if (entry.type === "branch_summary" && entry.summary) {
            messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
        }
    };
    if (compaction) {
        messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
        const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
        let foundFirstKept = false;
        for (let i = 0; i < compactionIdx; i++) {
            const entry = path[i];
            if (entry.id === compaction.firstKeptEntryId) {
                foundFirstKept = true;
            }
            if (foundFirstKept) {
                appendMessage(entry);
            }
        }
        for (let i = compactionIdx + 1; i < path.length; i++) {
            appendMessage(path[i]);
        }
    }
    else {
        for (const entry of path) {
            appendMessage(entry);
        }
    }
    return { messages, thinkingLevel, model };
}
