/**
 * Provider readiness policy extracted from ModelRegistry.
 */
import { getOAuthProviders } from "@gsd/pi-ai/oauth";
export function getProviderAuthMode(deps, provider) {
    if (provider === "gsd-fake")
        return "none";
    const config = deps.registeredProviders.get(provider);
    if (config) {
        if (config.authMode)
            return config.authMode;
        if (config.oauth)
            return "oauth";
        if (config.apiKey)
            return "apiKey";
        return "apiKey";
    }
    // Built-in OAuth providers (openai-codex, github-copilot, …) are not
    // registered via registerProvider(), but still authenticate via OAuth.
    if (getOAuthProviders().some((oauthProvider) => oauthProvider.id === provider)) {
        return "oauth";
    }
    return "apiKey";
}
export function setDisabledModelProviders(deps, providers) {
    deps.disabledModelProviders.clear();
    for (const provider of providers) {
        const normalized = provider.trim().toLowerCase();
        if (normalized.length > 0) {
            deps.disabledModelProviders.add(normalized);
        }
    }
}
export function getDisabledModelProviders(deps) {
    return Array.from(deps.disabledModelProviders);
}
export function isProviderRequestReady(deps, provider) {
    if (deps.disabledModelProviders.has(provider.trim().toLowerCase()))
        return false;
    const config = deps.registeredProviders.get(provider);
    if (config?.isReady)
        return config.isReady();
    const authMode = getProviderAuthMode(deps, provider);
    if (authMode === "externalCli" || authMode === "none")
        return true;
    return deps.authStorage.hasAuth(provider) || deps.providerRequestConfigs.has(provider);
}
