export declare function resolveExtensionEntries(dir: string): string[];
/** Discover extension entry points beneath one extensions directory. */
export declare function discoverExtensionEntryPaths(extensionsDir: string): string[];
/**
 * Merge bundled and installed extension entries before the loader sees them.
 * Installed manifest IDs shadow bundled IDs (D-14); the loader stays dumb (D-15).
 */
export declare function mergeExtensionEntryPaths(bundledPaths: string[], installedExtensionsDir: string, bundledExtensionsDir?: string): string[];
