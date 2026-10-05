/**
 * Built-in theme definitions.
 *
 * Each theme is a self-contained record of color values. Variable references
 * (e.g. "accent") are resolved against the `vars` map at load time by the
 * theme engine in theme.ts.
 *
 * To add a new built-in theme, add an entry to `builtinThemes` below.
 */
import type { ThemeJson } from "./theme-schema.js";
export declare const builtinThemes: Record<string, ThemeJson>;
