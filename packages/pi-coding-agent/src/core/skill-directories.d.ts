/**
 * Skill directory taxonomy.
 *
 * Single source of truth for which filesystem directories contain skills and
 * what role each one plays. Three callers consume this:
 *
 *   - PackageManager (`./package-manager.js`) — builds the model-visible
 *     `<available_skills>` catalog. Filters to the non-Claude kinds and
 *     applies its own PathMetadata + collision precedence.
 *   - skill-discovery (`src/resources/extensions/gsd/skill-discovery.ts`) —
 *     detects skills installed mid-session by scanning disk. Uses all kinds.
 *   - preferences-skills (`src/resources/extensions/gsd/preferences-skills.ts`)
 *     — resolves bare skill names referenced in GSD preferences. Uses all
 *     kinds, mapped to a `user-skill` / `project-skill` method.
 *
 * Enumeration order is precedence order (project → ancestor-project → user);
 * first match wins for collision resolution. Only `agents-project` walks
 * ancestors up to the git repo root, matching the catalog's historical
 * behavior.
 */
export type SkillDirKind = "gsd-project" | "agents-project" | "claude-project" | "gsd-user" | "agents-user" | "claude-user";
export interface SkillDirectoryEntry {
    /** Absolute path to the skills directory (the dir containing skill subdirs). */
    path: string;
    kind: SkillDirKind;
    scope: "user" | "project";
    /**
     * The configuration root that owns this skills dir — the `.gsd` / `.agents`
     * / `.claude` parent. PackageManager uses this as `PathMetadata.baseDir`.
     */
    baseDir: string;
}
/**
 * Find the nearest enclosing directory containing a `.git` entry.
 * Returns `null` if none is found before the filesystem root.
 */
export declare function findGitRepoRoot(startDir: string): string | null;
/**
 * Collect `<dir>/.agents/skills` for `startDir` and every ancestor up to (and
 * including) the git repo root. Order is nearest-first. If no git root is
 * found, walks all the way to the filesystem root.
 */
export declare function collectAncestorAgentsSkillDirs(startDir: string): string[];
export interface GetSkillDirectoriesOptions {
    cwd: string;
    /** Value of `gsdHome()` from the caller — the `~/.gsd` directory. */
    gsdHome: string;
}
/**
 * Return all known skill directories in precedence order. First match wins
 * for collision resolution.
 *
 * Three-tier precedence:
 *   1. Project kinds (`gsd-project`, `agents-project`) — native project dirs
 *      override everything below.
 *   2. Bundled GSD (`gsd-user`, i.e. ~/.gsd/agent/skills/) — protects
 *      auto-mode dependencies (`handoff`, `decompose-into-slices`, etc.) from
 *      being shadowed by same-named Claude skills.
 *   3. Foreign/Claude kinds (`claude-project`, `agents-user`, `claude-user`).
 *
 * The `agents-project` kind is expanded into one entry per ancestor directory
 * (nearest first, up to the git root), mirroring the catalog's historical
 * ancestor walk.
 */
export declare function getSkillDirectories({ cwd, gsdHome }: GetSkillDirectoriesOptions): SkillDirectoryEntry[];
