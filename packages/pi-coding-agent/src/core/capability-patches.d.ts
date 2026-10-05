import type { Api, Model } from "@gsd/pi-ai";
/** GSD extension: provider-agnostic capability flags on models. */
export interface ModelCapabilities {
    supportsXhigh?: boolean;
    requiresToolCallId?: boolean;
    supportsServiceTier?: boolean;
    charsPerToken?: number;
}
type CapabilityPatch = {
    match: (m: Model<Api>) => boolean;
    caps: ModelCapabilities;
};
export declare const CAPABILITY_PATCHES: CapabilityPatch[];
/** Apply GSD capability patches after assembling a model list. */
export declare function applyCapabilityPatches<T extends Model<Api>>(models: T[]): T[];
export {};
