import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read-only fixture templates: tests never write into this folder. */
export const CONFIG_FIXTURES = resolve(HERE, '..', 'fixtures', 'config');

/**
 * Creates a throw-away sandbox that mirrors the extension layout (rootDir/config, rootDir/groups) and a copilot home
 * with cli-tools, copied from the fixtures. Remove it with remove() (use t.after in tests).
 * @param {string} [prefix]
 */
export function createConfigSandbox(prefix = 'shell-governor-') {
    const base = mkdtempSync(join(tmpdir(), prefix));
    const root = join(base, 'extension');
    const copilotHome = join(base, 'copilot-home');
    const configDir = join(root, 'config');
    const groupsDir = join(root, 'groups');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(groupsDir, { recursive: true });
    cpSync(join(CONFIG_FIXTURES, 'base'), configDir, { recursive: true });
    cpSync(join(CONFIG_FIXTURES, 'copilot-home'), copilotHome, { recursive: true });
    cpSync(join(CONFIG_FIXTURES, 'directories.json'), join(groupsDir, 'directories.json'));

    let bump = 0;
    const stamp = (path) => {
        // Each write gets a strictly later mtime so the store's mtime check always sees the change.
        const when = new Date(Date.now() + ++bump * 2000);
        utimesSync(path, when, when);
    };

    return {
        base,
        root,
        copilotHome,
        configFile: (name) => join(configDir, name),
        directoriesPath: join(groupsDir, 'directories.json'),
        /** Replaces config/<target> with fixtures/config/variants/<variant>. */
        useVariant(variant, target) {
            cpSync(join(CONFIG_FIXTURES, 'variants', variant), join(configDir, target));
        },
        /** Writes text to an existing sandbox file and advances its mtime. */
        write(path, text) {
            writeFileSync(path, text, 'utf8');
            stamp(path);
        },
        remove() {
            rmSync(base, { recursive: true, force: true });
        },
    };
}
