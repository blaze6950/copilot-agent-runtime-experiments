// Directory policy and path resolution of the shell governor: glob matching of directory rules, repo-root lookup under
// the configured code roots, resolution of worker path values and the verdict of one path. Pure functions; the only
// file access is the existence check of repoRootOf, realpath lookups and the folder listing of wildcard paths (all
// injectable). Machine paths come from placeholders that the config
// store resolves ({home}, {temp}, {appdata}, {localappdata}, {copilotHome}) and from {sessionId}; none is hard-coded.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { win32 as P } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTENT, LEVEL, VERDICT, VERDICT_SEVERITY } from './contracts.mjs';

/** Config group name under which the directory rules are registered with the config store. */
export const DIRECTORIES_GROUP = 'directories';
/** Production directory rules (extensions/shell-governor/config/directories.json). */
export const DEFAULT_DIRECTORIES_PATH = fileURLToPath(new URL('../config/directories.json', import.meta.url));

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const INTENT_VALUES = new Set(Object.values(INTENT));
const SCRIPT_GATE = 'script-freshness';
const PRE_EXISTING = 'pre-existing';
/** A name segment that can be an 8.3 short name ("PROGRA~1", "CONFIG~1.JSO"). */
const SHORT_NAME = /~\d/;
const SHORT_NAME_RULE = 'DIR-SHORTNAME-UNRESOLVED';
/** How long a realpath answer is reused (ms) and how many are kept. */
export const REALPATH_TTL_MS = 1000;
const REALPATH_MAX_ENTRIES = 1024;
const LEVEL_RANK = { secret: 3, protected: 2, normal: 1 };

/** Trailing backslashes removed (a drive root keeps its colon). */
const trimTail = (p) => p.replace(/\\+$/, '');

/** Answer of the realpath cache for a path that exists but cannot be resolved (access denied, symlink loop, ...): unknown, not "missing". */
const REAL_ERROR = Object.freeze({ error: true });
/** Error codes of "there is no such file or folder"; every other failure leaves the real location unknown. */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);
const REAL_ERROR_RULE = 'DIR-REALPATH-UNRESOLVED';

/**
 * Cached real path lookup: the answer of `realpath` (fs.realpathSync.native: expands 8.3 short names, junctions and
 * symbolic links) per path, kept for `ttlMs`. A path that does not exist (ENOENT, ENOTDIR) answers null; any other failure
 * (EACCES, EPERM, ELOOP, ...) answers `{ error: true }` (the location is unknown). Both are cached too.
 * @param {{ realpath?: (path: string) => string, now?: () => number, ttlMs?: number }} [options]
 * @returns {(path: string) => string | null | { error: true }}
 */
export function createRealpathCache({ realpath = realpathSync.native, now = () => Date.now(), ttlMs = REALPATH_TTL_MS } = {}) {
    const cache = new Map();
    return (path) => {
        const key = path.toLowerCase();
        const at = now();
        const hit = cache.get(key);
        if (hit && at >= hit.at && at - hit.at < ttlMs) return hit.value;
        let value;
        try {
            value = realpath(path);
        } catch (err) {
            value = err && NOT_FOUND_CODES.has(err.code) ? null : REAL_ERROR;
        }
        if (cache.size >= REALPATH_MAX_ENTRIES) cache.clear();
        cache.set(key, { at, value });
        return value;
    };
}

const defaultRealpath = createRealpathCache();

/** Wildcard expansion bounds: matches evaluated per path, and directory entries looked at while expanding one path. */
export const WILDCARD_MAX_MATCHES = 200;
export const WILDCARD_MAX_SCANNED = 2000;
const WILDCARD_RULE = 'DIR-WILDCARD-UNBOUNDED';
/** A path with a character that can be a PowerShell wildcard or its escape ("*", "?", "[", backtick): the only paths that need file system work. */
const WILDCARD_HINT = /[*?[`]/;

/**
 * Default folder listing of the wildcard expansion: every entry name (hidden ones included). A folder that does not exist
 * (or is a file) answers null; any other failure (access denied, ...) throws and makes the expansion unbounded.
 * @param {string} dir
 * @returns {string[] | null}
 */
export function defaultListDir(dir) {
    try {
        return readdirSync(dir);
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
        throw err;
    }
}

/**
 * One path segment as PowerShell reads it: "*", "?" and "[set]" are wildcards, a backtick escapes the next character.
 * `literal` is the segment without wildcards (escapes removed) or null; `re` matches an entry name (case-insensitive).
 * A "[set]" starting with "^" or "!" is read as a negation (more matches than PowerShell finds is the safe side).
 * @param {string} seg
 * @returns {{ literal: string | null, re: RegExp | null, text: string }}
 */
function segmentOf(seg) {
    let re = '';
    let literal = '';
    let wild = false;
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i];
        if (ch === '`' && i + 1 < seg.length) {
            i++;
            literal += seg[i];
            re += seg[i].replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
        } else if (ch === '*') {
            wild = true;
            re += '.*';
        } else if (ch === '?') {
            wild = true;
            re += '.';
        } else if (ch === '[' && seg.indexOf(']', i + 2) > 0) {
            const close = seg.indexOf(']', i + 2);
            let set = seg.slice(i + 1, close);
            const negated = /^[!^]/.test(set);
            if (negated) set = set.slice(1);
            wild = true;
            re += `[${negated ? '^' : ''}${set.replace(/[\\\]^]/g, '\\$&')}]`;
            i = close;
        } else {
            literal += ch;
            re += ch.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
        }
    }
    if (!wild) return { literal, re: null, text: seg };
    try {
        return { literal: null, re: new RegExp(`^${re}$`, 'i'), text: seg };
    } catch {
        return { literal: null, re: /^.*$/s, text: seg }; // an invalid set such as "[z-a]": match everything (the safe side)
    }
}

/**
 * Lexical canonical form of an absolute drive path, as Windows itself would read it: "\\?\" and "\\.\" prefixes removed,
 * trailing dots and spaces of every segment dropped, alternate data stream suffixes (":stream", "::$DATA") dropped,
 * "." and ".." collapsed. Other values (UNC, "url:", ...) are returned unchanged.
 * @param {string} full
 * @returns {string}
 */
export function canonicalizePath(full) {
    let s = String(full);
    if (/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(s)) s = s.slice(4);
    if (!/^[A-Za-z]:[\\/]/.test(s)) return s;
    const segments = s.split(/[\\/]+/);
    const out = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
        let seg = segments[i];
        const colon = seg.indexOf(':');
        if (colon >= 0) seg = seg.slice(0, colon);
        const trimmed = seg.replace(/ +$/, '');
        if (trimmed === '.' || trimmed === '..') seg = trimmed;
        else seg = seg.replace(/[. ]+$/, '');
        if (seg === '' && i < segments.length - 1) continue; // "a\ \b": a segment of only dots/spaces names nothing
        out.push(seg);
    }
    return P.normalize(out.join('\\'));
}

/**
 * Real location of a canonical path: the deepest existing ancestor is resolved with `real` (short names, junctions and
 * links expanded) and the not yet existing remainder is appended. `unresolved` is true when that remainder still holds
 * a segment that can be an 8.3 short name (nothing tells what it stands for).
 * @param {string} canonical
 * @param {(path: string) => string | null | { error: true }} real
 * @returns {{ path: string, unresolved: boolean, error?: boolean }} `error`: a lookup failed for a reason other than "does not exist" (the target is unresolved)
 */
function realTargetOf(canonical, real) {
    let cur = trimTail(canonical);
    if (/^[A-Za-z]:$/.test(cur)) cur += '\\';
    const tail = [];
    for (let k = 0; k < 64; k++) {
        const hit = real(cur);
        if (hit !== null && typeof hit === 'object') return { path: canonical, unresolved: true, error: true };
        if (hit !== null) {
            const base = canonicalizePath(hit);
            return { path: tail.length ? P.join(base, ...tail) : base, unresolved: tail.some((seg) => SHORT_NAME.test(seg)) };
        }
        const up = P.dirname(cur);
        if (up === cur) break;
        tail.unshift(P.basename(cur));
        cur = up;
    }
    return { path: canonical, unresolved: tail.some((seg) => SHORT_NAME.test(seg)) };
}

const LOOPBACK_NAMES = Object.freeze(['localhost', '127.0.0.1', '::1', '0-0-0-0-0-0-0-1.ipv6-literal.net']);

/** Names under which this machine reaches itself in a UNC path (loopback names plus the computer name). */
export function defaultHostNames(env = process.env) {
    const names = new Set(LOOPBACK_NAMES);
    for (const n of [env.COMPUTERNAME, safeHostname()]) if (n) names.add(String(n).toLowerCase());
    return [...names];
}
function safeHostname() {
    try {
        return hostname();
    } catch {
        return '';
    }
}
let cachedHostNames = null;


/**
 * Registers the directory rules with a config store under the group name `directories`.
 * @param {{ register: (name: string, path: string) => void }} store
 * @param {string} [directoriesPath] defaults to config/directories.json of this extension
 */
export function registerDirectoryPolicy(store, directoriesPath = DEFAULT_DIRECTORIES_PATH) {
    store.register(DIRECTORIES_GROUP, directoriesPath);
}

/**
 * Glob of one rule pattern as a regular expression over a lowercase Windows path. "X\**" also matches X itself;
 * "**" spans folders and "*" stops at a backslash. Placeholders must already be resolved.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globRe(pattern) {
    let p = pattern.toLowerCase();
    let tail = '';
    if (p.endsWith('\\**')) {
        p = p.slice(0, -3);
        tail = '(\\\\.*)?';
    }
    let re = '';
    for (let i = 0; i < p.length;) {
        if (p.startsWith('**', i)) {
            re += '.*';
            i += 2;
        } else if (p[i] === '*') {
            re += '[^\\\\]*';
            i++;
        } else {
            re += p[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    return new RegExp(`^${re}${tail}$`);
}

/**
 * @typedef {object} CompiledRule
 * @property {string} id
 * @property {'normal'|'protected'|'secret'} level
 * @property {string[]} allow intents allowed by a normal rule (reads are always allowed outside secret rules)
 * @property {boolean} repo true for the rule that matches the repo root of the effective cwd
 * @property {RegExp|null} re null for repo rules and for rules whose {sessionId} is unknown (never match)
 * @property {string|null} exceptionTo protected rule id this normal rule is an exception to
 * @property {string[]|null} exceptionIntents intents of the exception (null = all intents)
 * @property {string|null} gate extra check on execution (script-freshness)
 */

/**
 * @typedef {object} DirectoryPolicy
 * @property {ReadonlyArray<CompiledRule>} rules
 * @property {string|null} repoRoot repo root of the effective cwd, or null
 * @property {(path: string) => string|null|{error: true}} real cached realpath lookup (null when the path does not exist, `{ error: true }` when it cannot be resolved)
 * @property {(dir: string) => string[]|null} listDir folder listing for wildcard expansion (null when the folder does not exist; throws on other failures)
 * @property {(fullPath: string) => 'pre-existing'|'fresh'|'missing'} scriptStatus freshness of a session script
 */

/**
 * Compiles the directory rules of one agent (config store output) for one session and one repo root.
 * `{sessionId}` is substituted; a rule that needs a session id never matches when none is valid.
 * Only protected and secret rules also match under that real location (see matchingRules).
 * @param {ReadonlyArray<object>} entries
 * @param {{ sessionId?: string, repoRoot?: string|null, scriptStatus?: (fullPath: string) => string,
 *   realpath?: (path: string) => string, now?: () => number, listDir?: (dir: string) => string[] | null }} [options]
 *   `realpath` (default fs.realpathSync.native) and `now` are injectable for tests; answers are cached for REALPATH_TTL_MS;
 *   `listDir` (default: fs.readdirSync) lists a folder for the expansion of wildcard paths (null: no such folder)
 * @returns {DirectoryPolicy}
 */
export function compileDirectoryPolicy(entries, { sessionId, repoRoot = null, scriptStatus = () => 'missing', realpath, now, listDir = defaultListDir } = {}) {
    const sid = typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
    const real = realpath ? createRealpathCache({ realpath, now }) : defaultRealpath;
    const rules = entries.map((entry) => {
        let re = null;
        let reAlt = null;
        let parts = null;
        let base = null;
        if (typeof entry.pattern === 'string') {
            const needsSession = entry.pattern.includes('{sessionId}');
            if (!needsSession || sid) {
                const pattern = entry.pattern.split('{sessionId}').join(sid ?? '');
                re = globRe(pattern);
                parts = pattern.toLowerCase().split('\\');
                base = concreteBase(parts);
                const alt = realPattern(pattern, real);
                if (alt) reAlt = globRe(alt);
            }
        }
        return Object.freeze({
            id: String(entry.id),
            level: entry.level,
            allow: Array.isArray(entry.allow) ? [...entry.allow] : [],
            repo: entry.repo === true,
            re,
            reAlt,
            parts,
            base,
            exceptionTo: typeof entry.exceptionTo === 'string' ? entry.exceptionTo : null,
            exceptionIntents: Array.isArray(entry.exceptionIntents) ? [...entry.exceptionIntents] : null,
            gate: typeof entry.gate === 'string' ? entry.gate : null,
        });
    });
    return Object.freeze({ rules: Object.freeze(rules), repoRoot, scriptStatus, real, listDir });
}

/** The rule pattern with its literal folder prefix replaced by that prefix's real location, or null when it is the same. */
function realPattern(pattern, real) {
    const parts = pattern.split('\\');
    const wild = parts.findIndex((seg) => seg.includes('*'));
    const literal = wild < 0 ? parts : parts.slice(0, wild);
    if (literal.length < 2 || !/^[A-Za-z]:$/.test(literal[0])) return null;
    const prefix = literal.join('\\');
    const target = realTargetOf(canonicalizePath(prefix), real);
    if (target.unresolved || target.path.toLowerCase() === trimTail(canonicalizePath(prefix)).toLowerCase()) return null;
    return [trimTail(target.path), ...parts.slice(literal.length)].join('\\');
}

/**
 * Git repo root of a working directory: the nearest ancestor with a .git entry, reported only when it lies strictly
 * under one of the configured code roots (governor.json codeRoots). Read-only existence checks.
 * @param {string|null|undefined} cwd
 * @param {{ codeRoots?: string[], exists?: (path: string) => boolean }} [options]
 * @returns {string|null}
 */
export function repoRootOf(cwd, { codeRoots, exists = existsSync } = {}) {
    if (!cwd || !Array.isArray(codeRoots)) return null;
    const roots = codeRoots
        .filter((r) => typeof r === 'string' && r.trim() !== '')
        .map((r) => trimTail(P.normalize(r)).toLowerCase());
    let d = P.normalize(cwd);
    let found = null;
    for (let k = 0; k < 64; k++) {
        if (P.parse(d).root === d) break;
        if (exists(P.join(d, '.git'))) {
            found = trimTail(d);
            break;
        }
        const up = P.dirname(d);
        if (up === d) break;
        d = up;
    }
    if (!found) return null;
    const lf = found.toLowerCase();
    return roots.some((r) => lf.startsWith(`${r}\\`)) ? found : null;
}

/**
 * Resolves a worker value against the effective cwd. Returns an absolute path, a "url:", "registry:", "unc:" or "provider:" prefixed
 * value, or null when the value is dynamic (contains "$" or "%") or relative without a cwd. The path is canonical (see
 * canonicalizePath): "\\?\C:\x", "\??\C:\x" (NT form), "\\localhost\c$\x" (also 127.0.0.1 and the computer name) and "FileSystem::C:\x" all give "C:\x";
 * only UNC paths of other machines (and other shares) keep the "unc:" form, as do the device and NT namespaces that map to no drive letter
 * (GLOBALROOT, Volume{GUID}, HarddiskVolumeN, "\GLOBAL??\", "\Device\", "\?\").
 * @param {unknown} value
 * @param {string|null|undefined} cwd
 * @param {{ home?: string, hostNames?: string[] }} [options] `hostNames`: further names of this machine in UNC paths (loopback names always count; default: COMPUTERNAME and os.hostname())
 * @returns {string|null}
 */
export function resolveFull(value, cwd, { home = homedir(), hostNames } = {}) {
    if (value === null || value === undefined) return null;
    let s = String(value).trim().replace(/^["']+|["']+$/g, '');
    if (/^(https?|ftp):\/\//i.test(s)) return `url:${s}`;
    if (/^(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+)[:\\]/i.test(s)) return `registry:${s}`;
    s = s.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, ''); // provider-qualified path: the file system itself
    if (/^(?:Microsoft\.PowerShell\.Core\\)?Registry::/i.test(s)) return `registry:${s}`;
    // NT object-manager prefix: "\??\C:\x" is the NT spelling of "\\?\C:\x" (.NET reads it as a device path too), so it takes the device branch below
    // ("\??\C:\x" -> "C:\x"; "\??\C:x", "\??\Volume{...}\x", "\??\GLOBALROOT\..." -> unresolved like their "\\?\" twins). Without this rewrite
    // the value was a root-relative path "C:\??\C\x" that no secret rule matched (TFIX-7).
    if (/^[\\/]\?\?(?:[\\/]|$)/.test(s)) s = `\\\\?\\${s.slice(4)}`;
    // Other namespaces that can reach local files without a drive letter the governor maps: the NT DOS-devices directory "\GLOBAL??\C:\x", the NT
    // device tree "\Device\HarddiskVolume3\x" and a single-separator "\?\..." (never an ordinary folder). Unresolved: "unc:" (AI for a read; the file
    // tools and every write intent end in a dialog). Never a root-relative path of the current drive.
    else if (/^[\\/](?:GLOBAL\?\?|Device|\?)(?:[\\/]|$)/i.test(s)) return `unc:${s}`;
    if (/^[\\/]{2}[?.][\\/]/.test(s)) { // device paths: "\\?\C:\x", "\\.\C:\x", "\\?\UNC\server\share"; GLOBALROOT, Volume{GUID}, HarddiskVolumeN stay unresolved
        const rest = s.slice(4);
        if (/^[A-Za-z]:(?:[\\/]|$)/.test(rest)) s = rest;
        else if (/^UNC[\\/]/i.test(rest)) s = `\\\\${rest.slice(4)}`;
        else return `unc:${s}`;
    }
    if (/^[\\/]{2}/.test(s)) { // UNC: only the drive shares of this machine are local files
        const local = localDrivePath(s, hostNames ? [...LOOPBACK_NAMES, ...hostNames] : (cachedHostNames ??= defaultHostNames()));
        if (local === null) return `unc:${s}`;
        s = local;
    }
    if (/^(Alias|Function|Variable|Env|Cert|WSMan):/i.test(s)) return `provider:${s}`; // PowerShell provider drives are no folders
    if (s === '~' || /^~[\\/]/.test(s)) s = home + s.slice(1);
    // Drive-relative forms ("C:foo", "C:", "C:foo::$DATA") are relative to the current directory of drive C, not to the cwd. The check runs
    // BEFORE the stream suffixes are stripped and the "$" test: otherwise "C:.env::$DATA" would reach the later steps as the cwd-relative "C".
    if (/^\s*[A-Za-z]:(?![\\/])/.test(s)) return null;
    if (s.includes('$')) s = stripStreamSuffixes(s);
    if (/[$%]/.test(s)) return null; // PowerShell ($) and cmd (%) variables are never constants
    if (/^[A-Za-z]:/.test(s)) return canonicalizePath(P.normalize(s));
    if (!cwd) return null;
    if (/^[\\/]/.test(s)) return canonicalizePath(P.normalize(P.join(P.parse(cwd).root, s)));
    return canonicalizePath(P.normalize(P.join(cwd, s)));
}

/** Values of resolveFull that are not a local file path ("url:", "registry:", "unc:", "provider:"). */
export const NOT_LOCAL_PATH = /^(url|registry|unc|provider):/;

/**
 * NTFS stream suffixes removed per path segment: "::$DATA", ":$DATA", ":name:$DATA", "::$INDEX_ALLOCATION", ":$I30:$INDEX_ALLOCATION".
 * They hold "$" but are no variables; canonicalizePath drops them later, so the secret rules see the real file or folder.
 * A "$" anywhere else in a segment (or a suffix of another shape) is left alone and keeps the value dynamic.
 * @param {string} s
 * @returns {string}
 */
function stripStreamSuffixes(s) {
    return s.split(/([\\/]+)/).map((seg, i) => {
        if (i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
        const m = /^([^:$]*)((?::\$?[^:\\/$]*)+)$/.exec(seg);
        return m && m[2].includes('$') ? m[1] : seg;
    }).join('');
}

/** "X:\rest" for "\\<this machine>\X$\rest" (admin drive share of localhost, 127.0.0.1 or the computer name), else null. */
function localDrivePath(unc, hostNames) {
    const m = /^[\\/]{2}([^\\/]+)[\\/]+([A-Za-z])\$(?:[\\/]+(.*))?$/.exec(unc);
    if (!m) return null;
    const host = m[1].toLowerCase().replace(/\.+$/, '');
    if (!hostNames.some((h) => host === h.toLowerCase() || host.startsWith(`${h.toLowerCase()}.`))) return null;
    return `${m[2].toUpperCase()}:\\${m[3] ?? ''}`;
}

/** True when a constant word looks like a file path (separator, dot prefix, "~", drive letter or "%") and is not a URL. */
export const looksPath = (s) => typeof s === 'string' && /[\\/]|^\.|^~|^[A-Za-z]:|%/.test(s) && !/^https?:/i.test(s);

/**
 * One path reference of a command: `full` is the resolved value (absolute path, "url:"/"registry:"/"unc:" form, or null),
 * `dynamic` is true when the value could not be resolved.
 * @param {string|null|undefined} full
 * @param {boolean} dynamic
 * @param {'read'|'write'|'delete'|'execute'} intent
 * @param {'target'|'script'|'redir'|'implicit'} kind
 * @param {string|null} cwd
 */
export const mkPath = (full, dynamic, intent, kind, cwd) => ({
    full, dynamic: dynamic || full === null || full === undefined, intent, kind, cwd,
});

/**
 * Rules that match a lowercase, normalized path (the repo rule matches the written repo root and everything below it).
 * Links can only add restrictions: a normal rule matches only through its written pattern (`re`) and the written repo root;
 * a protected or secret rule also matches through its real-location pattern (`reAlt`), so a link into a protected or secret folder is still caught.
 */
function matchingRules(lf, policy) {
    const repos = [policy.repoRoot]
        .filter((r) => typeof r === 'string' && r !== '')
        .map((r) => trimTail(P.normalize(r)).toLowerCase());
    const hits = [];
    for (const rule of policy.rules) {
        if (rule.repo) {
            if (repos.some((repo) => lf === repo || lf.startsWith(`${repo}\\`))) hits.push(rule);
        } else if ((rule.re && rule.re.test(lf))
            || (rule.reAlt && (rule.level === LEVEL.PROTECTED || rule.level === LEVEL.SECRET) && rule.reAlt.test(lf))) {
            hits.push(rule);
        }
    }
    return hits;
}

/** Verdict record: verdict, rule id list, short reason (no path), level and matched directory rule id. */
const result = (verdict, ruleId, hit, reason) => ({
    verdict,
    ruleIds: [ruleId],
    reason,
    level: hit?.level ?? 'unclassified',
    directoryId: hit?.id ?? null,
});

/** The more restrictive of two verdicts (ASK over AI over SAFE; on a tie the stricter rule level, then `a`). */
function worse(a, b) {
    const d = VERDICT_SEVERITY[b.verdict] - VERDICT_SEVERITY[a.verdict];
    if (d !== 0) return d > 0 ? b : a;
    return (LEVEL_RANK[b.level] ?? 0) > (LEVEL_RANK[a.level] ?? 0) ? b : a;
}

/**
 * Directory verdict of one absolute path for one access intent. The path is judged under two names and the stricter
 * verdict wins: its canonical form (trailing dots and spaces, streams and device prefixes removed) and its real location
 * (8.3 short names, junctions and symbolic links expanded; see compileDirectoryPolicy). A short name that cannot be
 * expanded because nothing exists behind it is unresolved: AI for a read, ASK for any other intent (DIR-SHORTNAME-UNRESOLVED);
 * so is a path whose real location cannot be looked up for another reason than "does not exist" (DIR-REALPATH-UNRESOLVED).
 * - Any secret rule matched: ASK (DIR-SECRET) for every intent.
 * - Read on a normal or protected location: SAFE (reads are allowed outside secret rules).
 * - Write, delete or execute under a protected rule: ASK, unless a normal rule declares an exception for it.
 * - Otherwise a normal rule must allow the intent (SAFE, DIR-OK); a session script run needs a pre-existing script.
 * - Read outside every rule: SAFE (READ-ANYWHERE); any other intent outside every rule: AI (DIR-OUTSIDE).
 * - A path with PowerShell wildcards is judged by the worst verdict of everything it can name (see wildcardVerdict).
 * @param {string} full absolute path (as resolved by resolveFull)
 * @param {'read'|'write'|'delete'|'execute'} intent
 * @param {DirectoryPolicy} policy
 * @returns {{ verdict: 'SAFE'|'AI'|'ASK', ruleIds: string[], reason: string, level: string, directoryId: string|null }}
 */
export function pathVerdict(full, intent, policy) {
    if (!INTENT_VALUES.has(intent)) throw new TypeError(`pathVerdict: unknown intent "${String(intent)}"`);
    const canonical = canonicalizePath(P.normalize(full));
    if (!WILDCARD_HINT.test(canonical) || !/^[A-Za-z]:\\/.test(canonical) || typeof policy.listDir !== 'function') return singleVerdict(canonical, intent, policy);
    return wildcardVerdict(canonical, intent, policy);
}

/** Verdict of one canonical path under its two names (see pathVerdict); no wildcard handling. */
function singleVerdict(canonical, intent, policy) {
    const lexical = verdictAt(canonical, intent, policy);
    if (lexical.ruleIds[0] === 'DIR-SECRET' || typeof policy.real !== 'function') return lexical;
    const target = realTargetOf(canonical, policy.real);
    let best = lexical;
    if (target.path.toLowerCase() !== canonical.toLowerCase()) best = worse(best, verdictAt(target.path, intent, policy));
    if (target.unresolved) {
        const why = target.error ? 'a path whose real location cannot be determined' : 'a path with an unresolvable 8.3 short name';
        const rule = target.error ? REAL_ERROR_RULE : SHORT_NAME_RULE;
        best = worse(best, intent === INTENT.READ
            ? result(VERDICT.AI, rule, null, `read of ${why}`)
            : result(VERDICT.ASK, rule, null, `${intent} of ${why}`));
    }
    return best;
}

/**
 * Verdict of a path with PowerShell wildcards ("*", "?", "[set]"; a backtick escapes): the worst verdict of the pattern
 * itself, of every existing path it matches (expanded per segment on the file system, hidden items included, at most
 * WILDCARD_MAX_MATCHES matches and WILDCARD_MAX_SCANNED folder entries) and, for anything but a read, of every secret or
 * protected rule location the pattern could still create. A bound that is exceeded or a listing that fails is
 * DIR-WILDCARD-UNBOUNDED: AI for a read, ASK for any other intent.
 */
function wildcardVerdict(canonical, intent, policy) {
    const segs = canonical.split('\\').filter((s, i) => i === 0 || s !== '').map(segmentOf);
    let best = singleVerdict(canonical, intent, policy);
    if (best.ruleIds[0] === 'DIR-SECRET') return best;

    if (intent !== INTENT.READ) {
        for (const candidate of rulesThatMatchPattern(segs, policy)) {
            best = worse(best, singleVerdict(candidate, intent, policy));
            if (best.ruleIds[0] === 'DIR-SECRET') return best;
        }
    }

    const { paths, unbounded } = expandWildcards(segs, policy.listDir);
    for (const path of paths) {
        best = worse(best, singleVerdict(path, intent, policy));
        if (best.ruleIds[0] === 'DIR-SECRET') return best;
    }
    if (unbounded) {
        best = worse(best, intent === INTENT.READ
            ? result(VERDICT.AI, WILDCARD_RULE, null, 'read through a wildcard path with too many matches to check')
            : result(VERDICT.ASK, WILDCARD_RULE, null, `${intent} through a wildcard path with too many matches to check`));
    }
    return best;
}

const joinSeg = (base, seg) => (base.endsWith('\\') ? `${base}${seg}` : `${base}\\${seg}`);

/** Existing paths a segment list matches: [paths, unbounded]. A folder that does not exist has no matches. */
function expandWildcards(segs, listDir) {
    let current = [`${segs[0].text}\\`];
    let scanned = 0;
    let unbounded = false;
    for (let i = 1; i < segs.length && current.length > 0 && !unbounded; i++) {
        const seg = segs[i];
        if (seg.re === null) {
            current = current.map((c) => joinSeg(c, seg.literal));
            continue;
        }
        const next = [];
        for (const dir of current) {
            let entries;
            try {
                entries = listDir(dir);
            } catch {
                unbounded = true;
                break;
            }
            if (!Array.isArray(entries)) continue;
            scanned += entries.length;
            if (scanned > WILDCARD_MAX_SCANNED) {
                unbounded = true;
                break;
            }
            for (const name of entries) if (seg.re.test(name)) next.push(joinSeg(dir, name));
            if (next.length > WILDCARD_MAX_MATCHES) {
                unbounded = true;
                next.length = WILDCARD_MAX_MATCHES;
                break;
            }
        }
        current = next;
    }
    return { paths: current, unbounded };
}

/**
 * Concrete paths that the pattern would name if the folders of a secret or protected rule existed: for every such rule with a
 * literal base (not starting with "**") whose segments the leading pattern segments can all match, the rule's base followed by
 * the rest of the pattern. Covers writes into locations that do not exist yet (the expansion only finds what exists).
 */
function rulesThatMatchPattern(segs, policy) {
    const found = [];
    for (const rule of policy.rules) {
        if (!rule.parts || (rule.level !== LEVEL.SECRET && rule.level !== LEVEL.PROTECTED)) continue;
        const recursive = rule.parts[rule.parts.length - 1] === '**';
        const base = recursive ? rule.parts.slice(0, -1) : rule.parts;
        if (base.length < 2 || base.includes('**') || !/^[a-z]:$/.test(base[0])) continue;
        if (recursive ? segs.length < base.length : segs.length !== base.length) continue;
        const built = [];
        let ok = true;
        for (let j = 0; j < base.length && ok; j++) {
            const ruleSeg = base[j];
            const ruleWild = ruleSeg.includes('*');
            const seg = segs[j];
            if (seg.re === null) {
                const text = seg.literal.toLowerCase();
                ok = ruleWild ? globRe(ruleSeg).test(text) : text === ruleSeg;
                built.push(seg.literal);
            } else {
                const text = ruleWild ? ruleSeg.replace(/\*+/g, '') || 'x' : ruleSeg;
                ok = seg.re.test(text);
                built.push(text);
            }
        }
        if (!ok) continue;
        for (let j = base.length; j < segs.length; j++) built.push(segs[j].literal ?? segs[j].text);
        found.push(built.join('\\'));
    }
    return found;
}

/**
 * Concrete base of a rule pattern (lowercase segments): the literal prefix before the first wildcard segment, "**" tail
 * dropped. Null when the pattern is not rooted at a drive or has no folder below the drive (anywhere-globs such as
 * "**\*.pem" or "**\.env" have no base).
 */
function concreteBase(parts) {
    const wild = parts.findIndex((seg) => seg.includes('*'));
    const base = wild < 0 ? parts : parts.slice(0, wild);
    return base.length >= 2 && /^[a-z]:$/.test(base[0]) ? base : null;
}

/**
 * Whether a recursion root can reach secret content: the root is equal to, inside, or an ancestor of the concrete base of a
 * secret rule ({home}\.ssh, {copilotHome}\mcp-secrets, {copilotHome}\extensions\shell-governor\logs, ...). The root is tried
 * under its canonical form and its real location; wildcard segments of the root match per segment.
 * Residual risk: secret rules without a concrete base (anywhere-globs such as **\*.pem, **\.env, **\.env.*) are NOT considered,
 * otherwise every recursion anywhere would match; a recursive content read may therefore still meet such a file.
 * @param {string} full absolute root path (as resolved by resolveFull)
 * @param {DirectoryPolicy} policy
 * @returns {string|null} id of the first secret rule reached, or null
 */
export function reachesSecretBase(full, policy) {
    return secretBasesReached(full, policy)[0] ?? null;
}

/**
 * Every secret rule whose concrete base a recursion root reaches (the matching of reachesSecretBase, for all rules).
 * A root whose real location is unknown reaches REAL_ERROR_RULE only; a path that is not rooted at a drive reaches nothing.
 * @param {string} full absolute root path (as resolved by resolveFull)
 * @param {DirectoryPolicy} policy
 * @returns {string[]} distinct ids of the reached secret rules, in policy.rules order (empty when none)
 */
export function secretBasesReached(full, policy) {
    const canonical = canonicalizePath(P.normalize(full));
    if (!/^[A-Za-z]:/.test(canonical)) return [];
    const names = [canonical];
    if (!WILDCARD_HINT.test(canonical) && typeof policy.real === 'function') {
        const resolved = realTargetOf(canonical, policy.real);
        if (resolved.error) return [REAL_ERROR_RULE]; // the real location is unknown: it may well be a secret base
        const target = resolved.path;
        if (target.toLowerCase() !== canonical.toLowerCase()) names.push(target);
    }
    const ids = [];
    for (const rule of policy.rules) {
        if (rule.level !== LEVEL.SECRET || !rule.base) continue;
        const reached = names.some((name) => isPrefixOfBase(name, rule.base) || (rule.re && rule.re.test(trimTail(name).toLowerCase())));
        if (reached) ids.push(rule.id);
    }
    return [...new Set(ids)];
}

/** True when the path's segments (wildcards allowed) are a leading part of, or all of, the base segments. */
function isPrefixOfBase(path, base) {
    const segs = trimTail(path).split('\\').filter((s, i) => i === 0 || s !== '').map(segmentOf);
    if (segs.length > base.length) return false;
    return segs.every((seg, j) => (seg.re === null ? seg.literal.toLowerCase() === base[j] : seg.re.test(base[j])));
}

/** Verdict of one canonical path against the rules (no real-path handling). */
function verdictAt(normalized, intent, policy) {
    const hits = matchingRules(trimTail(normalized).toLowerCase(), policy);
    if (hits.length === 0) {
        return intent === INTENT.READ
            ? result(VERDICT.SAFE, 'READ-ANYWHERE', null, 'read outside directory rules')
            : result(VERDICT.AI, 'DIR-OUTSIDE', null, `${intent} outside directory rules`);
    }

    const secret = hits.find((h) => h.level === LEVEL.SECRET);
    if (secret) return result(VERDICT.ASK, 'DIR-SECRET', secret, `${intent} on a secret location`);

    const normals = hits.filter((h) => h.level === LEVEL.NORMAL);
    const protectedHits = hits.filter((h) => h.level === LEVEL.PROTECTED
        && !normals.some((n) => n.exceptionTo === h.id && (!n.exceptionIntents || n.exceptionIntents.includes(intent))));

    if (intent === INTENT.READ) {
        return protectedHits.length
            ? result(VERDICT.SAFE, 'DIR-PROTECTED-READ', protectedHits[0], 'read of a protected location')
            : result(VERDICT.SAFE, 'DIR-OK', normals[0], 'read of an allowed location');
    }

    const upper = intent.toUpperCase();
    if (protectedHits.length) {
        return result(VERDICT.ASK, `DIR-PROTECTED-${upper}`, protectedHits[0], `${intent} on a protected location`);
    }

    const ok = normals.find((n) => n.allow.includes(intent));
    if (!ok) return result(VERDICT.AI, 'DIR-NOT-ALLOWED', normals[0], `${intent} not allowed by the matched location`);

    if (ok.gate === SCRIPT_GATE && intent === INTENT.EXECUTE) {
        const status = policy.scriptStatus(normalized);
        return status === PRE_EXISTING
            ? result(VERDICT.SAFE, 'B4-COPILOT-SCRIPT', ok, 'script existed before this session')
            : result(VERDICT.AI, 'B4-COPILOT-SCRIPT-NOT-PREEXISTING', ok, `script status: ${status}`);
    }
    return result(VERDICT.SAFE, 'DIR-OK', ok, `${intent} allowed by the matched location`);
}
