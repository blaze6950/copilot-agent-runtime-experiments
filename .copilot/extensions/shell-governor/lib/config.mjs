// Config store of the shell governor. Every get()/agentPolicy() call stats the files and reloads a file whose
// mtime or size changed; an invalid file keeps its last valid version and reports one warning per broken version.
// Per-agent overrides (agents.json) are merged over the base directory rules; protected and secret rules cannot be
// loosened by an override. Access per agent is derived read-only from {copilotHome}\cli-tools.
// No writes, no SDK imports. Machine paths appear only as placeholders ({home}, {temp}, {appdata}, {localappdata},
// {copilotHome}) and are resolved from the injected env/copilotHome, never hard-coded.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** @type {{ now: () => number }} */
export const realClock = Object.freeze({ now: () => Date.now() });

const LEVEL_RANK = Object.freeze({ normal: 0, protected: 1, secret: 2 });
const SHARED_CLI_FILE = '_shell.json';
const PLACEHOLDER = /\{(home|temp|appdata|localappdata|copilotHome)\}/g;

/**
 * Replaces known placeholders; unknown placeholders stay as written.
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function resolvePlaceholders(text, vars) {
    return text.replace(PLACEHOLDER, (match, key) => vars[key] ?? match);
}

const trimSlash = (p) => p.replace(/[\\/]+$/, '');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isLevel = (v) => typeof v === 'string' && Object.hasOwn(LEVEL_RANK, v);

/** Mtime and size signature of a file; 'missing' when it does not exist. */
function signatureOf(path) {
    try {
        const st = statSync(path);
        return `${st.mtimeMs}:${st.size}`;
    } catch (err) {
        if (err.code === 'ENOENT') return 'missing';
        throw err;
    }
}

function parseJsonFile(path) {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!isPlainObject(value)) throw new Error('top-level value must be a JSON object');
    return value;
}

/**
 * Why an agent override is not allowed for a rule, or null when it is allowed.
 * Protected and secret rules may only be tightened (level up, allow subset of base allow).
 */
function overrideProblem(entry, ov) {
    if (ov.level !== undefined && !isLevel(ov.level)) return `unknown level "${String(ov.level)}"`;
    if (ov.allow !== undefined && !isStringArray(ov.allow)) return 'allow must be an array of strings';
    if (entry.level === 'normal') return null;
    if (ov.level !== undefined && LEVEL_RANK[ov.level] < LEVEL_RANK[entry.level]) return `would loosen level ${entry.level} to ${ov.level}`;
    if (ov.allow !== undefined && !ov.allow.every((x) => entry.allow.includes(x))) return 'would add intents';
    return null;
}

/**
 * @param {object} options
 * @param {string} options.rootDir extension root; config files are read from rootDir/config
 * @param {string} [options.copilotHome] defaults to {home}\.copilot
 * @param {Record<string, string | undefined>} [options.env] environment used for placeholders (default process.env)
 * @param {{ now: () => number }} [options.clock]
 * @param {(warning: { code: string, file: string, message: string, at: number }) => void} [options.onWarning]
 */
export function createConfigStore({ rootDir, copilotHome, env = process.env, clock = realClock, onWarning = () => {} } = {}) {
    if (!rootDir) throw new TypeError('createConfigStore: rootDir is required');

    const home = trimSlash(env.USERPROFILE || env.HOME || homedir());
    const vars = Object.freeze({
        home,
        temp: trimSlash(env.TEMP || env.TMP || tmpdir()),
        appdata: trimSlash(env.APPDATA || join(home, 'AppData', 'Roaming')),
        localappdata: trimSlash(env.LOCALAPPDATA || join(home, 'AppData', 'Local')),
        copilotHome: trimSlash(copilotHome || join(home, '.copilot')),
    });
    const cliDir = join(vars.copilotHome, 'cli-tools');

    /** name → { path, sig, value } for governor, agents and registered groups */
    const sources = new Map([
        ['governor', { path: join(rootDir, 'config', 'governor.json'), sig: undefined, value: undefined }],
        ['agents', { path: join(rootDir, 'config', 'agents.json'), sig: undefined, value: undefined }],
    ]);
    /** cli-tools file name → { sig, data } (data = last valid parsed document, or null) */
    const cliFiles = new Map();
    /** warnings already emitted since the last reload (so repeated calls do not repeat them) */
    const emitted = new Set();

    const warn = (code, file, message) => {
        const key = `${code}|${file}|${message}`;
        if (emitted.has(key)) return;
        emitted.add(key);
        onWarning({ code, file, message, at: clock.now() });
    };

    function loadSource(name, src) {
        const sig = signatureOf(src.path);
        if (sig === src.sig) return;
        src.sig = sig;
        emitted.clear();
        if (sig === 'missing') {
            const keep = src.value === undefined ? '' : '; keeping last valid version';
            warn('CONFIG_MISSING', src.path, `${name}: file not found${keep}`);
            return;
        }
        try {
            src.value = parseJsonFile(src.path);
        } catch (err) {
            warn('CONFIG_INVALID_JSON', src.path, `${name}: ${err.message}; keeping last valid version`);
        }
    }

    function refreshCliTools() {
        const names = (() => {
            try {
                return readdirSync(cliDir).filter((n) => /\.json$/i.test(n));
            } catch (err) {
                if (err.code === 'ENOENT') return [];
                throw err;
            }
        })();
        for (const name of [...cliFiles.keys()]) if (!names.includes(name)) cliFiles.delete(name);
        for (const name of names) {
            const path = join(cliDir, name);
            const sig = signatureOf(path);
            const current = cliFiles.get(name);
            if (current && current.sig === sig) continue;
            emitted.clear();
            if (sig === 'missing') {
                cliFiles.delete(name);
                continue;
            }
            try {
                cliFiles.set(name, { sig, data: parseJsonFile(path) });
            } catch (err) {
                cliFiles.set(name, { sig, data: current?.data ?? null });
                warn('CLI_TOOLS_INVALID_JSON', path, `${err.message}; keeping last valid version`);
            }
        }
    }

    function refresh() {
        for (const [name, src] of sources) loadSource(name, src);
        refreshCliTools();
    }

    const valueOf = (name) => sources.get(name)?.value;

    /** Tool name → 'read-only' | 'default' for one agent: shared _shell.json tools plus the agent's own file. */
    function accessFor(agentName) {
        const shared = cliFiles.get(SHARED_CLI_FILE)?.data ?? null;
        const own = agentName === SHARED_CLI_FILE.replace(/\.json$/, '') ? null : cliFiles.get(`${agentName}.json`)?.data ?? null;
        const tools = (doc) => (Array.isArray(doc?.CliTools) ? doc.CliTools.filter((t) => isPlainObject(t) && typeof t.Name === 'string') : []);
        const accessOf = (t) => (t.Access === 'read-only' ? 'read-only' : 'default');
        const out = {};
        if (shared && own?.IncludeShell !== false) for (const t of tools(shared)) out[t.Name] = accessOf(t);
        for (const t of tools(own)) out[t.Name] = accessOf(t);
        return out;
    }

    /** Base directory rules with placeholders resolved, then the agent's overrides merged in. */
    function directoriesFor(agentName) {
        const raw = valueOf('directories')?.rules;
        const rules = Array.isArray(raw) ? raw.filter(isPlainObject) : [];
        const byId = new Map();
        const entries = rules.map((rule) => {
            const level = isLevel(rule.level) ? rule.level : 'secret';
            if (!isLevel(rule.level)) warn('DIRECTORY_RULE_INVALID', 'directories.json', `rule "${String(rule.id)}": unknown level, treated as secret`);
            const entry = { ...rule, level, allow: isStringArray(rule.allow) ? [...rule.allow] : [] };
            if (typeof rule.pattern === 'string') entry.pattern = resolvePlaceholders(rule.pattern, vars);
            byId.set(rule.id, entry);
            return entry;
        });

        const overrides = valueOf('agents')?.agents?.[agentName]?.directories;
        if (isPlainObject(overrides)) {
            for (const [id, ov] of Object.entries(overrides)) {
                const entry = byId.get(id);
                if (!entry) {
                    warn('AGENT_OVERRIDE_UNKNOWN_RULE', 'agents.json', `${agentName}: no directory rule "${id}"`);
                    continue;
                }
                if (!isPlainObject(ov)) {
                    warn('AGENT_OVERRIDE_INVALID', 'agents.json', `${agentName}: override of "${id}" is not an object`);
                    continue;
                }
                const problem = overrideProblem(entry, ov);
                if (problem) {
                    warn('AGENT_OVERRIDE_REJECTED', 'agents.json', `${agentName}: override of ${entry.level} rule "${id}" rejected (${problem})`);
                    continue;
                }
                const ignored = Object.keys(ov).filter((k) => k !== 'level' && k !== 'allow');
                if (ignored.length) warn('AGENT_OVERRIDE_IGNORED', 'agents.json', `${agentName}: "${id}" keys ignored: ${ignored.join(', ')}`);
                if (ov.level !== undefined) entry.level = ov.level;
                if (ov.allow !== undefined) entry.allow = [...ov.allow];
            }
        }
        return entries;
    }

    return Object.freeze({
        /**
         * Registers a JSON file group (for example the directory rules or the tool catalog) read through this store.
         * @param {string} name
         * @param {string} path absolute path of the JSON file
         */
        register(name, path) {
            if (!name || !path) throw new TypeError('register: name and path are required');
            sources.set(name, { path, sig: undefined, value: undefined });
        },

        /**
         * Current settings. `enabled` is false only when governor.json says so explicitly.
         * @returns {{ governor: object | null, enabled: boolean, agents: object, groups: Record<string, object | null> }}
         */
        get() {
            refresh();
            const governor = valueOf('governor') ?? null;
            const agentsDoc = valueOf('agents');
            const groups = {};
            for (const [name, src] of sources) {
                if (name === 'governor' || name === 'agents') continue;
                groups[name] = src.value ?? null;
            }
            return Object.freeze({
                governor,
                enabled: governor?.enabled !== false,
                agents: isPlainObject(agentsDoc?.agents) ? agentsDoc.agents : {},
                groups: Object.freeze(groups),
            });
        },

        /**
         * Effective settings for one agent: directory rules (base + allowed overrides) and CLI tool Access.
         * @param {string} agentName
         */
        agentPolicy(agentName) {
            refresh();
            const name = String(agentName);
            return Object.freeze({
                agent: name,
                directories: directoriesFor(name),
                cliTools: Object.freeze(accessFor(name)),
            });
        },
    });
}
