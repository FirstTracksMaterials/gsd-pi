/**
 * Provider readiness policy extracted from ModelRegistry.
 */
import type { AuthStorage } from "./auth-storage.js";
export type ProviderAuthMode = "apiKey" | "oauth" | "none" | "externalCli";
export interface ProviderReadinessConfig {
    isReady?: () => boolean;
    oauth?: unknown;
    apiKey?: string;
    authMode?: ProviderAuthMode;
}
export interface ProviderReadinessDeps {
    authStorage: AuthStorage;
    registeredProviders: Map<string, ProviderReadinessConfig>;
    providerRequestConfigs: Map<string, {
        apiKey?: string;
    }>;
    disabledModelProviders: Set<string>;
}
export declare function getProviderAuthMode(deps: ProviderReadinessDeps, provider: string): ProviderAuthMode;
export declare function setDisabledModelProviders(deps: ProviderReadinessDeps, providers: string[]): void;
export declare function getDisabledModelProviders(deps: ProviderReadinessDeps): string[];
export declare function isProviderRequestReady(deps: ProviderReadinessDeps, provider: string): boolean;
