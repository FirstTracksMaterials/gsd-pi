/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */
import { findEnvKeys, getEnvApiKey, } from "@gsd/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@gsd/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { normalizePath } from "../utils/paths.js";
import { resolveConfigValue } from "./resolve-config-value.js";
function isUsableApiKeyCredential(credential) {
    return credential.type === "api_key" && credential.key.trim().length > 0;
}
function isUsableStoredCredential(credential) {
    return credential.type === "oauth" || isUsableApiKeyCredential(credential);
}
export class FileAuthStorageBackend {
    authPath;
    constructor(authPath = join(getAgentDir(), "auth.json")) {
        this.authPath = normalizePath(authPath);
    }
    ensureParentDir() {
        const dir = dirname(this.authPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }
    ensureFileExists() {
        if (!existsSync(this.authPath)) {
            writeFileSync(this.authPath, "{}", "utf-8");
            chmodSync(this.authPath, 0o600);
        }
    }
    acquireLockSyncWithRetry(path) {
        const maxAttempts = 10;
        const delayMs = 20;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return lockfile.lockSync(path, { realpath: false });
            }
            catch (error) {
                const code = typeof error === "object" && error !== null && "code" in error
                    ? String(error.code)
                    : undefined;
                if (code !== "ELOCKED" || attempt === maxAttempts) {
                    throw error;
                }
                lastError = error;
                const start = Date.now();
                while (Date.now() - start < delayMs) {
                    // Sleep synchronously to avoid changing callers to async.
                }
            }
        }
        throw lastError ?? new Error("Failed to acquire auth storage lock");
    }
    withLock(fn) {
        this.ensureParentDir();
        this.ensureFileExists();
        let release;
        try {
            release = this.acquireLockSyncWithRetry(this.authPath);
            const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
            const { result, next } = fn(current);
            if (next !== undefined) {
                writeFileSync(this.authPath, next, "utf-8");
                chmodSync(this.authPath, 0o600);
            }
            return result;
        }
        finally {
            if (release) {
                release();
            }
        }
    }
    async withLockAsync(fn) {
        this.ensureParentDir();
        this.ensureFileExists();
        let release;
        let lockCompromised = false;
        let lockCompromisedError;
        const throwIfCompromised = () => {
            if (lockCompromised) {
                throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
            }
        };
        try {
            release = await lockfile.lock(this.authPath, {
                retries: {
                    retries: 10,
                    factor: 2,
                    minTimeout: 100,
                    maxTimeout: 10000,
                    randomize: true,
                },
                stale: 30000,
                onCompromised: (err) => {
                    lockCompromised = true;
                    lockCompromisedError = err;
                },
            });
            throwIfCompromised();
            const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
            const { result, next } = await fn(current);
            throwIfCompromised();
            if (next !== undefined) {
                writeFileSync(this.authPath, next, "utf-8");
                chmodSync(this.authPath, 0o600);
            }
            throwIfCompromised();
            return result;
        }
        finally {
            if (release) {
                try {
                    await release();
                }
                catch {
                    // Ignore unlock errors when lock is compromised.
                }
            }
        }
    }
}
export class InMemoryAuthStorageBackend {
    value;
    withLock(fn) {
        const { result, next } = fn(this.value);
        if (next !== undefined) {
            this.value = next;
        }
        return result;
    }
    async withLockAsync(fn) {
        const { result, next } = await fn(this.value);
        if (next !== undefined) {
            this.value = next;
        }
        return result;
    }
}
/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
    data = {};
    runtimeOverrides = new Map();
    fallbackResolver;
    loadError = null;
    errors = [];
    storage;
    constructor(storage) {
        this.storage = storage;
        this.reload();
    }
    static create(authPath) {
        return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
    }
    static fromStorage(storage) {
        return new AuthStorage(storage);
    }
    static inMemory(data = {}) {
        const storage = new InMemoryAuthStorageBackend();
        storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
        return AuthStorage.fromStorage(storage);
    }
    /**
     * Set a runtime API key override (not persisted to disk).
     * Used for CLI --api-key flag.
     */
    setRuntimeApiKey(provider, apiKey) {
        this.runtimeOverrides.set(provider, apiKey);
    }
    /**
     * Remove a runtime API key override.
     */
    removeRuntimeApiKey(provider) {
        this.runtimeOverrides.delete(provider);
    }
    /**
     * Set a fallback resolver for API keys not found in auth.json or env vars.
     * Used for custom provider keys from models.json.
     */
    setFallbackResolver(resolver) {
        this.fallbackResolver = resolver;
    }
    recordError(error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.errors.push(normalizedError);
    }
    parseStorageData(content) {
        if (!content) {
            return {};
        }
        return JSON.parse(content);
    }
    getCredentialsForProvider(provider) {
        const entry = this.data[provider];
        if (!entry)
            return [];
        if (Array.isArray(entry))
            return entry;
        return [entry];
    }
    /**
     * Reload credentials from storage.
     */
    reload() {
        let content;
        try {
            this.storage.withLock((current) => {
                content = current;
                return { result: undefined };
            });
            this.data = this.parseStorageData(content);
            this.loadError = null;
        }
        catch (error) {
            this.loadError = error;
            this.recordError(error);
        }
    }
    persistProviderChange(provider, credential) {
        if (this.loadError) {
            return;
        }
        try {
            this.storage.withLock((current) => {
                const currentData = this.parseStorageData(current);
                const merged = { ...currentData };
                if (credential) {
                    merged[provider] = credential;
                }
                else {
                    delete merged[provider];
                }
                return { result: undefined, next: JSON.stringify(merged, null, 2) };
            });
        }
        catch (error) {
            this.recordError(error);
        }
    }
    /**
     * Get credential for a provider.
     */
    get(provider) {
        return this.getCredentialsForProvider(provider)[0];
    }
    /**
     * Set credential for a provider.
     */
    set(provider, credential) {
        this.data[provider] = credential;
        this.persistProviderChange(provider, credential);
    }
    /**
     * Remove credential for a provider.
     */
    remove(provider) {
        delete this.data[provider];
        this.persistProviderChange(provider, undefined);
    }
    /**
     * List all providers with credentials.
     */
    list() {
        return Object.keys(this.data);
    }
    /**
     * Check if credentials exist for a provider in auth.json.
     */
    has(provider) {
        return this.getCredentialsForProvider(provider).length > 0;
    }
    /**
     * Check if any form of auth is configured for a provider.
     * Unlike getApiKey(), this doesn't refresh OAuth tokens.
     */
    hasAuth(provider) {
        if (this.runtimeOverrides.has(provider))
            return true;
        if (this.getCredentialsForProvider(provider).some(isUsableStoredCredential))
            return true;
        if (getEnvApiKey(provider))
            return true;
        if (this.fallbackResolver?.(provider))
            return true;
        return false;
    }
    providerBackoff = new Map();
    isProviderAvailable(provider) {
        const expiresAt = this.providerBackoff.get(provider);
        if (expiresAt === undefined)
            return true;
        if (Date.now() >= expiresAt) {
            this.providerBackoff.delete(provider);
            return true;
        }
        return false;
    }
    markProviderExhausted(provider, _errorType) {
        this.providerBackoff.set(provider, Date.now() + 60_000);
    }
    areAllCredentialsBackedOff(provider) {
        return !this.isProviderAvailable(provider);
    }
    getProviderBackoffRemaining(provider) {
        const expiresAt = this.providerBackoff.get(provider);
        if (expiresAt === undefined)
            return 0;
        return Math.max(0, expiresAt - Date.now());
    }
    /**
     * Return auth status without exposing credential values or refreshing tokens.
     */
    getAuthStatus(provider) {
        if (this.getCredentialsForProvider(provider).some(isUsableStoredCredential)) {
            return { configured: true, source: "stored" };
        }
        if (this.runtimeOverrides.has(provider)) {
            return { configured: false, source: "runtime", label: "--api-key" };
        }
        const envKeys = findEnvKeys(provider);
        if (envKeys?.[0]) {
            return { configured: false, source: "environment", label: envKeys[0] };
        }
        if (this.fallbackResolver?.(provider)) {
            return { configured: false, source: "fallback", label: "custom provider config" };
        }
        return { configured: false };
    }
    /**
     * Get all credentials (for passing to getOAuthApiKey).
     */
    getAll() {
        return { ...this.data };
    }
    drainErrors() {
        const drained = [...this.errors];
        this.errors = [];
        return drained;
    }
    /**
     * Login to an OAuth provider.
     */
    async login(providerId, callbacks) {
        const provider = getOAuthProvider(providerId);
        if (!provider) {
            throw new Error(`Unknown OAuth provider: ${providerId}`);
        }
        const credentials = await provider.login(callbacks);
        this.set(providerId, { type: "oauth", ...credentials });
    }
    /**
     * Logout from a provider.
     */
    logout(provider) {
        this.remove(provider);
    }
    /**
     * Refresh OAuth token with backend locking to prevent race conditions.
     * Multiple pi instances may try to refresh simultaneously when tokens expire.
     */
    async refreshOAuthTokenWithLock(providerId) {
        const provider = getOAuthProvider(providerId);
        if (!provider) {
            return null;
        }
        const result = await this.storage.withLockAsync(async (current) => {
            const currentData = this.parseStorageData(current);
            this.data = currentData;
            this.loadError = null;
            const entry = currentData[providerId];
            const oauthEntry = Array.isArray(entry)
                ? entry.find((candidate) => candidate.type === "oauth")
                : entry?.type === "oauth"
                    ? entry
                    : undefined;
            if (!oauthEntry || oauthEntry.type !== "oauth") {
                return { result: null };
            }
            if (Date.now() < oauthEntry.expires) {
                return { result: { apiKey: provider.getApiKey(oauthEntry), newCredentials: oauthEntry } };
            }
            const oauthCreds = {};
            for (const [key, value] of Object.entries(currentData)) {
                const entries = Array.isArray(value) ? value : value ? [value] : [];
                for (const candidate of entries) {
                    if (candidate.type === "oauth") {
                        oauthCreds[key] = candidate;
                    }
                }
            }
            const refreshed = await getOAuthApiKey(providerId, oauthCreds);
            if (!refreshed) {
                return { result: null };
            }
            const merged = {
                ...currentData,
                [providerId]: { type: "oauth", ...refreshed.newCredentials },
            };
            this.data = merged;
            this.loadError = null;
            return { result: refreshed, next: JSON.stringify(merged, null, 2) };
        });
        return result;
    }
    /**
     * Get API key for a provider.
     * Priority:
     * 1. Runtime override (CLI --api-key)
     * 2. OAuth token from auth.json (when provider supports OAuth login)
     * 3. API key from auth.json (including fallback when OAuth refresh fails)
     * 4. Environment variable
     * 5. Fallback resolver (models.json custom providers)
     */
    async getApiKeyWithOAuthState(providerId, options) {
        // Runtime override takes highest priority
        const runtimeKey = this.runtimeOverrides.get(providerId);
        if (runtimeKey) {
            return { apiKey: runtimeKey, isOAuth: false };
        }
        const creds = this.getCredentialsForProvider(providerId);
        const apiKeyCredential = creds.find(isUsableApiKeyCredential);
        const oauthCredential = creds.find((entry) => entry.type === "oauth");
        // Prefer OAuth for providers that support subscription login (anthropic,
        // github-copilot, openai-codex). Users often have both OAuth and a stale
        // API key on disk; subscription auth should win unless --api-key overrides.
        const cred = oauthCredential && getOAuthProvider(providerId)
            ? oauthCredential
            : (apiKeyCredential ?? oauthCredential);
        if (cred?.type === "api_key") {
            const apiKey = resolveConfigValue(cred.key);
            return apiKey ? { apiKey, isOAuth: false } : undefined;
        }
        if (cred?.type === "oauth") {
            const provider = getOAuthProvider(providerId);
            if (!provider) {
                // Unknown OAuth provider, can't get API key
                return undefined;
            }
            const resolveStoredApiKey = () => apiKeyCredential ? resolveConfigValue(apiKeyCredential.key) : undefined;
            // Check if token needs refresh
            const needsRefresh = Date.now() >= cred.expires;
            if (needsRefresh) {
                // Use locked refresh to prevent race conditions
                try {
                    const result = await this.refreshOAuthTokenWithLock(providerId);
                    if (result) {
                        return { apiKey: result.apiKey, isOAuth: true };
                    }
                }
                catch (error) {
                    this.recordError(error);
                }
                // Refresh failed or returned nothing - re-read file to check if another instance succeeded
                this.reload();
                const updatedCred = this.getCredentialsForProvider(providerId).find((entry) => entry.type === "oauth");
                if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
                    return { apiKey: provider.getApiKey(updatedCred), isOAuth: true };
                }
                const storedApiKey = resolveStoredApiKey();
                if (storedApiKey) {
                    return { apiKey: storedApiKey, isOAuth: false };
                }
            }
            else {
                // Token not expired, use current access token
                return { apiKey: provider.getApiKey(cred), isOAuth: true };
            }
        }
        // Fall back to environment variable
        const envKey = getEnvApiKey(providerId);
        if (envKey)
            return { apiKey: envKey, isOAuth: false };
        // Fall back to custom resolver (e.g., models.json custom providers)
        if (options?.includeFallback !== false) {
            const apiKey = this.fallbackResolver?.(providerId);
            return apiKey ? { apiKey, isOAuth: false } : undefined;
        }
        return undefined;
    }
    async getApiKey(providerId, options) {
        return (await this.getApiKeyWithOAuthState(providerId, options))?.apiKey;
    }
    /**
     * Get all registered OAuth providers
     */
    getOAuthProviders() {
        return getOAuthProviders();
    }
}
