// Rule engine of the shell governor. Turns worker argv facts (pwsh/worker.ps1 op "argv") into one verdict per script:
// SYNTAX (the only automatic deny) | ASK | AI | SAFE, with the rule ids that decided it. Pure decision logic over
// injected collaborators: the facts provider (the pwsh worker client), the config store (directory rules, governor
// settings, tool catalog groups, CLI tool Access per agent) and the session context (script freshness).
// Only the decided behaviour is implemented (no research toggles): reads anywhere outside secret locations are SAFE,
// SQL session statements are SAFE, official account-CLI reads are SAFE, raw HTTP reads and unknown tools go to the AI,
// credential retrieval always asks, unresolved dynamic read paths go to the AI, policy B for build/test/scripts, and
// the data arguments of inline code and script runs are data, not paths.
// Read-only: the only file access is existence/stat/read of package.json files and repo markers. No SDK imports,
// no npm dependencies, no global lock: every evaluation works on its own state.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, win32 as P } from 'node:path';
import { CLASS_INTENT, OP_CLASS_RANK, VERDICT, VERDICT_SEVERITY } from './contracts.mjs';
import { catalogFromGroups, dotnetClass, normalizeCmdlet, normalizeNative, officialReadEligible } from './catalog.mjs';
import { compileDirectoryPolicy, looksPath, mkPath, pathVerdict, reachesSecretBase, repoRootOf, resolveFull } from './paths.mjs';

/** Folder name whose children are agent-owned git worktrees (history rewrites there go to the AI); config `engine.ownedWorktreeFolder`. */
export const DEFAULT_OWNED_WORKTREE_FOLDER = '.worktrees';
/** Folders from which SQL files of a carrier (snow sql -f) may be read besides the repo; config `engine.sqlFileRoots` ({home}, {copilotHome}, {temp} are replaced). */
export const DEFAULT_SQL_FILE_ROOTS = Object.freeze(['{copilotHome}\\session-state']);
/** Directory rule ids whose scripts never run unattended, even when they existed before the session; config `engine.scriptNeverSafeDirectories`. */
export const DEFAULT_SCRIPT_NEVER_SAFE_DIRECTORIES = Object.freeze(['temp', 'session-files']);

const MAX_WALK_DEPTH = 3;
/** Default reuse time of a config snapshot (ms); see createEngine settingsTtlMs. */
export const DEFAULT_SETTINGS_TTL_MS = 1000;
const MAX_PACKAGE_CACHE = 200;
const PREFIXED = /^(url|registry|unc|provider):/;
const SEG_SPLIT = /\s*(?:&&|\|\||\||;|&)\s*/;
/** Environment variables that hold credentials (name suffix, or a well-known provider prefix with a token/key/secret part); "*" stands for all of them. */
const CREDENTIAL_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CONNECTION_?STRING|CLIENT_?SECRET|PAT)$|^(GH|GITHUB|AZURE|AWS|NPM|NUGET)_.*(TOKEN|KEY|SECRET)/i;
const isCredentialEnvName = (name) => name === '*' || CREDENTIAL_ENV.test(name);
/** `$env:NAME` and `${env:NAME}` inside raw argument text. */
const ENV_REF = /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{env:([^}]+)\}/gi;

/** Failure of the engine itself (not of the script). The governor maps every engine error to ASK. */
export class EngineError extends Error {
    /** @param {'CATALOG_UNAVAILABLE' | 'WORKER_REQUIRED' | 'DIRECTORIES_UNAVAILABLE'} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
    }
}

/**
 * Directory rules of one agent, or an EngineError: without rules every path would be "outside every rule" and a read of a
 * secret file would pass, so a missing, unreadable or empty directories file must never be treated as "no restrictions".
 * @param {{ directories?: unknown }} policy result of config.agentPolicy
 * @returns {object[]}
 */
export function requireDirectoryRules(policy) {
    const rules = policy?.directories;
    if (!Array.isArray(rules) || rules.length === 0) {
        throw new EngineError('DIRECTORIES_UNAVAILABLE', 'directory rules unavailable (directories.json is missing, invalid or has no rules), so paths cannot be checked');
    }
    return rules;
}

/** Names of `$env:` variables referenced in the raw text of worker arguments. */
function envNamesOf(args) {
    const names = [];
    for (const a of args ?? []) {
        const raw = typeof a?.raw === 'string' ? a.raw : '';
        if (!raw.includes('$')) continue;
        for (const m of raw.matchAll(ENV_REF)) names.push(m[1] ?? m[2]);
    }
    return names;
}

// ---------- small helpers ----------

const rankOf = (cls) => {
    const i = OP_CLASS_RANK.indexOf(cls);
    return i < 0 ? OP_CLASS_RANK.indexOf('unknown') : i;
};
const intentOf = (cls) => CLASS_INTENT[cls] ?? 'read';
const trimTail = (p) => p.replace(/[\\/]+$/, '');
const sameDir = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Per-tool flag arity table for the worker's `config` request, built from the catalog specs.
 * @param {{ tools: Map<string, object> }} catalog
 * @returns {Record<string, { caseSensitive: boolean, posix: boolean, globalNoValue: string[], globalWithValue: string[], valueFlags: string[] }>}
 */
export function flagTableOf(catalog) {
    const table = {};
    for (const [exe, spec] of catalog.tools) {
        table[exe] = {
            caseSensitive: spec.caseSensitive !== false,
            posix: !!spec.posix,
            globalNoValue: [...(spec.globalNoValue ?? [])],
            globalWithValue: [...(spec.globalWithValue ?? [])],
            valueFlags: [...(spec.valueFlags ?? [])],
        };
    }
    return table;
}

/**
 * Deny reason of a syntax verdict: every parser message with its line and column, and the "nothing was executed" notice.
 * @param {Array<{ message?: string, line?: number, column?: number, inner?: boolean }>} parseErrors
 */
export function syntaxReason(parseErrors) {
    const list = parseErrors.map((e) => `${e.message ?? 'parse error'} (line ${e.line ?? '?'}, column ${e.column ?? '?'})${e.inner ? ' [nested script]' : ''}`);
    return `The PowerShell script has syntax errors; nothing was executed. ${list.join(' ')}`;
}

// ---------- cmd /c inner text ----------

const cmdTextSegments = (text) => text.split(SEG_SPLIT).map((s) => s.trim()).filter((s) => s.length);

/** Normalizes one segment of a literal `cmd /c` text with the core cmdTable. */
function normalizeCmdText(seg, core, cwd, ctx) {
    const toks = seg.replace(/>+\s*("[^"]*"|\S+)/g, ' ').match(/"[^"]*"|\S+/g) ?? [];
    const name = (toks[0] ?? '').replace(/"/g, '').toLowerCase();
    let cls = 'unknown';
    for (const [k, list] of Object.entries(core.cmdTable ?? {})) if (list.includes(name)) cls = k === 'cwd' ? 'read' : k;
    const intent = intentOf(cls);
    const paths = [];
    for (const t of toks.slice(1)) {
        const v = t.replace(/^"|"$/g, '');
        if (v.startsWith('/') && !looksPath(v)) continue;
        if (looksPath(v)) {
            const full = ctx.resolve(v, cwd);
            paths.push(full ? mkPath(full, false, intent, 'target', cwd) : mkPath(null, true, intent, 'target', cwd));
        }
    }
    const redir = seg.match(/>+\s*("[^"]+"|\S+)/);
    if (redir && !/^(\$null|nul|\/dev\/null)$/i.test(redir[1].replace(/"/g, ''))) {
        paths.push(mkPath(ctx.resolve(redir[1], cwd), false, 'write', 'redir', cwd));
    }
    if (cls === 'execute-code' && paths.length === 0) paths.push(mkPath(cwd, false, 'execute', 'implicit', cwd));
    // `set` and `set PREFIX` (no "=") list the environment variables, credentials included
    const envDump = name === 'set' && !toks.slice(1).some((t) => t.includes('='));
    return {
        tool: `cmd:${name}`, name, inv: 'command', cls, opId: 'cmd-table', execKind: null, allow: false, sub: [], paths, remote: false,
        cwd, repoCwd: cwd, pkgName: null, sqlInfo: null, pipedFrom: false, hasInner: false, cmdText: true, envDump,
    };
}

// ---------- .NET static calls ----------

/** Path-bearing System.IO static methods → [{ i: argument index, intent }]. */
function dotnetPathIntents(type, method) {
    if (!/(^|\.)io\.(file|directory)$/.test(type)) return [];
    const m = method;
    if (m === 'copy') return [{ i: 0, intent: 'read' }, { i: 1, intent: 'write' }];
    if (m === 'move' || m === 'replace') return [{ i: 0, intent: 'delete' }, { i: 1, intent: 'write' }];
    if (/^(readall|exists$|getfiles|getdirectories|getfilesystementries|openread|readlines|getlastwritetime|getattributes|opentext)/.test(m)) return [{ i: 0, intent: 'read' }];
    if (/^(writeall|appendall|createtext|appendtext|create|openwrite|open$)/.test(m)) return [{ i: 0, intent: 'write' }];
    if (m === 'delete') return [{ i: 0, intent: 'delete' }];
    return [];
}

const dotnetCommand = (name, cls, paths, cwd) => ({
    tool: '.net', name, inv: 'dotnet', cls, paths, cwd, repoCwd: cwd, sub: [], allow: false, remote: false, execKind: null,
    pipedFrom: false, hasInner: false, cmdlet: true,
});

// ---------- analysis ----------

/** Unresolved executable (dynamic call target or unknown exe/script path). */
function normalizeExe(c, ctx) {
    const ex = c.exeValue;
    if (!ex || ex === 'dynamic-path') {
        return { tool: null, name: c.name, cls: 'dynamic', paths: [], cwd: c.cwd, repoCwd: c.cwd, sub: [], allow: false, remote: false, execKind: null, pipedFrom: false, hasInner: false, inv: c.inv };
    }
    const kind = c.inv === 'script' ? 'script' : 'target';
    return {
        tool: null, name: c.name, inv: c.inv, cls: 'execute-code', opId: 'unknown-exe', execKind: c.inv === 'script' ? 'script' : 'exe', allow: false, remote: false,
        paths: [mkPath(ctx.resolve(ex, c.cwd), false, 'execute', kind, c.cwd)], cwd: c.cwd, repoCwd: c.cwd, sub: [], pkgName: null, sqlInfo: null, pipedFrom: !!c.pipedFrom, hasInner: false,
    };
}

/** Expression statement with file redirections ('x' > file): a write to each redirection target (null sinks are no write). */
function normalizeExpression(c, ctx) {
    const cwd = c.cwd ?? null;
    const paths = (c.redirs ?? []).filter((r) => !r.nullSink)
        .map((r) => (r.isConst ? mkPath(ctx.resolve(r.value, cwd), false, 'write', 'redir', cwd) : mkPath(null, true, 'write', 'redir', cwd)));
    return {
        tool: null, name: '<expression>', inv: 'expression', cls: paths.length ? 'write' : 'read', opId: null, execKind: null, allow: false, sub: [],
        paths, remote: false, cwd, repoCwd: cwd, pkgName: null, sqlInfo: null, pipedFrom: false, hasInner: false,
    };
}

/** True for a worker `commentSpansFor` that has the documented shape (UTF-16 length of the analysed script, 64-digit lowercase hex SHA-256 of its UTF-8 bytes) and comes with spans. */
function isSpanIdentity(spans, meta) {
    return Array.isArray(spans) && !!meta && typeof meta === 'object'
        && Number.isInteger(meta.length) && meta.length >= 0 && typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256);
}

/**
 * Flattens worker argv facts (recursing into inner scripts) and normalizes every command and .NET call.
 * @param {object} argv worker response of op "argv"
 * @param {string|null} cwd working directory of the call
 * @param {object} ctx evaluation context
 */
function analyze(argv, cwd, ctx) {
    const parseErrors = [...(argv.parseErrors ?? [])];
    const out = [];
    const flags = { downloadExec: false, nestedDynamic: false, download: false, pipeToIex: false, dynamicInvoke: false, dynamicCount: 0 };
    const dotnet = [];
    const dcalls = [];
    const envNames = [];
    const walk = (res, curCwd, depth, fromInner = false) => {
        if (depth > MAX_WALK_DEPTH) { flags.nestedDynamic = true; return; } // nesting deeper than analysed: treat as unanalysed dynamic code
        if (res.flags?.dynamicInvoke) flags.dynamicInvoke = true;
        if (Array.isArray(res.envRefs)) for (const name of res.envRefs) if (typeof name === 'string') envNames.push(name); // optional worker fact: every $env: name read
        for (const c of res.commands ?? []) {
            const fl = res.flags ?? {};
            if (fl.download) flags.download = true;
            if (fl.pipeToIex) flags.pipeToIex = true;
            if (fl.nestedDynamic || fl.undecodable) flags.nestedDynamic = true;
            envNames.push(...envNamesOf(c.args));
            if (c.inner?.kind === 'cmd') {
                for (const seg of cmdTextSegments(c.inner.text ?? '')) out.push({ ...normalizeCmdText(seg, ctx.catalog.core, c.cwd ?? curCwd, ctx), innerText: true });
                continue;
            }
            if (c.inner?.commands && c.inner.parseErrors?.length) {
                parseErrors.push(...c.inner.parseErrors.map((e) => ({ ...e, inner: true })));
            }
            if (c.inv === 'dynamic') flags.dynamicCount++;
            if (c.inv !== 'scriptblock') { // a script block is analyzed through its inner commands
                const spec = c.inv === 'command' || c.inv === 'exe' || c.inv === 'script' ? ctx.catalog.tools.get(String(c.name)) : null;
                let n;
                if (spec) n = normalizeNative(c, spec, ctx.nativeCtx);
                else if ((c.inv === 'exe' || c.inv === 'script') && c.name) n = normalizeExe(c, ctx);
                else if (c.inv === 'expression') n = normalizeExpression(c, ctx);
                else if (c.inv === 'dynamic') n = { tool: null, name: '<dynamic>', inv: c.inv, cls: 'dynamic', paths: [], cwd: c.cwd, repoCwd: c.cwd, sub: [], allow: false, remote: false, execKind: null, pipedFrom: false, hasInner: false };
                else n = normalizeCmdlet(c, ctx.catalog.core, ctx.nativeCtx);
                if (fromInner) n.innerText = true;
                out.push(n);
            }
            if (c.inner?.commands) walk(c.inner, c.cwd ?? curCwd, depth + 1, true);
        }
        for (const d of res.dotnet ?? []) dotnet.push(d);
        for (const dc of res.dotnetCalls ?? []) dcalls.push(dc);
    };
    walk(argv, cwd, 0);
    markContentFeeders(out);
    // .NET static calls with arguments, and name-only pseudo-calls
    const callNames = new Set();
    for (const dc of dcalls) {
        const dn = `${dc.type}::${dc.method}`;
        callNames.add(dn);
        if (/(^|\.)environment$/.test(dc.type)) {
            if (dc.method === 'getenvironmentvariables') envNames.push('*');
            else if (dc.method === 'getenvironmentvariable' && dc.args?.[0]?.isConst) envNames.push(String(dc.args[0].value));
        }
        const intents = dotnetPathIntents(dc.type, dc.method);
        const cwdDc = dc.cwd ?? cwd;
        if (intents.length) {
            const paths = intents.map(({ i, intent }) => {
                const a = (dc.args ?? [])[i];
                if (!a || !a.isConst) return mkPath(null, true, intent, 'target', cwdDc);
                return mkPath(ctx.resolve(a.value, cwdDc), false, intent, 'target', cwdDc);
            });
            const cls = intents.some((x) => x.intent === 'write') ? 'write' : intents.some((x) => x.intent === 'delete') ? 'delete' : 'read';
            out.push(dotnetCommand(dn, cls, paths, cwdDc));
        } else {
            const e = dotnetClass(ctx.catalog.core, dn);
            // read-class calls are classified too, so a statement with only such calls is analysed (not "unanalysed")
            const cls = e.class === 'write-temp' ? 'write' : e.class;
            const paths = e.class === 'write-temp' ? [mkPath(ctx.temp, false, 'write', 'target', cwdDc)]
                : (e.dynamicPath ? [mkPath(null, true, intentOf(cls), 'target', cwdDc)] : []);
            out.push(dotnetCommand(dn, cls, paths, cwdDc));
        }
    }
    for (const dn of new Set(dotnet)) {
        if (/(^|\.)environment::getenvironmentvariables$/.test(dn)) envNames.push('*');
        if (callNames.has(dn)) continue;
        const e = dotnetClass(ctx.catalog.core, dn);
        const cls = e.class === 'write-temp' ? 'write' : e.class;
        const paths = e.dynamicPath ? [mkPath(null, true, intentOf(cls), 'target', null)]
            : (e.class === 'write-temp' ? [mkPath(ctx.temp, false, 'write', 'target', null)] : []);
        out.push(dotnetCommand(dn, cls, paths, null));
    }
    flags.downloadExec = flags.download && (flags.pipeToIex
        || out.some((n) => n.cls === 'dynamic' || (n.cls === 'execute-code' && ['exe', 'script', 'inline'].includes(n.execKind))));
    return {
        syntax: parseErrors.length > 0, parseErrors, commands: out, flags, envNames,
        // comment spans of the top-level script only (an inner script's own list is never copied)
        commentSpans: Array.isArray(argv.commentSpans) ? argv.commentSpans : undefined,
        commentSpansFor: isSpanIdentity(argv.commentSpans, argv.commentSpansFor) ? { length: argv.commentSpansFor.length, sha256: argv.commentSpansFor.sha256 } : undefined,
        statementCount: Number(argv.statementCount) || 0,
    };
}

/** Commands that read file contents of what they receive (or of their own path arguments): the consumers that make a name listing a content read. */
const CONTENT_READERS = new Set(['get-content', 'select-string', 'import-csv', 'import-clixml', 'import-powershelldatafile', 'rg', 'grep', 'findstr', 'jq', 'cat', 'type', 'bat', 'head', 'tail']);
/** Pipeline stages that pass their input on unchanged in kind (the consumer behind them still sees the listing's items); Get-Random, Get-Unique and Write-Output re-emit what they receive.
 * This walk asks "does a recursive listing reach a content reader" and is deliberately broader than the worker's pipeSource classification (worker.ps1 Get-V2PipeSource,
 * TFIX-8: ForEach-Object / -InputObject make the source "paths"): here ForEach-Object stays a pass-through, i.e. the listing still counts as reaching the reader. */
const PIPE_PASS_THROUGH = new Set(['where-object', 'select-object', 'sort-object', 'foreach-object', 'group-object', 'tee-object', 'get-random', 'get-unique', 'write-output']);

/** Recursion that only lists names: Get-ChildItem and fd. Their recursion is a risk only when a content reader consumes the listing. */
const isNameOnlyRecursion = (cmd) => cmd.name === 'get-childitem' || cmd.tool === 'fd';

/** Sets `feedsContent` on every recursive name listing whose pipeline (through pass-through stages) ends in a content reader. */
function markContentFeeders(commands) {
    for (let i = 0; i < commands.length; i++) {
        const n = commands[i];
        if (!n.recursive || !isNameOnlyRecursion(n)) continue;
        for (let j = i + 1; j < commands.length && commands[j].pipedFrom; j++) {
            const next = String(commands[j].name ?? '');
            if (CONTENT_READERS.has(next)) { n.feedsContent = true; break; }
            if (!PIPE_PASS_THROUGH.has(next)) break;
        }
    }
}

/** Directory verdict of every resolvable path (stored as `p.verdict`); dynamic and url/registry/unc values have none. */
function annotatePaths(an, ctx) {
    for (const n of an.commands) {
        for (const p of n.paths) {
            if (p.dynamic || !p.full || PREFIXED.test(p.full)) continue;
            p.verdict = pathVerdict(p.full, p.intent, ctx.policyFor(ctx.repoRootOf(p.cwd)));
        }
    }
}

// ---------- decisions ----------

const inRepo = (cmd, ctx) => !!ctx.repoRootOf(cmd.repoCwd);

/**
 * Package lookup for policy B: the nearest package.json from the cwd up to the git root; dependencies are also
 * looked up in the root package.json (hoisted).
 * @param {'scripts'|'deps'} kind
 */
function pkgCheck(cmd, ctx, kind) {
    const root = ctx.repoRootOf(cmd.repoCwd);
    if (!root) return { ok: false, reason: 'cwd-not-in-repo' };
    if (!cmd.pkgName) return { ok: false, reason: 'name-not-parsed' };
    const hasName = (pj) => {
        if (!pj) return false;
        if (kind === 'scripts') return !!(pj.scripts && Object.hasOwn(pj.scripts, cmd.pkgName));
        return !!((pj.devDependencies && pj.devDependencies[cmd.pkgName]) || (pj.dependencies && pj.dependencies[cmd.pkgName]));
    };
    const near = ctx.nearestPackage(cmd.repoCwd, root);
    if (!near) return { ok: false, reason: 'no-package-json-up-to-git-root' };
    if (hasName(near.pj)) return { ok: true, where: sameDir(near.dir, root) ? 'root' : 'nearest' };
    if (kind === 'deps' && !sameDir(near.dir, root) && hasName(ctx.packageJson(root))) return { ok: true, where: 'root-hoisted' };
    return { ok: false, reason: kind === 'scripts' ? 'script-not-in-nearest-package-json' : 'dep-not-in-nearest-package-json' };
}

/** For inline code (-c, -, -e, -p) and script runs the following positional arguments are data, and the implicit cwd path is not an execute target. */
function dataFilter(cmd) {
    if (cmd.execKind === 'inline' || cmd.execKind === 'script') {
        return cmd.paths.filter((p) => !(p.kind === 'target' && p.intent === 'execute') && p.kind !== 'implicit');
    }
    return cmd.paths;
}

/** Verdict of an execute-code command: [verdict, rule, detail?]. */
function execVerdict(cmd, ctx) {
    if (cmd.remote) return [VERDICT.ASK, 'REMOTE-EXEC'];
    const pathsAll = dataFilter(cmd);
    switch (cmd.execKind) {
        case 'build': {
            if (!inRepo(cmd, ctx)) return [VERDICT.AI, 'B1-BUILD-OUTSIDE-REPO'];
            // a project, solution or script path argument must lie inside the repo too (temp, other folders and unresolved values run foreign build logic)
            const root = trimTail(ctx.repoRootOf(cmd.repoCwd)).toLowerCase();
            const foreign = cmd.paths.some((p) => p.intent === 'execute' && p.kind !== 'implicit'
                && (p.dynamic || !p.full || PREFIXED.test(p.full) || !`${trimTail(P.normalize(p.full)).toLowerCase()}\\`.startsWith(`${root}\\`)));
            return foreign ? [VERDICT.AI, 'B1-BUILD-OUTSIDE-REPO', 'project-outside-repo'] : [VERDICT.SAFE, 'B1-BUILD'];
        }
        case 'pkgscript': {
            const r = pkgCheck(cmd, ctx, 'scripts');
            return r.ok ? [VERDICT.SAFE, 'B1-PKGSCRIPT', r.where] : [VERDICT.AI, 'B1-PKGSCRIPT-MISSING', r.reason];
        }
        case 'devtool': case 'devtool-any': {
            const r = pkgCheck(cmd, ctx, 'deps');
            return r.ok ? [VERDICT.SAFE, 'B1-DEVTOOL', r.where] : [VERDICT.AI, 'B1-DEVTOOL-MISSING', r.reason];
        }
        case 'script': {
            if (pathsAll.some((p) => p.dynamic)) return [VERDICT.AI, 'B2-SCRIPT-DYNAMIC'];
            const sp = pathsAll.filter((p) => p.kind === 'script');
            if (sp.length === 0) return [VERDICT.AI, 'B2-SCRIPT-NONE'];
            // session scripts (directory rule with the script-freshness gate): the directory verdict already holds the freshness decision
            if (sp.every((p) => String(p.verdict?.ruleIds[0] ?? '').startsWith('B4-'))) {
                const statuses = sp.map((p) => ctx.scriptStatus(p.full));
                return sp.every((p) => p.verdict.verdict === VERDICT.SAFE)
                    ? [VERDICT.SAFE, 'B4-COPILOT-SCRIPT', 'pre-existing']
                    : [VERDICT.AI, 'B4-COPILOT-SCRIPT-NOT-PREEXISTING', statuses.join(',')];
            }
            let worst = [VERDICT.SAFE, 'B2-SCRIPT-PREEXISTING'];
            for (const p of sp) {
                const st = PREFIXED.test(p.full) ? 'missing' : ctx.scriptStatus(p.full);
                if (st !== 'pre-existing') worst = [VERDICT.AI, `B2-SCRIPT-${String(st).toUpperCase()}`];
            }
            return worst;
        }
        case 'inline':
            return [VERDICT.AI, 'B3-INLINE'];
        default:
            return [VERDICT.AI, 'EXEC-OTHER'];
    }
}

/** True when a read of the PowerShell `Env:` drive lists the whole drive, uses a wildcard or names a credential-like variable (Test-Path only checks existence). */
function readsCredentialEnv(full, cmd) {
    const m = /^provider:env:[\\/]*(.*)$/i.exec(full);
    if (!m || cmd.name === 'test-path') return false;
    const name = m[1];
    return name === '' || /[*?[]/.test(name) || isCredentialEnvName(name);
}

/** Rule entries of one command: { verdict, rule, detail?, reason? }. */
function decideCommand(cmd, ctx) {
    const out = [];
    const add = (verdict, rule, detail, reason) => out.push({ verdict, rule, detail, reason });
    const access = ctx.accessOf(cmd.tool);
    // session statements (use role/warehouse, alter session) change no data: read-equivalent for a read-only tool (D-30)
    if (access === 'read-only' && !['read', 'read-remote', 'session'].includes(cmd.cls)) add(VERDICT.ASK, 'AGENT-ACCESS', cmd.tool, 'read-only CLI tool used for more than reading');
    const isScriptExec = cmd.cls === 'execute-code' && cmd.execKind === 'script';
    if (cmd.envDump) add(VERDICT.ASK, 'CREDENTIAL-ENV', undefined, 'cmd set lists the environment variables');
    for (const p of dataFilter(cmd)) {
        if (p.dynamic) {
            add(VERDICT.AI, `DYN-PATH-${p.intent.toUpperCase()}`);
            continue;
        }
        if (p.full.startsWith('url:')) continue;
        if (p.full.startsWith('registry:')) {
            if (p.intent === 'read') add(VERDICT.AI, 'REGISTRY-READ');
            else add(VERDICT.ASK, 'REGISTRY-WRITE');
            continue;
        }
        if (p.full.startsWith('unc:')) { add(VERDICT.AI, 'UNC-PATH'); continue; }
        if (p.full.startsWith('provider:')) { // Alias:, Function:, Env: ... — a write can shadow commands or change the environment
            if (p.intent !== 'read') add(VERDICT.AI, 'PROVIDER-WRITE', undefined, 'write to a PowerShell provider drive');
            else if (readsCredentialEnv(p.full, cmd)) add(VERDICT.ASK, 'CREDENTIAL-ENV', undefined, 'reads the environment drive or a credential-like environment variable');
            continue;
        }
        const v = p.verdict;
        // policy B / D-23: the script file itself is judged by freshness (execVerdict). Of its directory verdict only an ASK
        // (protected, secret) counts, plus the never-safe directories (temp, session files); DIR-OUTSIDE and DIR-NOT-ALLOWED are ignored.
        // The session-scripts rule (B4-*) carries its own freshness decision.
        if (isScriptExec && p.kind === 'script') {
            if (String(v.ruleIds[0]).startsWith('B4-')) continue;
            if (v.verdict === VERDICT.ASK) add(v.verdict, v.ruleIds[0], v.directoryId, v.reason);
            else if (ctx.scriptNeverSafeDirs.has(v.directoryId)) add(VERDICT.AI, `B2-SCRIPT-IN-${v.directoryId.toUpperCase()}`, v.directoryId, 'scripts in this location are never run unattended');
            continue;
        }
        add(v.verdict, v.ruleIds[0], v.directoryId, v.reason);
    }
    // recursive reads (TFIX-4): AI only when the recursion can reach secret content, i.e. the root is equal to, inside or an ancestor of a
    // secret rule's concrete base, or a content reader bypasses ignore/hidden handling (rg -uu/--hidden, grep -r, findstr /s,
    // Select-String -Recurse, Get-ChildItem -Force feeding a content reader). rg/fd default (ignore-aware) is SAFE; name-only listings
    // (Get-ChildItem without a content reader downstream, fd) are SAFE even with -Force/hidden: names of secret files are low risk.
    if (cmd.recursive && (cmd.feedsContent || !isNameOnlyRecursion(cmd))) {
        for (const p of cmd.paths) {
            if (p.intent !== 'read' || p.dynamic || !p.full || PREFIXED.test(p.full) || !(p.kind === 'target' || p.kind === 'implicit')) continue;
            if (!ctx.isDirectory(p.full)) continue; // one file is no recursion
            if (cmd.recursive === 'bypass' || reachesSecretBase(p.full, ctx.policyFor(ctx.repoRootOf(p.cwd)))) {
                add(VERDICT.AI, 'READ-RECURSIVE', cmd.tool ?? cmd.name, 'recursive read that can reach secret content or bypasses ignore rules');
                break;
            }
        }
    }
    let c;
    switch (cmd.cls) {
        case 'read': c = [VERDICT.SAFE, 'READ']; break;
        case 'read-remote': c = officialReadEligible(cmd) ? [VERDICT.SAFE, 'D-OFFICIAL-READ'] : [VERDICT.AI, 'READ-REMOTE']; break;
        case 'write':
        case 'delete':
            if (cmd.remote) c = [VERDICT.ASK, `REMOTE-${cmd.cls.toUpperCase()}`];
            else if (cmd.execKind === 'build' && inRepo(cmd, ctx)) c = [VERDICT.SAFE, `B1-BUILD-${cmd.cls.toUpperCase()}`];
            else if (cmd.paths.length === 0) c = [VERDICT.AI, 'NO-TARGET'];
            else c = [VERDICT.SAFE, `LOCAL-${cmd.cls.toUpperCase()}`];
            break;
        case 'install':
            c = cmd.execKind === 'build' && inRepo(cmd, ctx) ? [VERDICT.SAFE, 'B1-BUILD-INSTALL'] : [VERDICT.AI, 'INSTALL'];
            break;
        case 'execute-code': c = execVerdict(cmd, ctx); break;
        case 'download': c = [VERDICT.AI, 'DOWNLOAD']; break;
        case 'auth': c = [VERDICT.AI, 'AUTH']; break;
        case 'credential': c = [VERDICT.ASK, 'CREDENTIAL']; break;
        case 'publish': case 'remote-write': case 'remote-destructive': case 'admin': case 'persistence': case 'privilege': case 'system':
            c = [VERDICT.ASK, `CLASS-${cmd.cls.toUpperCase()}`]; break;
        case 'history-rewrite':
            c = ctx.inOwnedWorktree(cmd.cwd) ? [VERDICT.AI, 'HIST-OWNED-WORKTREE'] : [VERDICT.ASK, 'HISTORY-REWRITE'];
            break;
        case 'spawn-agent': c = cmd.allow ? [VERDICT.ASK, 'SPAWN-ALLOW'] : [VERDICT.AI, 'SPAWN']; break;
        case 'dynamic': c = [VERDICT.ASK, 'DYNAMIC-CODE']; break;
        case 'cost': case 'scratch': c = [VERDICT.AI, `CLASS-${cmd.cls.toUpperCase()}`]; break;
        case 'unknown': c = officialReadEligible(cmd) ? [VERDICT.SAFE, 'D-OFFICIAL-READ'] : [VERDICT.AI, 'CLASS-UNKNOWN']; break;
        case 'session': c = [VERDICT.SAFE, 'SQL-SESSION']; break;
        default: c = [VERDICT.AI, 'UNKNOWN-CLASS'];
    }
    add(c[0], c[1], c[2]);
    return out;
}

/** Script paths that are also write/delete targets of the same analysis: their freshness cannot be trusted (backdated mtime, rewritten content). */
function sameCallScriptRules(an) {
    const written = [];
    for (const n of an.commands) {
        for (const p of n.paths) {
            if ((p.intent === 'write' || p.intent === 'delete') && p.kind !== 'implicit' && !p.dynamic && p.full && !PREFIXED.test(p.full)) {
                written.push(trimTail(P.normalize(p.full)).toLowerCase());
            }
        }
    }
    if (written.length === 0) return [];
    const rules = [];
    for (const n of an.commands) {
        if (n.cls !== 'execute-code' || n.execKind !== 'script') continue;
        for (const p of n.paths) {
            if (p.kind !== 'script' || p.dynamic || !p.full || PREFIXED.test(p.full)) continue;
            const lf = trimTail(P.normalize(p.full)).toLowerCase();
            if (written.some((w) => lf === w || lf.startsWith(`${w}\\`))) {
                rules.push({ verdict: VERDICT.AI, rule: 'B2-SCRIPT-FRESH-SAME-CALL', reason: 'the script is written and run in the same call' });
            }
        }
    }
    return rules;
}

/** Entries of one analysis: every command's rules plus the script-level flags (download-exec, nested dynamic code). */
function decide(an, ctx) {
    const rules = [];
    for (const cmd of an.commands) rules.push(...decideCommand(cmd, ctx));
    rules.push(...sameCallScriptRules(an));
    if (an.envNames.some(isCredentialEnvName)) rules.push({ verdict: VERDICT.ASK, rule: 'CREDENTIAL-ENV', reason: 'a credential-like environment variable is read' });
    if (an.flags.downloadExec) rules.push({ verdict: VERDICT.ASK, rule: 'DOWNLOAD-EXEC', reason: 'downloaded content is executed' });
    if (an.flags.nestedDynamic) rules.push({ verdict: VERDICT.ASK, rule: 'NESTED-DYNAMIC', reason: 'nested or undecodable dynamic code' });
    if (an.flags.dynamicInvoke) rules.push({ verdict: VERDICT.AI, rule: 'DYNAMIC-INVOKE', reason: 'script text or a script block is invoked dynamically' });
    if (rules.length === 0) {
        // statements without any analysable command (assignments, dynamic member calls) are not a safe empty script
        if (an.statementCount > 0) {
            const entry = { verdict: VERDICT.AI, rule: 'UNANALYZED', reason: 'the script has statements but no analysable command' };
            return { verdict: VERDICT.AI, primary: entry, rules: [entry] };
        }
        return { verdict: VERDICT.SAFE, primary: { verdict: VERDICT.SAFE, rule: 'NO-COMMANDS' }, rules: [] };
    }
    let worst = VERDICT.SAFE;
    for (const r of rules) if (VERDICT_SEVERITY[r.verdict] > VERDICT_SEVERITY[worst]) worst = r.verdict;
    const primary = rules.find((r) => r.verdict === worst && r.rule !== 'DIR-OK') ?? rules.find((r) => r.verdict === worst) ?? rules[0];
    const seen = new Set();
    const unique = rules.filter((r) => {
        const key = `${r.verdict}|${r.rule}|${r.detail ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return { verdict: worst, primary, rules: unique };
}

// ---------- facts ----------

/**
 * Shape of a script without literal values: tool/op, class, exec kind and the directory rule of each path. Commands that
 * come from inner script text (`cmd /c`, `pwsh -c`, `-EncodedCommand`, `iex`) are labelled `<inner>`: the text is never
 * shown, not even its first token.
 */
function signatureOf(an) {
    return an.commands.map((c) => {
        const label = c.innerText ? (c.cmdText ? 'cmd:<inner>' : '<inner>')
            : (c.tool ? c.tool + (c.sub?.length ? `/${c.sub.join('.')}` : '') : (c.inv === 'dynamic' ? '<dynamic>' : c.name ?? '<unknown>'));
        const lv = c.paths.map((p) => {
            if (p.dynamic) return 'dyn';
            if (p.verdict) return p.verdict.directoryId ?? p.verdict.ruleIds[0];
            return String(p.full).split(':')[0];
        });
        return `${label}[${c.cls}${c.execKind ? `:${c.execKind}` : ''}]{${lv.join(',')}}`;
    }).join(' > ');
}

/** Deterministic facts of an analysis (see contracts Facts; adds signature and parseErrors). */
function factsOf(an) {
    const classes = [...new Set(an.commands.map((c) => c.cls))].sort((a, b) => rankOf(a) - rankOf(b));
    const intents = new Set(classes.map(intentOf));
    const paths = new Set();
    const notes = [];
    for (const c of an.commands) {
        for (const p of c.paths) {
            intents.add(p.intent);
            if (p.dynamic) notes.push(`dynamic-path:${p.intent}`);
            else if (p.full.startsWith('unc:')) paths.add(p.full.slice(4)); // network paths are shown to the judge
            else if (!PREFIXED.test(p.full)) paths.add(p.full);
        }
        if (c.sqlInfo?.kind === 'unresolved') notes.push('sql-unresolved');
        if (c.inv === 'dynamic') notes.push('dynamic-command');
    }
    if (an.flags.nestedDynamic) notes.push('nested-dynamic');
    if (an.flags.downloadExec) notes.push('download-exec');
    for (const e of an.parseErrors) notes.push(`syntax:${e.line ?? '?'}:${e.column ?? '?'}`);
    return {
        classes, intents: [...intents], paths: [...paths], notes: [...new Set(notes)], signature: signatureOf(an), parseErrors: an.parseErrors,
        ...(an.commentSpans ? { commentSpans: an.commentSpans } : {}),
        ...(an.commentSpans && an.commentSpansFor ? { commentSpansFor: an.commentSpansFor } : {}),
    };
}

// ---------- engine ----------

/**
 * @typedef {object} EngineResult
 * @property {'SAFE'|'AI'|'ASK'|'SYNTAX'} verdict
 * @property {string} primaryRule rule id that decided the verdict
 * @property {Array<{ verdict: string, rule: string, detail?: string, reason?: string }>} rules all rule entries (deduplicated)
 * @property {string} reason short human-readable reason (no paths, no script text); for SYNTAX every parser message with line and column
 * @property {ReturnType<typeof factsOf>} facts
 */

/**
 * Creates the engine.
 * @param {object} options
 * @param {{ get: () => object, agentPolicy: (agent: string) => { directories: object[], cliTools: Record<string, string> } }} options.config
 *   config store; `get().governor` supplies codeRoots and the optional `engine` section (ownedWorktreeFolder, sqlFileRoots,
 *   scriptNeverSafeDirectories); `get().groups` the catalog groups
 * @param {object | (() => object)} [options.catalog] catalog from loadCatalog/buildCatalog (default: built from the store's `catalog:*` groups)
 * @param {{ argv: (script: string, cwd: string | null, features?: object | null) => Promise<object> }} [options.worker] facts provider (a PwshClient); needed by evaluate()
 * @param {{ scriptStatus: (fullPath: string) => string }} [options.session] session context (script freshness); default: every script is "missing"
 * @param {string | null | (() => string | null)} [options.sessionId] session id for `{sessionId}` directory rules
 * @param {string} [options.home] user home for "~" paths (default os.homedir())
 * @param {string} [options.copilotHome] Copilot home for the `{copilotHome}` placeholder of `engine.sqlFileRoots` (default `<home>\.copilot`)
 * @param {string} [options.temp] temp folder for .NET temp writes (default $TEMP)
 * @param {(path: string) => boolean} [options.exists] existence check (repo markers; default fs.existsSync)
 * @param {(path: string) => boolean} [options.isDirectory] whether a path is a folder (recursion check; default fs.statSync, true when the path cannot be stat'ed)
 * @param {(dir: string) => string[] | null} [options.listDir] folder listing for the expansion of wildcard paths (default fs.readdirSync; null = no such folder)
 * @param {(path: string) => { mtimeMs: number, size: number } | null} [options.statFile] stat for package.json caching
 * @param {(path: string) => string} [options.readFile] reads package.json (default utf8 readFileSync)
 * @param {number} [options.settingsTtlMs] how long a config snapshot is reused (default 1000; 0 = re-check config files on every call)
 * @param {() => number} [options.now] epoch-ms clock for the snapshot age (default Date.now)
 */
export function createEngine({
    config, catalog, worker, session, sessionId = null, home = homedir(),
    copilotHome = join(home, '.copilot'),
    temp = process.env.TEMP || process.env.TMP || tmpdir(),
    exists = existsSync,
    isDirectory = defaultIsDirectory,
    listDir,
    statFile = defaultStatFile,
    readFile = (p) => readFileSync(p, 'utf8'),
    settingsTtlMs = DEFAULT_SETTINGS_TTL_MS,
    now = () => Date.now(),
} = {}) {
    if (!config || typeof config.get !== 'function' || typeof config.agentPolicy !== 'function') {
        throw new TypeError('createEngine: config (config store) is required');
    }
    const scriptStatusOf = session?.scriptStatus ? (p) => session.scriptStatus(p) : () => 'missing';
    /** Code roots of a settings snapshot (empty when none is configured). */
    const codeRootsOf = (settings) => (Array.isArray(settings.governor?.codeRoots) ? settings.governor.codeRoots : []);

    // catalog built from store groups is reused while no group value changed
    let lastGroupValues = null;
    let lastCatalog = null;
    function catalogOf(settings) {
        if (typeof catalog === 'function') return catalog();
        if (catalog) return catalog;
        const values = Object.entries(settings.groups).filter(([n]) => n.startsWith('catalog:')).map(([, v]) => v);
        if (lastCatalog && lastGroupValues.length === values.length && lastGroupValues.every((v, i) => v === values[i])) return lastCatalog;
        try {
            lastCatalog = catalogFromGroups(settings.groups);
        } catch (err) {
            throw new EngineError('CATALOG_UNAVAILABLE', `tool catalog unavailable: ${err.message}`);
        }
        lastGroupValues = values;
        return lastCatalog;
    }

    /** package.json cache keyed by path; a changed mtime/size reloads the file. */
    const packageCache = new Map();
    function readPackage(dir) {
        const file = join(dir, 'package.json');
        const st = statFile(file);
        if (!st) { packageCache.delete(file); return null; }
        const sig = `${st.mtimeMs}:${st.size}`;
        const hit = packageCache.get(file);
        if (hit && hit.sig === sig) return hit.pj;
        let pj = null;
        try { pj = JSON.parse(readFile(file).replace(/^\uFEFF/, '')); } catch { pj = null; }
        if (packageCache.size >= MAX_PACKAGE_CACHE) packageCache.clear();
        packageCache.set(file, { sig, pj });
        return pj;
    }

    /**
     * Config snapshot reused for settingsTtlMs: every config read stats all config files, which dominates the cost of a
     * call on a busy machine. A change of a config file takes effect within settingsTtlMs (0 = checked on every call).
     * Holds the store settings plus, per agent, its effective policy, the CLI tool Access map and compiled directory policies.
     */
    let snapshot = null;
    function snapshotOf() {
        const at = now();
        if (!snapshot || at - snapshot.at >= settingsTtlMs || at < snapshot.at) snapshot = { at, settings: config.get(), agents: new Map() };
        return snapshot;
    }
    function agentSnapshot(snap, agent) {
        let a = snap.agents.get(agent);
        if (!a) {
            const policy = config.agentPolicy(agent);
            a = { policy, access: new Map(Object.entries(policy.cliTools).map(([k, v]) => [k.toLowerCase(), v])), compiled: new Map() };
            snap.agents.set(agent, a);
        }
        return a;
    }

    /** Compiled directory policy of an agent snapshot for a session and repo root; compiled once per snapshot and key. */
    function compiledPolicyOf(agentSnap, sid, repoRoot) {
        const key = `${sid ?? ''}|${repoRoot ?? ''}`;
        let policy = agentSnap.compiled.get(key);
        if (!policy) {
            policy = compileDirectoryPolicy(agentSnap.policy.directories, { sessionId: sid ?? undefined, repoRoot, scriptStatus: scriptStatusOf, listDir });
            agentSnap.compiled.set(key, policy);
        }
        return policy;
    }

    /** Evaluation context: everything one evaluation reads, with per-evaluation caches (no state shared between calls). */
    function makeContext(agent) {
        const snap = snapshotOf();
        const settings = snap.settings;
        const governor = settings.governor ?? {};
        const codeRoots = codeRootsOf(settings);
        const worktreeFolder = String(governor.engine?.ownedWorktreeFolder ?? DEFAULT_OWNED_WORKTREE_FOLDER);
        const placeholders = { home, copilotHome, temp };
        const sqlFileRoots = (Array.isArray(governor.engine?.sqlFileRoots) ? governor.engine.sqlFileRoots : DEFAULT_SQL_FILE_ROOTS)
            .filter((r) => typeof r === 'string' && r.trim() !== '')
            .map((r) => r.replace(/\{(home|copilotHome|temp)\}/g, (_, k) => placeholders[k]));
        const neverSafeDirs = new Set((Array.isArray(governor.engine?.scriptNeverSafeDirectories)
            ? governor.engine.scriptNeverSafeDirectories : DEFAULT_SCRIPT_NEVER_SAFE_DIRECTORIES).map(String));
        const agentSnap = agentSnapshot(snap, agent);
        requireDirectoryRules(agentSnap.policy);
        const sid = typeof sessionId === 'function' ? sessionId() : sessionId;
        const roots = new Map();
        const ctx = {
            catalog: catalogOf(settings),
            temp,
            sqlFileRoots,
            scriptNeverSafeDirs: neverSafeDirs,
            resolve: (value, cwd) => resolveFull(value, cwd, { home }),
            isDirectory,
            scriptStatus: scriptStatusOf,
            repoRootOf(cwd) {
                if (!cwd) return null;
                if (!roots.has(cwd)) roots.set(cwd, repoRootOf(cwd, { codeRoots, exists }));
                return roots.get(cwd);
            },
            policyFor: (repoRoot) => compiledPolicyOf(agentSnap, sid, repoRoot),
            accessOf: (tool) => (tool ? agentSnap.access.get(String(tool).toLowerCase()) : undefined),
            inOwnedWorktree: (cwd) => (worktreeFolder !== '' && `${cwd ?? ''}\\`.toLowerCase().includes(`\\${worktreeFolder.toLowerCase()}\\`)),
            packageJson: (dir) => readPackage(dir),
            nearestPackage(startDir, root) {
                let d = P.normalize(startDir);
                const stop = trimTail(P.normalize(root));
                for (let k = 0; k < 64; k++) {
                    const pj = readPackage(d);
                    if (pj) return { dir: d, pj };
                    if (sameDir(trimTail(d), stop)) break;
                    const up = P.dirname(d);
                    if (up === d) break;
                    d = up;
                }
                return null;
            },
        };
        ctx.nativeCtx = { gitRootOf: (dir) => ctx.repoRootOf(dir), resolve: ctx.resolve, sqlFileRoots: ctx.sqlFileRoots };
        return ctx;
    }

    /**
     * Decides one script from worker argv facts (no worker needed).
     * @param {object} argvFacts response of the worker op "argv"
     * @param {{ cwd?: string | null, agent?: string }} [call]
     * @returns {EngineResult}
     */
    function evaluateFacts(argvFacts, { cwd = null, agent = 'main' } = {}) {
        const parseErrors = argvFacts.parseErrors ?? [];
        if (parseErrors.length > 0) {
            const facts = { classes: [], intents: [], paths: [], notes: parseErrors.map((e) => `syntax:${e.line ?? '?'}:${e.column ?? '?'}`), signature: '', parseErrors: [...parseErrors] };
            return {
                verdict: VERDICT.SYNTAX, primaryRule: 'SYNTAX', rules: [{ verdict: VERDICT.SYNTAX, rule: 'SYNTAX' }],
                reason: syntaxReason(parseErrors), facts,
            };
        }
        const ctx = makeContext(String(agent || 'main'));
        const an = analyze(argvFacts, cwd, ctx);
        if (an.syntax) { // a parse error inside a nested script
            return {
                verdict: VERDICT.SYNTAX, primaryRule: 'SYNTAX', rules: [{ verdict: VERDICT.SYNTAX, rule: 'SYNTAX' }],
                reason: syntaxReason(an.parseErrors), facts: factsOf(an),
            };
        }
        annotatePaths(an, ctx);
        const d = decide(an, ctx);
        const reason = d.primary.reason ? `${d.primary.rule}: ${d.primary.reason}` : d.primary.rule;
        return { verdict: d.verdict, primaryRule: d.primary.rule, rules: d.rules, reason, facts: factsOf(an) };
    }

    /**
     * Decides one script: asks the worker for argv facts, then evaluates them. Rejects with the worker's error
     * (PwshClientError) when the worker fails; the governor maps that to ASK.
     * @param {{ script: string, cwd?: string | null, agent?: string }} call
     * @returns {Promise<EngineResult>}
     */
    async function evaluate({ script, cwd = null, agent = 'main' }) {
        if (!worker || typeof worker.argv !== 'function') throw new EngineError('WORKER_REQUIRED', 'evaluate() needs a worker with argv()');
        const facts = await worker.argv(script, cwd);
        return evaluateFacts(facts, { cwd, agent });
    }

    /**
     * Compiled directory policy of one agent for a call in `cwd`, cached per config snapshot, session id and repo root (the cache
     * `evaluate` uses). Shared by the governor's file and read tools and by the replay, so a call does not rebuild the policy.
     * @param {{ agent?: string, cwd?: string | null }} [call]
     * @returns {DirectoryPolicy}
     * @throws {EngineError} DIRECTORIES_UNAVAILABLE
     */
    function directoryPolicyFor({ agent = 'main', cwd = null } = {}) {
        const snap = snapshotOf();
        const agentSnap = agentSnapshot(snap, String(agent || 'main'));
        requireDirectoryRules(agentSnap.policy);
        const sid = typeof sessionId === 'function' ? sessionId() : sessionId;
        return compiledPolicyOf(agentSnap, sid, repoRootOf(cwd, { codeRoots: codeRootsOf(snap.settings), exists }));
    }

    return Object.freeze({ evaluate, evaluateFacts, directoryPolicyFor, flagTable: () => flagTableOf(catalogOf(snapshotOf().settings)) });
}

/** True for a folder; a path that cannot be stat'ed (missing, wildcard) counts as a folder so that a recursion is never overlooked. */
function defaultIsDirectory(path) {
    try {
        return statSync(path).isDirectory();
    } catch {
        return true;
    }
}

/** @param {string} path @returns {{ mtimeMs: number, size: number } | null} */
function defaultStatFile(path) {
    try {
        const st = statSync(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return null;
    }
}
