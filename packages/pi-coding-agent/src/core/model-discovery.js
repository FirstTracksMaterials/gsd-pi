/**
 * Provider discovery adapters for runtime model enumeration.
 * Each adapter implements ProviderDiscoveryAdapter to fetch models from provider APIs.
 */
export const OPENAI_COMPAT_DISCOVERY_APIS = new Set([
    "openai",
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
]);
/** Per-provider TTLs in milliseconds */
export const DISCOVERY_TTLS = {
    ollama: 5 * 60 * 1000, // 5 minutes (local, models change often)
    openai: 60 * 60 * 1000, // 1 hour
    google: 60 * 60 * 1000, // 1 hour
    openrouter: 60 * 60 * 1000, // 1 hour
    default: 24 * 60 * 60 * 1000, // 24 hours
};
export function getDefaultTTL(provider) {
    return DISCOVERY_TTLS[provider] ?? DISCOVERY_TTLS.default;
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
// ─── OpenAI Adapter ──────────────────────────────────────────────────────────
const OPENAI_EXCLUDED_PREFIXES = ["embedding", "tts", "dall-e", "whisper", "text-embedding", "davinci", "babbage"];
function asPositiveNumber(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    if (typeof value === "string") {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return undefined;
}
function pickFirstPositiveNumber(record, keys) {
    for (const key of keys) {
        const value = asPositiveNumber(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function discoverInputModalities(rawModel, id) {
    const directModalities = rawModel.input_modalities;
    const capabilitiesModalities = rawModel.capabilities?.input_modalities;
    const source = Array.isArray(directModalities)
        ? directModalities
        : Array.isArray(capabilitiesModalities)
            ? capabilitiesModalities
            : [];
    const supportsImage = source.some((m) => typeof m === "string" && /image|vision/i.test(m))
        || /vision|image|omni|multimodal/i.test(id);
    return supportsImage ? ["text", "image"] : ["text"];
}
function parseOpenAICompatibleModel(rawModel) {
    const id = typeof rawModel.id === "string" ? rawModel.id : "";
    if (!id)
        return undefined;
    if (OPENAI_EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix)))
        return undefined;
    const contextWindow = pickFirstPositiveNumber(rawModel, [
        "context_window",
        "context_length",
        "max_context_length",
        "max_input_tokens",
        "input_token_limit",
        "max_model_len",
    ]);
    const maxTokens = pickFirstPositiveNumber(rawModel, [
        "max_output_tokens",
        "output_token_limit",
        "max_completion_tokens",
        "max_tokens",
    ]);
    const reasoning = rawModel.reasoning === true
        || rawModel.supports_reasoning === true
        || (rawModel.capabilities?.reasoning === true);
    return {
        id,
        name: typeof rawModel.name === "string" && rawModel.name.length > 0 ? rawModel.name : id,
        contextWindow,
        maxTokens,
        reasoning,
        input: discoverInputModalities(rawModel, id),
    };
}
function stripTrailingOpenAIPathPrefix(baseUrl) {
    return baseUrl.replace(/\/api\/v1\/?$/, "").replace(/\/v1\/?$/, "");
}
class OpenAIDiscoveryAdapter {
    provider;
    supportsDiscovery = true;
    constructor(provider) {
        this.provider = provider;
    }
    async fetchModels(apiKey, baseUrl) {
        const url = `${baseUrl ?? "https://api.openai.com"}/v1/models`;
        const response = await fetchWithTimeout(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
            throw new Error(`OpenAI models API returned ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json());
        return (data.data ?? [])
            .map((m) => parseOpenAICompatibleModel(m))
            .filter((m) => !!m);
    }
}
// ─── Ollama Adapter ──────────────────────────────────────────────────────────
class OllamaDiscoveryAdapter {
    provider = "ollama";
    supportsDiscovery = true;
    async fetchModels(_apiKey, baseUrl) {
        const url = `${baseUrl ?? "http://localhost:11434"}/api/tags`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Ollama tags API returned ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json());
        return (data.models ?? []).map((m) => ({
            id: m.name,
            name: m.name,
            input: ["text"],
        }));
    }
}
// ─── OpenRouter Adapter ──────────────────────────────────────────────────────
class OpenRouterDiscoveryAdapter {
    provider = "openrouter";
    supportsDiscovery = true;
    async fetchModels(apiKey, baseUrl) {
        const origin = stripTrailingOpenAIPathPrefix(baseUrl ?? "https://openrouter.ai");
        const url = `${origin}/api/v1/models`;
        const response = await fetchWithTimeout(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
            throw new Error(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json());
        return (data.data ?? []).map((m) => {
            const cost = m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined
                ? {
                    input: parseFloat(m.pricing.prompt) * 1_000_000,
                    output: parseFloat(m.pricing.completion) * 1_000_000,
                    cacheRead: 0,
                    cacheWrite: 0,
                }
                : undefined;
            return {
                id: m.id,
                name: m.name,
                contextWindow: m.context_length,
                maxTokens: m.top_provider?.max_completion_tokens,
                cost,
                input: ["text", "image"],
            };
        });
    }
}
// ─── Google/Gemini Adapter ───────────────────────────────────────────────────
class GoogleDiscoveryAdapter {
    provider = "google";
    supportsDiscovery = true;
    async fetchModels(apiKey, baseUrl) {
        const url = `${baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models?key=${apiKey}`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Google models API returned ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json());
        return (data.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
            .map((m) => ({
            id: m.name.replace("models/", ""),
            name: m.displayName,
            contextWindow: m.inputTokenLimit,
            maxTokens: m.outputTokenLimit,
            input: ["text", "image"],
        }));
    }
}
// ─── Static Adapter (no discovery) ───────────────────────────────────────────
class StaticDiscoveryAdapter {
    provider;
    supportsDiscovery = false;
    constructor(provider) {
        this.provider = provider;
    }
    async fetchModels() {
        return [];
    }
}
// ─── Registry ────────────────────────────────────────────────────────────────
const adapters = {
    openai: new OpenAIDiscoveryAdapter("openai"),
    ollama: new OllamaDiscoveryAdapter(),
    openrouter: new OpenRouterDiscoveryAdapter(),
    google: new GoogleDiscoveryAdapter(),
    anthropic: new StaticDiscoveryAdapter("anthropic"),
    bedrock: new StaticDiscoveryAdapter("bedrock"),
    "azure-openai": new StaticDiscoveryAdapter("azure-openai"),
    groq: new StaticDiscoveryAdapter("groq"),
    cerebras: new StaticDiscoveryAdapter("cerebras"),
    xai: new StaticDiscoveryAdapter("xai"),
    mistral: new StaticDiscoveryAdapter("mistral"),
};
export function supportsDiscoveryForApi(api) {
    if (!api)
        return false;
    return OPENAI_COMPAT_DISCOVERY_APIS.has(api);
}
export function getDiscoveryAdapter(provider, providerApis) {
    const known = adapters[provider];
    if (known)
        return known;
    if (providerApis) {
        for (const api of providerApis) {
            if (supportsDiscoveryForApi(api)) {
                return new OpenAIDiscoveryAdapter(provider);
            }
        }
    }
    return new StaticDiscoveryAdapter(provider);
}
export function getDiscoverableProviders() {
    return Object.entries(adapters)
        .filter(([, adapter]) => adapter.supportsDiscovery)
        .map(([name]) => name);
}
