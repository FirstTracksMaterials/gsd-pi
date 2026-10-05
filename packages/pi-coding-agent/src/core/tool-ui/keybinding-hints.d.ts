/**
 * Utilities for formatting keybinding hints in the UI.
 */
import { type Keybinding } from "@gsd/pi-tui";
import type { AppAction } from "../keybindings.js";
export interface KeyTextFormatOptions {
    capitalize?: boolean;
}
export declare function formatKeyText(key: string, options?: KeyTextFormatOptions): string;
export declare function keyText(keybinding: Keybinding | AppAction): string;
export declare function keyDisplayText(keybinding: Keybinding): string;
export declare function keyHint(keybinding: Keybinding, description: string): string;
export declare function rawKeyHint(key: string, description: string): string;
