// Tool catalog of the shell governor. config/catalog holds one JSON spec per tool (<tool>.json) plus pwsh-core.json
// (cmdlet, .NET and cmd tables). This module builds the catalog from those files or from config-store groups, and
// classifies worker argv facts: native commands (parseNative, matchOp, classifyNative, normalizeNative), PowerShell
// cmdlets (classifyCmdlet, normalizeCmdlet), .NET static calls (dotnetClass), SQL carriers (sqlMap, via sql.mjs) and
// official account-CLI reads (officialReadEligible). Pure functions; loadCatalog reads the catalog directory only.
// No SDK imports, no npm dependencies.
//
// Tool spec fields (one object per file): tool, executables[], providerHosts[] (optional), caseSensitive, posix, slashFlags,
// globalNoValue[], globalWithValue[], valueFlags[], effectiveCwdFlags[], pathFlags {flag: intent}, positionalPaths,
// firstPositionalIsPattern, recursive [{ exe, always, flags, slashFlags, bypassFlags, bypass }] (rg/fd recurse by default and skip
// hidden and ignored files, grep -r and findstr /s do not), sqlCarrier {sub | dbPositional, sqlPositional, queryFlags[], fileFlags[], remote}, ops[], default.
// An op matches when all of its keys match: pos (leading verbs), posPrefix {i, p}, anyPos, posRegex, minPos, maxPos,
// anyFlag, noFlag, flagIn, flagNonConst, flagValueRegex, afterDD. The highest-ranked matching class wins.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASS_INTENT, OP_CLASS_RANK } from './contracts.mjs';
import { looksPath, mkPath, resolveFull } from './paths.mjs';
import { classifySql, classifySqliteDot } from './sql.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Shipped catalog directory: extensions/shell-governor/config/catalog. */
export const DEFAULT_CATALOG_DIR = join(HERE, '..', 'config', 'catalog');
const CORE_KIND = 'pwsh-core';
const CORE_FILE = 'pwsh-core.json';
const CORE_KEYS = ['exact', 'verbs', 'dotnet', 'pathParams'];
const GROUP_PREFIX = 'catalog:';

// Official account CLIs (S6 d): send flags (bodies, fields, uploads) and non-GET method flags keep the current class.
const SEND_FLAGS = new Set(['-f', '-F', '--raw-field', '--field', '--input', '--body', '--body-file', '--data', '-d', '--upload-file', '-T', '--form']);
const METHOD_FLAGS = new Set(['-X', '--method', '--http-method']);
const AZ_READ_VERBS = ['list', 'show', 'get', 'query'];
const AZ_READ_OPS = ['az.read', 'az.rest.get', 'az.rest.method-read', 'az.devops.invoke.get', 'az.devops.invoke.read'];
const AWS_READ_PREFIXES = ['describe-', 'list-', 'get-'];
const KUBECTL_READ_OPS = ['kubectl.read', 'kubectl.rollout.read'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const executableKey = (exe) => String(exe).toLowerCase().replace(/\.(exe|cmd|com)$/, '');
const rankOf = (cls) => {
    const i = OP_CLASS_RANK.indexOf(cls);
    return i < 0 ? OP_CLASS_RANK.indexOf('unknown') : i;
};

// ---------- catalog building ----------

/**
 * Builds the catalog from parsed documents. Each tool spec is one object; a second spec for an executable is an error.
 * @param {Array<{ name: string, value: unknown }>} entries one entry per catalog file (name is used in error messages)
 * @returns {{ tools: Map<string, object>, core: object }} tools keyed by lower-case executable name without .exe/.cmd/.com
 */
export function buildCatalog(entries) {
    const tools = new Map();
    let core = null;
    for (const { name, value } of entries) {
        if (!isObject(value)) throw new Error(`catalog ${name}: top-level value must be a JSON object (one tool per file)`);
        if (value.kind === CORE_KIND) {
            if (core) throw new Error(`catalog ${name}: second ${CORE_KIND} document`);
            core = value;
            continue;
        }
        if (typeof value.tool !== 'string' || !Array.isArray(value.executables)) {
            throw new Error(`catalog ${name}: needs "tool" and "executables"`);
        }
        for (const exe of value.executables) {
            const key = executableKey(exe);
            const prev = tools.get(key);
            if (prev && prev !== value) throw new Error(`catalog ${name}: executable "${exe}" already belongs to tool "${prev.tool}"`);
            tools.set(key, value);
        }
    }
    if (!core) throw new Error(`catalog: ${CORE_FILE} is missing`);
    for (const key of CORE_KEYS) {
        if (core[key] === undefined) throw new Error(`catalog: ${CORE_FILE} has no "${key}"`);
    }
    return { tools, core };
}

const catalogFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

function readCatalogFile(dir, file) {
    const text = readFileSync(join(dir, file), 'utf8').replace(/^\uFEFF/, '');
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`catalog ${file}: ${err.message}`);
    }
}

/**
 * Loads the catalog from a directory of JSON files (default: the shipped config/catalog).
 * @param {string} [dir]
 */
export function loadCatalog(dir = DEFAULT_CATALOG_DIR) {
    return buildCatalog(catalogFiles(dir).map((file) => ({ name: file, value: readCatalogFile(dir, file) })));
}

/**
 * Registers each catalog file with the config store as group "catalog:<file name without .json>" (hot reload).
 * @param {{ register: (name: string, path: string) => void }} store a store from lib/config.mjs
 * @param {string} [dir]
 * @returns {string[]} the registered group names
 */
export function registerCatalogGroups(store, dir = DEFAULT_CATALOG_DIR) {
    return catalogFiles(dir).map((file) => {
        const name = GROUP_PREFIX + file.slice(0, -'.json'.length);
        store.register(name, join(dir, file));
        return name;
    });
}

/**
 * Builds the catalog from the groups of a config-store snapshot (config.get().groups). Groups that are null (never
 * loaded or invalid) are skipped, so their tools classify as unknown.
 * @param {Record<string, unknown>} groups
 */
export function catalogFromGroups(groups) {
    const entries = Object.entries(groups ?? {})
        .filter(([name, value]) => name.startsWith(GROUP_PREFIX) && value !== null && value !== undefined)
        .map(([name, value]) => ({ name: name.slice(GROUP_PREFIX.length) + '.json', value }));
    return buildCatalog(entries);
}

/** Provider hosts declared by the catalog specs (sorted, lower case). */
export function providerHostsOf(catalog) {
    const hosts = new Set();
    for (const spec of new Set(catalog.tools.values())) {
        for (const host of spec.providerHosts ?? []) hosts.add(String(host).toLowerCase());
    }
    return [...hosts].sort();
}

/** True when the host is a declared provider host or a subdomain of one. */
export function isProviderHost(host, catalog) {
    const h = String(host).toLowerCase();
    return providerHostsOf(catalog).some((p) => h === p || h.endsWith('.' + p));
}

// ---------- native parsing and matching ----------

/**
 * Splits worker args into positionals and flags, using the spec's value-taking and global flag lists.
 * @param {object} spec tool spec
 * @param {Array<object>} args worker args ({ k: 'param' | 'word', raw, name, value, isConst })
 * @returns {{ pos: Array<{ value, isConst, raw, afterDD }>, flags: Array<{ name, value, nonConst, global? }> }}
 */
export function parseNative(spec, args) {
    const toks = (args ?? []).map((a) => ({
        isParam: a.k === 'param' || (spec.slashFlags && a.k === 'word' && /^\/[A-Za-z?]+$/.test(a.raw ?? '')),
        raw: a.raw ?? '', value: a.value ?? null, isConst: !!a.isConst,
    }));
    const pos = [];
    const flags = [];
    const vf = new Set(spec.valueFlags ?? []);
    const gw = new Set(spec.globalWithValue ?? []);
    const gn = new Set(spec.globalNoValue ?? []);
    let dd = false;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (!t.isParam) {
            if (t.raw === '--') { dd = true; continue; }
            pos.push({ value: t.value, isConst: t.isConst, raw: t.raw, afterDD: dd });
            continue;
        }
        if (t.raw === '--') { dd = true; continue; }
        let name = t.raw;
        let inline = null;
        const m = /^(-{1,2}[^=:]+)[=:](.*)$/.exec(t.raw);
        if (m) { name = m[1]; inline = m[2]; }
        if (gw.has(name)) {
            let v = inline; let nc = false;
            if (v === null) { const nx = toks[i + 1]; if (nx && !nx.isParam) { v = nx.isConst ? nx.value : null; nc = !nx.isConst; i++; } }
            flags.push({ name, value: v, nonConst: nc, global: true });
            continue;
        }
        if (gn.has(name)) { flags.push({ name, value: null, nonConst: false, global: true }); continue; }
        if (spec.posix && /^-[A-Za-z]{2,}$/.test(name) && !vf.has(name) && inline === null) {
            const letters = name.slice(1).split('');
            for (let j = 0; j < letters.length; j++) {
                const fl = '-' + letters[j];
                if (vf.has(fl)) {
                    if (j < letters.length - 1) flags.push({ name: fl, value: letters.slice(j + 1).join(''), nonConst: false });
                    else {
                        const nx = toks[i + 1]; let v = null; let nc = false;
                        if (nx && !nx.isParam) { v = nx.isConst ? nx.value : null; nc = !nx.isConst; i++; }
                        flags.push({ name: fl, value: v, nonConst: nc });
                    }
                    break;
                }
                flags.push({ name: fl, value: null, nonConst: false });
            }
            continue;
        }
        if (inline !== null) { flags.push({ name, value: inline, nonConst: inline.includes('$') }); continue; }
        if (vf.has(name)) {
            const nx = toks[i + 1];
            if (nx && !nx.isParam) { flags.push({ name, value: nx.isConst ? nx.value : null, nonConst: !nx.isConst }); i++; }
            else flags.push({ name, value: null, nonConst: false });
            continue;
        }
        flags.push({ name, value: null, nonConst: false });
    }
    return { pos, flags };
}

/** True when one op's keys all match the parsed command. */
export function matchOp(op, parsed, spec) {
    const cs = spec.caseSensitive !== false;
    const norm = (s) => (cs ? s : s.toLowerCase());
    const pvl = parsed.pos.map((x) => (x.isConst ? String(x.value).toLowerCase() : '<expr>'));
    const restStart = op.pos?.length ?? 0;
    if (op.pos) {
        if (op.pos.length > pvl.length) return false;
        for (let k = 0; k < op.pos.length; k++) if (pvl[k] !== op.pos[k].toLowerCase()) return false;
    }
    if (op.posPrefix) {
        const v = pvl[op.posPrefix.i] ?? '';
        if (!op.posPrefix.p.some((q) => v.startsWith(q))) return false;
    }
    if (op.anyPos) {
        const rest = pvl.slice(restStart);
        if (!rest.some((v) => op.anyPos.includes(v))) return false;
    }
    if (op.posRegex) {
        const re = new RegExp(op.posRegex, 'i');
        if (!parsed.pos.slice(restStart).some((x) => x.isConst && re.test(String(x.value)))) return false;
    }
    const restCount = pvl.length - restStart;
    if (op.minPos !== undefined && restCount < op.minPos) return false;
    if (op.maxPos !== undefined && restCount > op.maxPos) return false;
    const names = parsed.flags.map((f) => norm(f.name));
    const has = (n) => names.includes(norm(n));
    if (op.anyFlag && !op.anyFlag.some(has)) return false;
    if (op.noFlag && op.noFlag.some(has)) return false;
    if (op.flagIn) {
        const ok = Object.entries(op.flagIn).some(([n, vals]) => parsed.flags.some((f) => norm(f.name) === norm(n) && f.value !== null &&
            vals.map((v) => v.toLowerCase()).includes(String(f.value).toLowerCase())));
        if (!ok) return false;
    }
    if (op.flagNonConst) {
        if (!parsed.flags.some((f) => op.flagNonConst.some((n) => norm(n) === norm(f.name)) && f.nonConst)) return false;
    }
    if (op.flagValueRegex) {
        const ok = Object.entries(op.flagValueRegex).some(([n, rx]) => parsed.flags.some((f) => norm(f.name) === norm(n) && f.value !== null &&
            new RegExp(rx, 'i').test(String(f.value))));
        if (!ok) return false;
    }
    if (op.afterDD && !parsed.pos.some((x) => x.afterDD)) return false;
    return true;
}

/**
 * Classifies parsed native args with a tool spec: the highest-ranked matching op wins.
 * @returns {{ cls: string, op: object | null, execKind: string | null, allow: boolean, ops: string[] }}
 */
export function classifyNative(spec, parsed) {
    const matched = (spec.ops ?? []).filter((op) => matchOp(op, parsed, spec));
    if (matched.length === 0) return { cls: spec.default ?? 'unknown', op: null, execKind: null, allow: false, ops: [] };
    let best = matched[0];
    for (const m of matched) if (rankOf(m.class) > rankOf(best.class)) best = m;
    const execKind = matched.find((m) => m.class === best.class && m.execKind)?.execKind ?? null;
    return { cls: best.class, op: best, execKind, allow: matched.some((m) => m.allow), ops: matched.map((m) => m.id) };
}

// ---------- cmdlets and .NET ----------

function paramMap(args) {
    const m = new Map();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.k === 'param') {
            const nx = args[i + 1];
            const val = nx && nx.k === 'word' ? nx : null;
            m.set(a.name.toLowerCase(), val);
        }
    }
    return m;
}

/** Operation class of a PowerShell cmdlet: overrides first, then name prefixes, exact names, then the verb table. */
export function classifyCmdlet(core, name, args) {
    const pm = paramMap(args);
    const words = args.filter((a) => a.k === 'word' && a.isConst).map((a) => String(a.value));
    for (const o of core.overrides ?? []) {
        if (o.cmd !== name) continue;
        if (o.anyParam && !o.anyParam.some((p) => pm.has(p))) continue;
        if (o.paramValueIn) {
            const ok = Object.entries(o.paramValueIn).some(([p, vals]) => pm.has(p) && pm.get(p)?.isConst &&
                vals.includes(String(pm.get(p).value).toLowerCase()));
            if (!ok) continue;
        }
        if (o.wordRegex && !words.some((w) => new RegExp(o.wordRegex, 'i').test(w))) continue;
        return o.class;
    }
    for (const o of core.namePrefixOverrides ?? []) if (name.startsWith(o.prefix)) return o.class;
    if (core.exact[name]) return core.exact[name];
    const verb = name.split('-')[0];
    for (const [cls, verbs] of Object.entries(core.verbs)) if (verbs.includes(verb)) return cls;
    return 'unknown';
}

/** Class of a .NET static member (`Type::Method`, lower case) from the core dotnet table. */
export function dotnetClass(core, dn) {
    for (const e of core.dotnet) {
        const re = new RegExp('^' + e.match.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (re.test(dn)) return e;
    }
    return { match: dn, class: core.dotnetDefault ?? 'unknown' };
}

// ---------- normalization ----------

/** Maps a SQL statement class to an operation class (remote carriers map writes to remote-*). */
export function sqlMap(cls, remote) {
    switch (cls) {
        case 'read': return 'read';
        case 'session': return 'session';
        case 'scratch': return 'unknown';
        case 'execute': return remote ? 'remote-write' : 'execute-code';
        case 'write': return remote ? 'remote-write' : 'write';
        case 'delete': return remote ? 'remote-destructive' : 'delete';
        case 'admin': return 'admin';
        default: return 'unknown';
    }
}

/**
 * True when an official account-CLI call (gh, az, aws, kubectl) is a read: no send flags, no non-GET method flag,
 * and a read operation. Raw HTTP tools and every other tool never qualify.
 * @param {object} cmd a result of normalizeNative or normalizeCmdlet
 */
export function officialReadEligible(cmd) {
    if (cmd.sendFlags || cmd.methodNonRead) return false;
    const v = cmd.verbs ?? [];
    switch (cmd.tool) {
        case 'gh':
            if (cmd.opId === 'gh.api.get') return true;
            if (v[0] === 'search') return true;
            if (['pr', 'issue'].includes(v[0]) && ['view', 'list', 'diff', 'checks', 'status'].includes(v[1])) return true;
            if (['repo', 'run', 'release'].includes(v[0]) && ['view', 'list'].includes(v[1])) return true;
            return false;
        case 'az':
            if (['az.rest.get', 'az.rest.method-read', 'az.devops.invoke.get', 'az.devops.invoke.read'].includes(cmd.opId)) return true;
            return AZ_READ_OPS.includes(cmd.opId) && v.some((x) => AZ_READ_VERBS.includes(x));
        case 'aws':
            if (v[0] === 's3' && v[1] === 'ls') return true;
            return cmd.opId === 'aws.read' && AWS_READ_PREFIXES.some((p) => String(v[1] ?? '').startsWith(p));
        case 'kubectl':
            return KUBECTL_READ_OPS.includes(cmd.opId) && ['get', 'describe', 'logs', 'top', 'version', 'explain', 'events', 'api-resources', 'api-versions', 'cluster-info', 'diff', 'wait', 'auth', 'status', 'history'].some((x) => v.includes(x));
        default:
            return false;
    }
}

/**
 * Recursion of a read: 'bypass' (ignores hidden/ignore rules or is a plain recursive reader such as grep -r), 'ignore-aware'
 * (rg and fd skip hidden and ignored files by default) or null. Rules come from the spec's `recursive` array:
 * { exe?, always?, flags?, slashFlags?, bypassFlags?, bypass? } — a rule is active when `always` or one of its flags / Windows
 * switches is present; it bypasses when `bypass` is set or one of its `bypassFlags` is present. The strictest active rule wins.
 */
function recursionOf(rules, name, flagNames, positionals) {
    let result = null;
    for (const rule of rules ?? []) {
        if (rule.exe && !rule.exe.includes(name)) continue;
        const has = (list) => (list ?? []).some((f) => flagNames.includes(f));
        const slash = (rule.slashFlags ?? []).some((s) => positionals.some((p) => p.toLowerCase() === s.toLowerCase()));
        if (!(rule.always || has(rule.flags) || slash)) continue;
        const mode = rule.bypass || has(rule.bypassFlags) ? 'bypass' : 'ignore-aware';
        if (mode === 'bypass' || result === null) result = mode;
    }
    return result;
}

/**
 * Normalizes one worker native command with its tool spec into a classified operation.
 * @param {object} c worker command ({ name, inv, args, cwd, redirs, pipedFrom, inner })
 * @param {object} spec tool spec from the catalog
 * @param {{ gitRootOf?: (dir: string) => string | null, resolve?: (value: unknown, cwd: string | null) => string | null, sqlFileRoots?: string[] }} [ctx]
 *   gitRootOf: repo root for SQL file carriers; resolve: path resolver with the injected home (default: paths.resolveFull);
 *   sqlFileRoots: folders (besides the cwd's repo) from which SQL files of a carrier may be read (default: none)
 */
export function normalizeNative(c, spec, ctx = {}) {
    const P_ = parseNative(spec, c.args ?? []);
    const cwd = c.cwd ?? null;
    const gitRootOf = ctx.gitRootOf ?? (() => null);
    const resolve = ctx.resolve ?? ((v, dir) => resolveFull(v, dir));
    const sqlFileRoots = (ctx.sqlFileRoots ?? []).map((r) => String(r).replace(/[\\/]+$/, '').toLowerCase());
    const cl = classifyNative(spec, P_);
    let cls = cl.cls;
    if (cls === 'pass-through') cls = c.inner ? 'read' : 'dynamic';
    let remote = false;
    let sqlInfo = null;
    const paths = [];
    // effective cwd (git -C, npm --prefix, tar -C); a flag whose value cannot be resolved makes the cwd unknown (never the call's cwd)
    let effCwd = cwd;
    let effUnknown = !cwd;
    let effFlagUnknown = false;
    for (const f of P_.flags) {
        if ((spec.effectiveCwdFlags ?? []).includes(f.name)) {
            if (f.value === null) { effUnknown = true; effFlagUnknown = true; effCwd = null; }
            else {
                effCwd = resolve(f.value, effCwd);
                if (!effCwd || /^(url|registry|unc|provider):/.test(effCwd)) { effUnknown = true; effFlagUnknown = true; effCwd = null; }
            }
        }
    }
    const base = effFlagUnknown ? null : (effCwd ?? cwd);
    // SQL carriers
    if (spec.sqlCarrier) {
        const sc = spec.sqlCarrier;
        let applies;
        if (sc.dbPositional !== undefined) applies = true;
        else if (sc.sub) applies = P_.pos[0]?.isConst && String(P_.pos[0].value).toLowerCase() === sc.sub;
        else applies = P_.flags.some((f) => [...(sc.queryFlags ?? []), ...(sc.fileFlags ?? [])].includes(f.name));
        if (applies) {
            const texts = [];
            let unknown = false;
            const q = P_.flags.find((f) => (sc.queryFlags ?? []).includes(f.name));
            if (q) { if (q.value === null) unknown = true; else texts.push(q.value); }
            const fl = P_.flags.find((f) => (sc.fileFlags ?? []).includes(f.name));
            if (fl) {
                const dir = base;
                const full = fl.value === null ? null : resolve(fl.value, dir);
                const root = dir ? gitRootOf(dir) : null;
                const lf = full ? full.toLowerCase() : '';
                const okRead = full && !/^(url|registry|unc|provider):/.test(full) &&
                    ((root && lf.startsWith(root.toLowerCase() + '\\')) || sqlFileRoots.some((r) => r && lf.startsWith(r + '\\')));
                let body = null;
                if (okRead && existsSync(full) && statSync(full).size <= 65536) { try { body = readFileSync(full, 'utf8'); } catch { body = null; } }
                if (body === null) unknown = true; else texts.push(body);
            }
            if (sc.sqlPositional !== undefined) {
                const sp = P_.pos[sc.sqlPositional];
                if (sp && sp.isConst) texts.push(String(sp.value)); else if (sp) unknown = true;
            }
            if (c.pipedFrom) unknown = true;
            if (sc.dbPositional !== undefined) {
                const dbp = P_.pos[sc.dbPositional];
                if (dbp && dbp.isConst) paths.push(mkPath(resolve(dbp.value, base), false, 'read', 'target', base));
                else paths.push(mkPath(null, true, 'read', 'target', base));
            }
            if (!unknown && texts.length === 0) unknown = true;
            if (!unknown) {
                const text = texts.join('\n');
                if (sc.dbPositional !== undefined && text.trim().startsWith('.')) {
                    const d = classifySqliteDot(text);
                    sqlInfo = { kind: 'dot', ...d };
                    cls = d.cls === 'read' ? 'read' : d.cls === 'execute' ? 'execute-code' : 'unknown';
                } else {
                    const r = classifySql(text);
                    sqlInfo = { kind: 'sql', cls: r.cls, n: r.statements.length };
                    cls = sqlMap(r.cls, !!sc.remote);
                }
            } else {
                cls = 'unknown';
                sqlInfo = { kind: 'unresolved' };
            }
            remote = !!sc.remote && cls !== 'read';
        }
    }
    // path extraction
    const pf = spec.pathFlags ?? {};
    for (const f of P_.flags) {
        if (pf[f.name] !== undefined) {
            const intent = pf[f.name] === 'execute' ? 'execute' : pf[f.name];
            const kind = pf[f.name] === 'execute' ? 'script' : 'target';
            if (f.value === null) paths.push(mkPath(null, true, intent, kind, base));
            else paths.push(mkPath(resolve(f.value, base), false, intent, kind, base));
        }
    }
    const intent0 = CLASS_INTENT[cls] ?? 'read';
    const skipFirstPattern = !!spec.firstPositionalIsPattern && !P_.flags.some((f) => ['-e', '--regexp', '-f', '--file'].includes(f.name));
    if (spec.positionalPaths && !sqlInfo) {
        const scriptKind = cl.execKind === 'script';
        const startIdx = cl.op?.pos?.length ?? 0;
        let first = true;
        const slashSwitches = new Set((spec.recursive ?? []).filter((r) => !r.exe || r.exe.includes(c.name)).flatMap((r) => r.slashFlags ?? []).map((s) => s.toLowerCase()));
        P_.pos.forEach((x, pi) => {
            if (skipFirstPattern && pi === 0) return;
            if (x.isConst && slashSwitches.has(String(x.value).toLowerCase())) return; // a Windows switch such as findstr /s, not a path
            if (scriptKind && pi === startIdx && first) {
                first = false;
                if (x.isConst) paths.push(mkPath(resolve(x.value, base), false, 'execute', 'script', base));
                else paths.push(mkPath(null, true, 'execute', 'script', base));
                return;
            }
            if (x.isConst && looksPath(x.value)) paths.push(mkPath(resolve(x.value, base), false, intent0, 'target', base));
            else if (!x.isConst && (cls === 'write' || cls === 'delete' || cls === 'execute-code')) paths.push(mkPath(null, true, intent0, 'target', base));
        });
    }
    if (paths.length === 0 && !remote && ['write', 'delete', 'execute-code', 'install', 'download'].includes(cls)) {
        paths.push(effUnknown ? mkPath(null, true, intent0, 'implicit', null) : mkPath(effCwd, false, intent0, 'implicit', effCwd));
    }
    // a read without any path reads the (effective) working directory; an unresolvable -C/--prefix value is an unresolved read
    if (paths.length === 0 && cls === 'read') {
        if (effFlagUnknown) paths.push(mkPath(null, true, 'read', 'implicit', null));
        else if (base) paths.push(mkPath(base, false, 'read', 'implicit', base));
    }
    const writeRedirs = (c.redirs ?? []).filter((r) => !r.nullSink);
    for (const r of writeRedirs) {
        if (r.isConst) paths.push(mkPath(resolve(r.value, base), false, 'write', 'redir', base));
        else paths.push(mkPath(null, true, 'write', 'redir', base));
    }
    let pkgName = null;
    if (cl.execKind === 'pkgscript') {
        const p0 = P_.pos[0]?.value?.toLowerCase();
        if (p0 === 'test' || p0 === 't') pkgName = 'test';
        else if (p0 === 'run' || p0 === 'run-script') pkgName = P_.pos[1]?.isConst ? String(P_.pos[1].value) : null;
        else pkgName = p0 ?? null;
    }
    if (cl.execKind === 'devtool' || cl.execKind === 'devtool-any') pkgName = P_.pos[0]?.isConst ? String(P_.pos[0].value) : null;
    return {
        tool: spec.tool, name: c.name, inv: c.inv, cls, opId: cl.op?.id ?? null, execKind: cl.execKind, allow: cl.allow,
        sub: sqlInfo ? [`sql:${sqlInfo.kind}`] : (cl.op ? [cl.op.id] : []), paths, remote, cwd: base, repoCwd: base, pkgName, sqlInfo,
        pipedFrom: !!c.pipedFrom, hasInner: !!c.inner,
        sendFlags: P_.flags.some((f) => SEND_FLAGS.has(f.name)),
        recursive: cls === 'read'
            ? recursionOf(spec.recursive, c.name, P_.flags.map((f) => f.name), P_.pos.filter((x) => x.isConst).map((x) => String(x.value)))
            : null,
        methodNonRead: P_.flags.some((f) => METHOD_FLAGS.has(f.name) && (f.value === null || !['get', 'head'].includes(String(f.value).toLowerCase()))),
        verbs: P_.pos.map((x) => (x.isConst ? String(x.value).toLowerCase() : '<expr>')),
    };
}

/** Read cmdlets that take file paths (positional or parameter): their path-like words are read paths, and without a path they read the pipeline or the cwd. */
const READ_PATH_CMDLETS = new Set([
    'get-content', 'get-childitem', 'select-string', 'format-hex', 'get-filehash', 'get-acl', 'get-item', 'get-itemproperty',
    'get-itempropertyvalue', 'test-path', 'resolve-path', 'select-xml', 'get-authenticodesignature', 'get-pfxcertificate',
]);
/** Position of the positional path argument when it is not the first one (Select-String takes the pattern first). */
const PATH_POSITION = { 'select-string': 1 };
const CWD_CMDLETS = new Set(['set-location', 'push-location', 'pop-location', 'cd', 'chdir', 'sl', 'pushd', 'popd']);

/**
 * Normalizes one worker cmdlet with the core table into a classified operation.
 * @param {object} c worker cmdlet ({ name, args, cwd, redirs, pipedFrom, inner })
 * @param {object} core the pwsh-core document
 * @param {{ resolve?: (value: unknown, cwd: string | null) => string | null }} [ctx] path resolver with the injected home (default: paths.resolveFull)
 */
export function normalizeCmdlet(c, core, ctx = {}) {
    const name = c.name;
    const args = c.args ?? [];
    const resolve = ctx.resolve ?? ((v, dir) => resolveFull(v, dir));
    let cls = classifyCmdlet(core, name, args);
    if (cls === 'dynamic' && c.inner) cls = 'read';
    const cwd = c.cwd ?? null;
    // cwd-only cmdlets change the effective cwd (tracked by the worker); they touch no file
    if (CWD_CMDLETS.has(name)) {
        return { tool: null, name, inv: c.inv, cls: 'read', opId: null, execKind: null, allow: false, sub: [], paths: [], remote: false,
            cwd, repoCwd: cwd, pkgName: null, sqlInfo: null, pipedFrom: !!c.pipedFrom, hasInner: !!c.inner, cmdlet: true };
    }
    const paths = [];
    const intent0 = CLASS_INTENT[cls] ?? 'read';
    const isMove = ['move-item', 'rename-item'].includes(name);
    const isCopy = name === 'copy-item';
    const readsPaths = cls === 'read' && (READ_PATH_CMDLETS.has(name) || name.startsWith('import-'));
    // path parameters: the word after a path-typed parameter, plus positional path words bound by the worker
    const boundIdx = new Set();
    args.forEach((a, i) => {
        if (a.k === 'param' && core.pathParams.includes(a.name.toLowerCase())) {
            const nx = args[i + 1];
            if (nx && nx.k === 'word') boundIdx.add(i + 1);
            else paths.push(mkPath(null, true, intent0, 'target', cwd));
        }
    });
    args.forEach((a, i) => {
        if (a.k !== 'word') return;
        const bound = boundIdx.has(i) || a.pathParam;
        if (!bound) {
            if (!readsPaths) return;
            // read cmdlets: the positional path argument and any constant path-like word is a read path
            const atPathPosition = a.pos === (PATH_POSITION[name] ?? 0);
            if (!a.isConst) { if (atPathPosition) paths.push(mkPath(null, true, 'read', 'target', cwd)); return; }
            if (atPathPosition || looksPath(a.value)) paths.push(mkPath(resolve(a.value, cwd), false, 'read', 'target', cwd));
            return;
        }
        if (!a.isConst) { paths.push(mkPath(null, true, intent0, 'target', cwd)); return; }
        let intent = intent0;
        if (isCopy || isMove) intent = a.pos === 0 ? (isMove ? 'delete' : 'read') : 'write';
        paths.push(mkPath(resolve(a.value, cwd), false, intent, 'target', cwd));
    });
    // a read without any path: path-taking cmdlets read their pipeline input (always unresolved: strings bind by value, objects by
    // their Path property), everything else the working directory. Only Select-String over text lines (Get-Content or a native
    // tool upstream, pipeSource "data") reads no file from its pipeline.
    if (paths.length === 0 && cls === 'read') {
        if (readsPaths && c.pipedFrom) {
            if (!(name === 'select-string' && c.pipeSource === 'data')) paths.push(mkPath(null, true, 'read', 'target', cwd));
        } else if (cwd) paths.push(mkPath(cwd, false, 'read', 'implicit', cwd));
        else if (readsPaths) paths.push(mkPath(null, true, 'read', 'implicit', null));
    }
    for (const r of (c.redirs ?? []).filter((x) => !x.nullSink)) {
        if (r.isConst) paths.push(mkPath(resolve(r.value, cwd), false, 'write', 'redir', cwd));
        else paths.push(mkPath(null, true, 'write', 'redir', cwd));
    }
    if (paths.length === 0 && ['write', 'delete', 'execute-code'].includes(cls) && name !== 'start-process') {
        // cmdlets with no bound path: writes/deletes without a resolvable target stay unresolved
        if (cls !== 'execute-code') paths.push(mkPath(null, true, intent0, 'target', cwd));
    }
    // recursive listing/search: Get-ChildItem -Recurse/-Depth skips hidden items unless -Force; Select-String -Recurse is never ignore-aware
    let recursive = null;
    if (cls === 'read' && (name === 'get-childitem' || name === 'select-string')) {
        const names = args.filter((a) => a.k === 'param').map((a) => String(a.name));
        if (names.some((n) => /^rec(u(r(s(e)?)?)?)?$/i.test(n) || /^depth$/i.test(n))) {
            recursive = name === 'select-string' || names.some((n) => /^force$/i.test(n)) ? 'bypass' : 'ignore-aware';
        }
    }
    return {
        tool: null, name, inv: c.inv, cls, opId: null, execKind: null, allow: false, sub: [], paths, remote: false, recursive,
        cwd, repoCwd: cwd, pkgName: null, sqlInfo: null, pipedFrom: !!c.pipedFrom, hasInner: !!c.inner, cmdlet: true,
    };
}
