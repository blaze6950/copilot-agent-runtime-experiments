import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** File names the CLI loads as extension entry points (case-insensitive on Windows). */
export const ENTRY_FILE_NAMES = Object.freeze(['extension.mjs', 'extension.cjs', 'extension.js']);

/**
 * Finds CLI extension entry files anywhere under dir.
 * @param {string} dir absolute folder to scan (missing folder → no entry files)
 * @returns {string[]} paths relative to dir
 */
export function findEntryFiles(dir) {
    if (!existsSync(dir)) return [];
    const found = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (ENTRY_FILE_NAMES.includes(entry.name.toLowerCase())) found.push(relative(dir, full));
        }
    };
    walk(dir);
    return found;
}
