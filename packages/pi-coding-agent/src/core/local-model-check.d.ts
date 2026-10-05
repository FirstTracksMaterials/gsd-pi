/**
 * local-model-check.ts — Utility to detect if a model baseUrl is local.
 *
 * Leaf module with zero transitive dependencies on TypeScript parameter properties.
 * Used by ModelRegistry and tests.
 */
/**
 * Check if a model's baseUrl points to a local endpoint.
 * Returns true for localhost, 127.0.0.1, 0.0.0.0, ::1, or unix socket paths.
 * Returns false if baseUrl is empty (cloud provider) or points to a remote host.
 */
export declare function isLocalModel(model: {
    baseUrl: string;
}): boolean;
