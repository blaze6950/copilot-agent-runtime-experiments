// Replay tool for the user's PowerShell history (AC-17). Standalone CLI, not loaded by the Copilot CLI:
//   node extensions/shell-governor/tools/replay.mjs [--summary] [--exclude-cwd <path>]... [--copilot-home <dir>]
//     [--session <folder prefix>]... [--since <ISO date>] [--until <ISO date>] [--out <dir>] [--judge]
// --session keeps only sessions whose folder name starts with the prefix (case-insensitive; repeatable).
// --since (inclusive) and --until (exclusive) keep only sessions whose session.start time lies in the window; --out
// replaces the output folder (default .local/replay).
// --judge re-runs the AI judge for AI-verdict calls with the live inputs and counts ALLOW, ASK, their triggers and the ALLOWs
// that a stage-2 relaxation made (task_mismatch alone, credential_access alone for a read-only script); it costs
// model calls (about $0.3 per large session, D-38) and is off by default.
// view, grep and glob calls are replayed through lib/read-tools.mjs (the live hook's directory rules, no AI judge);
// the summary and results.json count them per tool, verdict and rule id, and count grep/glob searches whose root reaches a secret rule base.
// Reads {copilotHome}\session-state\*\events.jsonl read-only, replays every PowerShell call through the real engine
// (pwsh worker + catalog + directory rules) with a session context per session (freshness and agent names as at
// runtime), and writes only to the git-ignored .local/replay folder: results.json (aggregates, parity vs S6) and
// ask-review.md (ASK groups by primary rule, masked examples). Corpus definition and masking come from the governor
// spike (s6-run.mjs, mask.mjs). Prints only the summary (or the output paths); command texts never leave the masked review.
// Signatures (shapes) are sanitized before use: tokens that are not shape words become <redacted>; the privacy check
// runs after sanitizing and fails the run if anything remains. The engine already labels inner script text (cmd /c,
// pwsh -c, -EncodedCommand, iex) as <inner> (lib/engine.mjs signatureOf); this redaction stays as defence in depth.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerCatalogGroups } from '../lib/catalog.mjs';
import { createConfigStore, resolvePlaceholders } from '../lib/config.mjs';
import { createEngine } from '../lib/engine.mjs';
import { createJudge } from '../lib/judge.mjs';
import { judgeRequestOf } from '../lib/judge-prompt.mjs';
import { registerDirectoryPolicy, repoRootOf } from '../lib/paths.mjs';
import { callEvidenceOf, combine, stage3Assessment } from '../lib/policy.mjs';
import { PwshClient, PwshClientError } from '../lib/pwsh-client.mjs';
import { READ_TOOLS, evaluateReadTool } from '../lib/read-tools.mjs';
import { createSessionContext } from '../lib/session-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(HERE, '..');

/** Verdict shares of governor-spike S6 (DECIDED-3) on the same corpus definition, in percent. */
export const S6_REFERENCE_SHARES = Object.freeze({ SAFE: 73.8, AI: 20.1, ASK: 5.4, SYNTAX: 0.7 });
/** Allowed deviation per verdict share, in percentage points. */
export const PARITY_TOLERANCE_POINTS = 1.0;
/** Git-ignored output folder: extensions/shell-governor/.local/replay. */
export const DEFAULT_OUT_DIR = join(EXTENSION_ROOT, '.local', 'replay');

const VERDICTS = ['SAFE', 'AI', 'ASK', 'SYNTAX'];
const PS_TOOL = 'powershell';
const WORKER_RULE = 'WORKER-ERROR';
const ENGINE_RULE = 'ENGINE-ERROR';
const READ_ERROR_RULE = 'GOVERNOR-ERROR';
const READ_TOOL_ORDER = ['view', 'grep', 'glob'];
const SUMMARY_RULES = 8;
const REVIEW_EXAMPLES = 3;
const REVIEW_CHARS = 600;
const SIGNATURES_PER_GROUP = 3;
const SCAN_HEAD_LINES = 20;

// ---------- masking (port of governor-spike corpus/mask.mjs) ----------

const MASK_PATTERNS = [
    [/gh[pousr]_[A-Za-z0-9]{20,}/g, '***'],
    [/github_pat_[A-Za-z0-9_]{20,}/g, '***'],
    [/sk-[A-Za-z0-9_-]{16,}/g, '***'],
    [/AKIA[0-9A-Z]{16}/g, '***'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '******'],
    [/(-(?:password|passwd|pwd|token|secret|apikey|api-key|accesskey|access-key|clientsecret)\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1***'],
    [/((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|authorization|sas)\w*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&"']+)/gi, '$1***'],
    [/((?:Password|Pwd|AccountKey|SharedAccessSignature|SharedAccessKey|Secret)\s*=\s*)[^;"'\s]+/gi, '$1***'],
    [/[A-Za-z0-9+/]{41,}={0,2}/g, '***'],
];

/** Patterns that must not remain unmasked in any output file (names are reported, values never). */
const SCAN_PATTERNS = [
    ['ghp/gho/ghu/ghs/ghr token', /gh[pousr]_[A-Za-z0-9]{20,}/],
    ['github_pat', /github_pat_[A-Za-z0-9_]{20,}/],
    ['sk- key', /sk-[A-Za-z0-9_-]{16,}/],
    ['AKIA key id', /AKIA[0-9A-Z]{16}/],
    ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
    ['password/secret assignment', /(password|passwd|pwd|secret|token|apikey|api[_-]?key|accountkey|sharedaccess\w*)\s*[=:]\s*(?!\*\*\*)[^\s;,&"']{3,}/i],
    ['base64-like run >40', /[A-Za-z0-9+/]{41,}={0,2}/],
];

/**
 * Masks token-like values, password/key/secret values and long base64-like runs.
 * @param {unknown} text
 * @returns {string}
 */
export function maskText(text) {
    let t = String(text ?? '');
    for (const [re, rep] of MASK_PATTERNS) t = t.replace(re, rep);
    return t;
}

/**
 * Masked text for the review: masking first, then the length cap.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function maskForReview(text, max = REVIEW_CHARS) {
    const masked = maskText(text);
    return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/**
 * Names of the scan patterns that still match the text (outputs must already be masked).
 * @param {unknown} text
 * @returns {string[]}
 */
export function scanText(text) {
    const s = String(text ?? '');
    return SCAN_PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}

/**
 * Fails when any output file still holds an unmasked pattern. The error names files and patterns, never the values.
 * @param {Record<string, string>} files file name → text
 */
export function assertClean(files) {
    const hits = [];
    for (const [name, text] of Object.entries(files)) {
        const found = scanText(text);
        if (found.length) hits.push(`${name}: ${found.join(', ')}`);
    }
    if (hits.length) throw new Error(`replay output contains unmasked patterns (${hits.join('; ')}); nothing was written`);
}

// ---------- signature privacy (adapted from the T2 worker checks) ----------

const SEGMENT = /^([^[\]{}\s]+)\[([^[\]{}]*)\]\{([^{}]*)\}$/;

/**
 * Privacy check of engine signatures (shapes, no literal values). Codes: `shape` (not the shape grammar), `literal`
 * (a value-like token in a label, class or path slot), `flag` (a packed flag value or flag name became a token).
 * @param {unknown} signature
 * @returns {string[]} distinct violation codes; empty when clean
 */
export function checkSignaturePrivacy(signature) {
    if (typeof signature !== 'string') return ['shape'];
    if (signature === '') return [];
    const found = new Set();
    for (const seg of signature.split(' > ')) {
        const m = SEGMENT.exec(seg);
        if (!m) {
            found.add('shape');
            continue;
        }
        const [, label, cls, paths] = m;
        if (/(^|[/.])-/.test(label) || /(^|,)-/.test(paths)) found.add('flag');
        if (!/^[A-Za-z0-9_.:<>/-]+$/.test(label) || !/^[a-z-]+(:[a-z-]+)?$/.test(cls)) found.add('literal');
        if (paths !== '' && !paths.split(',').every((p) => /^[A-Za-z0-9_.-]*$/.test(p))) found.add('literal');
    }
    return [...found];
}

const HEAD_NAME = /^(<dynamic>|<unknown>|[A-Za-z][A-Za-z0-9_.-]*)$/;
/** Engine placeholder for the text of an inner script (cmd /c, pwsh -c, -EncodedCommand, iex); it has no tokens. */
const INNER_LABEL = '<inner>';
const CMD_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SUB_NAME = /^[A-Za-z][A-Za-z0-9_:-]*$/;
const CLASS_NAME = /^[a-z-]+(:[a-z-]+)?$/;
const PATH_ENTRY = /^[A-Za-z0-9_.-]*$/;

/** Head (tool or command name) of a label; `cmd:` names come from the first token of cmd text. `<inner>` is the engine's placeholder for inner script text. */
function sanitizeHead(head) {
    if (head === INNER_LABEL || head === `cmd:${INNER_LABEL}`) return { text: head, redacted: 0 };
    if (head.startsWith('cmd:')) return CMD_NAME.test(head.slice(4)) ? { text: head, redacted: 0 } : { text: 'cmd:<redacted>', redacted: 1 };
    return HEAD_NAME.test(head) ? { text: head, redacted: 0 } : { text: '<redacted>', redacted: 1 };
}

function sanitizeSegment(seg) {
    const m = SEGMENT.exec(seg);
    if (!m) return { text: '<redacted>[unknown]{}', redacted: 1 };
    const [, label, cls, paths] = m;
    let redacted = 0;
    const slash = label.indexOf('/');
    const head = sanitizeHead(slash < 0 ? label : label.slice(0, slash));
    redacted += head.redacted;
    let tail = '';
    if (slash >= 0) {
        tail = label.slice(slash + 1).split('.').map((t) => {
            if (SUB_NAME.test(t)) return t;
            redacted++;
            return '<redacted>';
        }).join('.');
    }
    const cleanCls = CLASS_NAME.test(cls) ? cls : 'unknown';
    if (cleanCls !== cls) redacted++;
    const cleanPaths = paths === '' ? '' : paths.split(',').map((p) => {
        if (PATH_ENTRY.test(p) && !p.startsWith('-')) return p;
        redacted++;
        return 'dyn';
    }).join(',');
    const text = `${head.text}${slash >= 0 ? `/${tail}` : ''}[${cleanCls}]{${cleanPaths}}`;
    return { text, redacted };
}

/**
 * Replaces every signature token that is not a shape word with `<redacted>` (defence in depth: the engine labels inner script
 * text as `<inner>`, but a literal path in a label would still be redacted here). Returns the sanitized signature and the number of redacted tokens.
 * @param {string} signature
 * @returns {{ signature: string, redacted: number }}
 */
export function sanitizeSignature(signature) {
    if (typeof signature !== 'string' || signature === '') return { signature: '', redacted: 0 };
    let redacted = 0;
    const parts = signature.split(' > ').map((seg) => {
        const s = sanitizeSegment(seg);
        redacted += s.redacted;
        return s.text;
    });
    return { signature: parts.join(' > '), redacted };
}


// ---------- corpus helpers ----------

const round2 = (x) => Math.round(x * 100) / 100;
const normPath = (p) => win32.normalize(String(p)).replace(/[\\/]+$/, '').toLowerCase();

/**
 * True when cwd is one of the excluded folders or inside one (case-insensitive, Windows path rules).
 * @param {string | null | undefined} cwd
 * @param {string[]} excludes resolved folders
 */
export function isExcludedCwd(cwd, excludes) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return false;
    const c = normPath(cwd);
    return excludes.some((e) => {
        if (typeof e !== 'string' || e.trim() === '') return false;
        const r = normPath(e);
        return c === r || c.startsWith(`${r}\\`);
    });
}

/**
 * Parity of verdict shares with S6 (per share, within the tolerance).
 * @param {Record<string, number>} shares percentages by verdict
 * @param {Record<string, number>} [reference]
 * @param {number} [tolerance] points
 */
export function parityOf(shares, reference = S6_REFERENCE_SHARES, tolerance = PARITY_TOLERANCE_POINTS) {
    const out = {};
    let pass = true;
    for (const v of VERDICTS) {
        const actual = round2(shares[v] ?? 0);
        const delta = round2(actual - reference[v]);
        const ok = Math.abs(delta) <= tolerance;
        out[v] = { actual, reference: reference[v], delta, pass: ok };
        pass = pass && ok;
    }
    return { reference: 'S6 DECIDED-3', tolerancePoints: tolerance, pass, shares: out };
}

const sessionFolders = (root) => readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

/** Session start of an events.jsonl: the cwd and the time (epoch ms) of the first session.start among the first lines (nulls when none). */
async function sessionStartOf(path) {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    let lines = 0;
    try {
        for await (const line of rl) {
            if (++lines > SCAN_HEAD_LINES) break;
            if (!line.includes('"session.start"')) continue;
            try {
                const event = JSON.parse(line);
                const cwd = event?.data?.context?.cwd;
                const at = Date.parse(event?.data?.startTime ?? event?.timestamp ?? '');
                return { cwd: typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null, startMs: Number.isNaN(at) ? null : at };
            } catch {
                return { cwd: null, startMs: null };
            }
        }
        return { cwd: null, startMs: null };
    } finally {
        rl.close();
    }
}

/** Working directory of a session: workspace.yaml `cwd:`, else the session.start context cwd. */
function sessionCwdOf(dir, start) {
    const wy = join(dir, 'workspace.yaml');
    if (existsSync(wy)) {
        const m = readFileSync(wy, 'utf8').match(/^cwd:\s*(.+)$/m);
        if (m && m[1].trim() !== '') return m[1].trim();
    }
    return start.cwd;
}

/** Epoch ms of an ISO date option (undefined: no bound); an unparsable value is an error. */
function instantOf(value, flag) {
    if (value === undefined || value === null) return null;
    const ms = Date.parse(String(value));
    if (Number.isNaN(ms)) throw new Error(`${flag} is not a valid date`);
    return ms;
}

/** command text of a powershell tool start, or null for any other event. */
function powershellCommandOf(event) {
    if (event?.type !== 'tool.execution_start' || event.data?.toolName !== PS_TOOL) return null;
    const command = event.data?.arguments?.command;
    return typeof command === 'string' ? command : null;
}

/** Session folder selected by the --session prefixes: no prefix selects every session; a prefix matches case-insensitively at the start of the folder name. */
export function isSelectedSession(name, prefixes) {
    if (!Array.isArray(prefixes) || prefixes.length === 0) return true;
    const lower = name.toLowerCase();
    return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** Read call of a view, grep or glob start event as { tool, args }, or null for any other event. */
export function readCallOf(event) {
    if (event?.type !== 'tool.execution_start' || !READ_TOOLS.has(event.data?.toolName)) return null;
    return { tool: event.data.toolName, args: event.data.arguments };
}

/** Engine decision of one call; a failure of the worker or the engine is an ASK, as at runtime. The signature is sanitized here. */
async function evaluateCall(engine, command, cwd, agent) {
    try {
        const r = await engine.evaluate({ script: command, cwd, agent });
        const sig = sanitizeSignature(r.facts?.signature ?? '');
        return { verdict: r.verdict, rule: r.primaryRule, rules: r.rules.map((x) => x.rule), signature: sig.signature, redacted: sig.redacted, worker: null, facts: r.facts };
    } catch (err) {
        if (err instanceof PwshClientError) return { verdict: 'ASK', rule: WORKER_RULE, signature: '', redacted: 0, worker: err.code };
        return { verdict: 'ASK', rule: ENGINE_RULE, signature: '', redacted: 0, worker: 'ENGINE', detail: String(err?.message ?? err) };
    }
}

// ---------- aggregation ----------

function newTally() {
    return {
        calls: 0,
        verdicts: { SAFE: 0, AI: 0, ASK: 0, SYNTAX: 0 },
        rules: new Map(),
        agents: new Map(),
        ask: new Map(),
        keys: new Set(),
        signatures: new Set(),
        redactions: 0,
        errors: { WORKER_UNAVAILABLE: 0, WORKER_ERROR: 0, ENGINE: 0 },
    };
}

function record(t, out, { agent, cwd, command }) {
    const key = `${cwd ?? ''}\u0001${command}`;
    t.calls++;
    t.keys.add(key);
    t.verdicts[out.verdict]++;
    t.redactions += out.redacted ?? 0;
    const rule = t.rules.get(out.rule) ?? { verdict: out.verdict, calls: 0 };
    rule.calls++;
    t.rules.set(out.rule, rule);
    const a = t.agents.get(agent) ?? { calls: 0, SAFE: 0, AI: 0, ASK: 0, SYNTAX: 0 };
    a.calls++;
    a[out.verdict]++;
    t.agents.set(agent, a);
    if (out.worker) t.errors[out.worker] = (t.errors[out.worker] ?? 0) + 1;
    if (out.signature) t.signatures.add(out.signature);
    if (out.verdict !== 'ASK') return;
    const g = t.ask.get(out.rule) ?? { calls: 0, keys: new Set(), agents: new Map(), examples: [], signatures: new Map() };
    g.calls++;
    g.keys.add(key);
    g.agents.set(agent, (g.agents.get(agent) ?? 0) + 1);
    if (g.examples.length < REVIEW_EXAMPLES) {
        const masked = maskForReview(command);
        if (!g.examples.includes(masked)) g.examples.push(masked);
    }
    if (out.signature) g.signatures.set(out.signature, (g.signatures.get(out.signature) ?? 0) + 1);
    t.ask.set(out.rule, g);
}

/** Sorted copy of a counts map as an object: by count (descending), then by key. */
function sortedCounts(counts) {
    return Object.fromEntries([...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
}

/** `name n, ...` of a counts object, or `none`. */
function formatCounts(counts) {
    const entries = Object.entries(counts);
    return entries.length ? entries.map(([name, n]) => `${name} ${n}`).join(', ') : 'none';
}

function newJudgeTally() {
    return {
        calls: 0, decisions: { ALLOW: 0, ASK: 0 }, unavailable: 0, cached: 0, latencyMsTotal: 0,
        triggers: new Map(), singleTrigger: new Map(), relaxedAllows: new Map(),
    };
}

/**
 * Counts one judge outcome under the live Stage-3 policy (combine with the call's engine evidence, as the hook does).
 * Trigger names and counts only; judge sentences are never kept.
 */
function recordJudge(t, out, outcome, thresholds) {
    t.calls++;
    if (outcome?.outcome !== 'ratings') {
        t.unavailable++;
        t.decisions.ASK++;
        return;
    }
    if (outcome.cached) t.cached++;
    t.latencyMsTotal += outcome.latencyMs ?? 0;
    const decision = combine(out, outcome, thresholds).decision;
    const { triggers, relaxed } = stage3Assessment(outcome.ratings, thresholds, callEvidenceOf(out));
    if (decision === 'ALLOW') {
        t.decisions.ALLOW++;
        for (const name of relaxed) incrementCount(t.relaxedAllows, name);
        return;
    }
    t.decisions.ASK++;
    if (triggers.length === 0) incrementCount(t.triggers, 'invalid-ratings-or-thresholds');
    for (const trigger of triggers) incrementCount(t.triggers, trigger.name);
    if (triggers.length === 1) incrementCount(t.singleTrigger, triggers[0].name);
}

/** judge section of results.json: counts only. */
function judgeResultsOf(t) {
    return {
        calls: t.calls,
        decisions: { ...t.decisions },
        unavailable: t.unavailable,
        cached: t.cached,
        latencyMsTotal: t.latencyMsTotal,
        triggers: sortedCounts(t.triggers),
        singleTrigger: sortedCounts(t.singleTrigger),
        relaxedAllows: sortedCounts(t.relaxedAllows),
    };
}

function newReadTally() {
    return {
        byTool: new Map(READ_TOOL_ORDER.map((tool) => [tool, { calls: 0, verdicts: { SAFE: 0, ASK: 0 }, rules: new Map() }])),
        secret: { calls: 0, rules: new Map() },
    };
}

const incrementCount = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Counts one read call: its tool, its verdict, each rule id of the decision, and a secret-root search. Rule ids only. */
function recordRead(t, tool, decision) {
    const toolTally = t.byTool.get(tool);
    toolTally.calls++;
    toolTally.verdicts[decision.verdict]++;
    for (const id of decision.ruleIds) incrementCount(toolTally.rules, id);
    if (decision.secretRootRuleIds.length > 0) {
        t.secret.calls++;
        for (const id of decision.secretRootRuleIds) incrementCount(t.secret.rules, id);
    }
}

/** Read-tool section of results.json: per tool calls, verdict shares and rule ids; rules sorted by count (desc), then id. */
function readToolsOf(t) {
    const byTool = Object.fromEntries(READ_TOOL_ORDER.map((tool) => {
        const toolTally = t.byTool.get(tool);
        const share = (n) => (toolTally.calls ? round2((n / toolTally.calls) * 100) : 0);
        return [tool, {
            calls: toolTally.calls,
            verdicts: {
                SAFE: { calls: toolTally.verdicts.SAFE, share: share(toolTally.verdicts.SAFE) },
                ASK: { calls: toolTally.verdicts.ASK, share: share(toolTally.verdicts.ASK) },
            },
            byRule: sortedCounts(toolTally.rules),
        }];
    }));
    return {
        calls: READ_TOOL_ORDER.reduce((sum, tool) => sum + t.byTool.get(tool).calls, 0),
        byTool,
        secretRootSearches: { calls: t.secret.calls, byRule: sortedCounts(t.secret.rules) },
    };
}

function buildResults(t, readTally, corpus, configWarnings, judgeTally) {
    const share = (n) => (t.calls ? round2((n / t.calls) * 100) : 0);
    const readTools = readToolsOf(readTally);
    const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, { calls: t.verdicts[v], share: share(t.verdicts[v]) }]));
    const byRule = Object.fromEntries([...t.rules].sort((x, y) => y[1].calls - x[1].calls)
        .map(([rule, r]) => [rule, { verdict: r.verdict, calls: r.calls, share: share(r.calls) }]));
    const byAgent = Object.fromEntries([...t.agents].sort((x, y) => y[1].calls - x[1].calls));
    const reviewGroups = [...t.ask].sort((x, y) => y[1].calls - x[1].calls).map(([rule, g]) => ({
        rule,
        calls: g.calls,
        uniqueScripts: g.keys.size,
        agents: Object.fromEntries(g.agents),
        signatures: [...g.signatures].sort((x, y) => y[1] - x[1]).slice(0, SIGNATURES_PER_GROUP)
            .map(([signature, n]) => ({ signature, calls: n })),
        examples: g.examples,
    }));
    const violations = new Set();
    for (const sig of t.signatures) for (const code of checkSignaturePrivacy(sig)) violations.add(code);
    if (violations.size) throw new Error(`signature privacy check failed (${[...violations].join(', ')}); nothing was written`);
    const workerTotal = t.errors.WORKER_UNAVAILABLE + t.errors.WORKER_ERROR;
    const results = {
        schema: 2,
        generatedAt: new Date().toISOString(),
        scope: 'AGGREGATES ONLY. No command text here; masked ASK examples are in ask-review.md (local, git-ignored).',
        corpus: {
            sessionFolders: corpus.sessionFolders,
            sessionsWithEvents: corpus.sessionsWithEvents,
            includedSessions: corpus.includedSessions,
            excludedSessions: corpus.excludedSessions,
            outOfRangeSessions: corpus.outOfRangeSessions,
            window: corpus.window,
            powershellCalls: t.calls,
            uniqueScripts: t.keys.size,
            agents: t.agents.size,
            badLines: corpus.badLines,
            unselectedSessions: corpus.unselectedSessions,
            sessionPrefixes: corpus.sessionPrefixes,
            readToolCalls: readTools.calls,
        },
        config: { warnings: configWarnings },
        workerErrors: { total: workerTotal, WORKER_UNAVAILABLE: t.errors.WORKER_UNAVAILABLE, WORKER_ERROR: t.errors.WORKER_ERROR },
        engineErrors: t.errors.ENGINE,
        verdicts,
        byRule,
        byAgent,
        readTools,
        askGroups: reviewGroups.map(({ examples, ...group }) => group),
        parity: parityOf(Object.fromEntries(VERDICTS.map((v) => [v, verdicts[v].share]))),
        privacy: { signaturesChecked: t.signatures.size, signatureRedactions: t.redactions, signatureViolations: 0 },
        judge: judgeTally ? judgeResultsOf(judgeTally) : null,
    };
    return { results, reviewGroups };
}

/** ASK review (masked examples, one section per primary rule). */
function renderReview(results, reviewGroups) {
    const lines = [
        '# Replay ASK review (LOCAL ONLY; masked; up to 3 examples per rule, each <= 600 characters)',
        '',
        `Generated ${results.generatedAt}. ${results.corpus.powershellCalls} PowerShell calls, ASK ${results.verdicts.ASK.calls}.`,
        'Masking is best effort; the scan of this file ran before it was written.',
        '',
    ];
    for (const g of reviewGroups) {
        lines.push(`## ${g.rule} — ${g.calls} calls, ${g.uniqueScripts} distinct scripts`, '');
        lines.push(`Agents: ${Object.entries(g.agents).map(([a, n]) => `${a} ${n}`).join(', ')}`, '');
        for (const s of g.signatures) lines.push(`- shape \`${s.signature}\` (${s.calls})`);
        if (g.signatures.length) lines.push('');
        for (const e of g.examples) lines.push('```powershell', e.replace(/```/g, "'''"), '```', '');
    }
    return `${lines.join('\n')}\n`;
}

// ---------- runner ----------

/**
 * Folders whose sessions are not replayed, from governor.json `replay.excludeCwds` (placeholders stay as written; runReplay
 * resolves them). A missing key means no exclusions. A governor.json that cannot be read, or a value that is not an array of
 * strings, is an error: the run must not replay excluded folders by accident.
 * @param {{ get: () => { governor: object | null } }} store config store (lib/config.mjs)
 * @returns {string[]}
 */
export function configuredExcludeCwds(store) {
    const governor = store.get().governor;
    if (!governor) throw new Error('governor.json could not be read; replay.excludeCwds is needed');
    const value = governor.replay?.excludeCwds;
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((p) => typeof p === 'string')) throw new Error('governor.json replay.excludeCwds must be an array of strings');
    return [...value];
}

/**
 * Replays the PowerShell history of a copilot home. Read-only over session-state; writes only to outDir.
 * @param {object} [options]
 * @param {string} [options.copilotHome] default <home>\.copilot
 * @param {Record<string, string | undefined>} [options.env] environment (default process.env)
 * @param {string} [options.home] user home (default env.USERPROFILE)
 * @param {string[]} [options.excludeCwds] excluded folders; replaces the governor.json list (placeholders allowed). Default: configuredExcludeCwds()
 * @param {string[]} [options.extraExcludeCwds] folders added to the governor.json list (the --exclude-cwd option)
 * @param {string} [options.outDir] output folder (default DEFAULT_OUT_DIR)
 * @param {string} [options.since] only sessions that started at or after this ISO date (session.start time)
 * @param {string} [options.until] only sessions that started before this ISO date; a session without a start time is outside any window
 * @param {(out: { verdict: string, rule: string, signature: string }, call: { agent: string, cwd: string | null, command: string, at: string | null }) => void} [options.onCall] observer of every replayed call (`at`: event timestamp; analysis hooks, never persisted here)
 * @param {(decision: object, call: { tool: string, agent: string, at: string | null }) => void} [options.onReadCall] observer of every replayed view, grep or glob call; decision as evaluateReadTool returns it (analysis hooks, never persisted here)
 * @param {boolean} [options.judgeMode] re-runs the AI judge for every AI-verdict call (default false); counts go to results.judge
 * @param {{ judge: (request: object) => Promise<object>, stop?: () => Promise<void> }} [options.judge] judge seam; default createJudge (stopped here), an injected judge is not stopped
 * @param {{ evaluate: (input: object) => Promise<object>, directoryPolicyFor: (call: { agent: string, cwd: string | null }) => object }} [options.engine] engine seam (read calls need directoryPolicyFor); default createEngine
 * @param {string[]} [options.sessions] session folder name prefixes (case-insensitive); empty or absent selects every session
 * @param {{ argv: (script: string, cwd: string | null) => Promise<object> }} [options.worker] facts provider (default: a PwshClient)
 * @param {object} [options.stage3] Stage-3 thresholds for --judge (tests only; default: config/governor.json stage3)
 * @returns {Promise<{ results: object, files: { results: string, askReview: string } }>}
 */
export async function runReplay(options = {}) {
    const sinceMs = instantOf(options.since, '--since');
    const untilMs = instantOf(options.until, '--until');
    const windowed = sinceMs !== null || untilMs !== null;
    const env = options.env ?? process.env;
    const home = options.home ?? env.USERPROFILE ?? env.HOME ?? homedir();
    const temp = env.TEMP || env.TMP || tmpdir();
    const copilotHome = options.copilotHome ?? join(home, '.copilot');
    const outDir = options.outDir ?? DEFAULT_OUT_DIR;
    const sessionRoot = join(copilotHome, 'session-state');
    if (!existsSync(sessionRoot)) throw new Error('session-state folder not found under the copilot home');

    let configWarnings = 0;
    const store = createConfigStore({
        rootDir: EXTENSION_ROOT, copilotHome, env: { ...env, USERPROFILE: home }, onWarning: () => { configWarnings++; },
    });
    registerDirectoryPolicy(store);
    registerCatalogGroups(store);
    const listedExcludes = options.excludeCwds ?? [...configuredExcludeCwds(store), ...(options.extraExcludeCwds ?? [])];
    const excludes = listedExcludes.map((p) => resolvePlaceholders(p, { home, temp, copilotHome }));

    const current = { ctx: null, sid: null };
    const sessions = Array.isArray(options.sessions) ? [...options.sessions] : [];
    const codeRoots = Array.isArray(store.get().governor?.codeRoots) ? [...store.get().governor.codeRoots] : [];
    const session = { scriptStatus: (p) => (current.ctx ? current.ctx.scriptStatus(p) : 'missing') };
    let engine = null;
    let client = null;
    const worker = options.worker ?? (client = new PwshClient({
        pwshPath: store.get().governor?.worker?.pwshPath ?? 'pwsh',
        requestTimeoutMs: 60000,
        maxRestarts: 20,
        workerConfig: () => ({
            userHome: home, copilotHome, systemRoots: [env.SystemRoot || env.windir || 'C:\\Windows'], flagTable: engine.flagTable(),
        }),
    }));
    engine = options.engine ?? createEngine({ config: store, worker, session, sessionId: () => current.sid, home, copilotHome, temp });
    const judgeTally = options.judgeMode === true ? newJudgeTally() : null;
    const stage3 = options.stage3 ?? store.get().governor?.stage3;
    const judgeObj = judgeTally ? (options.judge ?? createJudge({ config: store })) : null;
    const ownsJudge = judgeTally !== null && options.judge === undefined;
    const pending = [];

    const corpus = {
        sessionFolders: 0, sessionsWithEvents: 0, includedSessions: 0, excludedSessions: 0, outOfRangeSessions: 0, unselectedSessions: 0, badLines: 0,
        sessionPrefixes: sessions,
        window: { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), until: untilMs === null ? null : new Date(untilMs).toISOString() },
    };
    const tally = newTally();
    const readTally = newReadTally();
    try {
        for (const name of sessionFolders(sessionRoot)) {
            corpus.sessionFolders++;
            const dir = join(sessionRoot, name);
            const evPath = join(dir, 'events.jsonl');
            if (!existsSync(evPath)) continue;
            corpus.sessionsWithEvents++;
            if (!isSelectedSession(name, sessions)) {
                corpus.unselectedSessions++;
                continue;
            }
            const start = await sessionStartOf(evPath);
            if (windowed && (start.startMs === null || (sinceMs !== null && start.startMs < sinceMs) || (untilMs !== null && start.startMs >= untilMs))) {
                corpus.outOfRangeSessions++;
                continue;
            }
            const cwd = sessionCwdOf(dir, start);
            if (isExcludedCwd(cwd, excludes)) {
                corpus.excludedSessions++;
                continue;
            }
            corpus.includedSessions++;
            current.ctx = createSessionContext({ cwd: cwd ?? undefined });
            current.sid = name;
            const rl = createInterface({ input: createReadStream(evPath, { encoding: 'utf8' }), crlfDelay: Infinity });
            for await (const line of rl) {
                if (line.trim() === '') continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    corpus.badLines++;
                    continue;
                }
                current.ctx.observe(event);
                const at = typeof event.timestamp === 'string' ? event.timestamp : null;
                const read = readCallOf(event);
                if (read !== null) {
                    const caller = await current.ctx.callerOf(event.agentId ?? null);
                    let decision;
                    try {
                        const policy = engine.directoryPolicyFor({ agent: caller.name, cwd });
                        decision = evaluateReadTool({ tool: read.tool, args: read.args, cwd, policy, home });
                    } catch {
                        // as at runtime (governor.mjs): a failed decision is an ASK under its own rule id; the rule is counted
                        decision = { verdict: 'ASK', ruleIds: [READ_ERROR_RULE], findings: [], targets: [], secretRootRuleIds: [] };
                    }
                    options.onReadCall?.(decision, { tool: read.tool, agent: caller.name, at });
                    recordRead(readTally, read.tool, decision);
                    continue;
                }
                const command = powershellCommandOf(event);
                if (command === null) continue;
                const agent = await current.ctx.agentName(event.agentId ?? null);
                const out = await evaluateCall(engine, command, cwd, agent);
                options.onCall?.(out, { agent, cwd, command, at });
                record(tally, out, { agent, cwd, command });
                if (judgeTally && out.verdict === 'AI') {
                    const caller = await current.ctx.callerOf(event.agentId ?? null);
                    const context = await current.ctx.judgeContext(event.agentId ?? null);
                    const request = judgeRequestOf({
                        script: command,
                        facts: out.facts,
                        caller,
                        context,
                        callPurpose: event.data?.arguments?.description,
                        cwdClass: repoRootOf(cwd, { codeRoots }) ? 'repo' : 'other',
                    });
                    const judged = (async () => judgeObj.judge(request))();
                    pending.push(judged.then(
                        (o) => recordJudge(judgeTally, out, o, stage3),
                        (err) => recordJudge(judgeTally, out, { outcome: 'ask', reason: String(err?.message ?? err) }, stage3),
                    ));
                }
            }
        }
    } finally {
        current.ctx = null;
        await Promise.all(pending);
        if (ownsJudge) await judgeObj.stop();
        if (client) await client.stop();
    }

    const { results, reviewGroups } = buildResults(tally, readTally, corpus, configWarnings, judgeTally);
    const resultsText = `${JSON.stringify(results, null, 2)}\n`;
    const reviewText = renderReview(results, reviewGroups);
    assertClean({ 'results.json': resultsText, 'ask-review.md': reviewText });
    mkdirSync(outDir, { recursive: true });
    const files = { results: join(outDir, 'results.json'), askReview: join(outDir, 'ask-review.md') };
    writeFileSync(files.results, resultsText, 'utf8');
    writeFileSync(files.askReview, reviewText, 'utf8');
    return { results, files };
}

/**
 * Console summary: verdict shares, parity per share and the worker error count. No command text.
 * @param {object} results output of runReplay
 * @returns {string}
 */
export function formatSummary(results) {
    const c = results.corpus;
    const lines = [
        `replay: ${c.includedSessions} sessions (${c.excludedSessions} excluded), ${c.powershellCalls} PowerShell calls`,
        `worker errors: ${results.workerErrors.total}, engine errors: ${results.engineErrors}`,
    ];
    if (c.window && (c.window.since || c.window.until)) {
        lines.push(`window: since ${c.window.since ?? '-'}, until ${c.window.until ?? '-'} (${c.outOfRangeSessions} sessions outside)`);
    }
    for (const v of VERDICTS) {
        const p = results.parity.shares[v];
        const sign = p.delta >= 0 ? '+' : '';
        lines.push(`${v.padEnd(6)} ${results.verdicts[v].share.toFixed(2).padStart(6)} %  (S6 ${p.reference}, delta ${sign}${p.delta.toFixed(2)}) ${p.pass ? 'PASS' : 'FAIL'}`);
    }
    lines.push(`parity (±${results.parity.tolerancePoints} points): ${results.parity.pass ? 'PASS' : 'FAIL'}`);
    const readTools = results.readTools;
    lines.push(`read tools: ${readTools.calls} calls (${READ_TOOL_ORDER.map((tool) => `${tool} ${readTools.byTool[tool].calls}`).join(', ')})`);
    for (const tool of READ_TOOL_ORDER) {
        const row = readTools.byTool[tool];
        const rules = Object.entries(row.byRule).slice(0, SUMMARY_RULES).map(([id, n]) => `${id} ${n}`);
        lines.push(`  ${tool.padEnd(5)} SAFE ${row.verdicts.SAFE.calls}  ASK ${row.verdicts.ASK.calls}  rules: ${rules.length ? rules.join(', ') : 'none'}`);
    }
    const secretRules = Object.entries(readTools.secretRootSearches.byRule).map(([id, n]) => `${id} ${n}`);
    lines.push(`secret-root searches (grep/glob root reaches a secret rule base): ${readTools.secretRootSearches.calls}${secretRules.length ? ` (${secretRules.join(', ')})` : ''}`);
    if (results.judge) {
        const j = results.judge;
        lines.push(`judge mode: ${j.calls} AI calls re-judged: ALLOW ${j.decisions.ALLOW}, ASK ${j.decisions.ASK} (judge unavailable ${j.unavailable}, cached ${j.cached})`);
        lines.push(`  ASK triggers: ${formatCounts(j.triggers)}`);
        lines.push(`  single-trigger ASKs: ${formatCounts(j.singleTrigger)}`);
        lines.push(`  relaxed to ALLOW: ${formatCounts(j.relaxedAllows)}`);
    } else {
        lines.push('judge mode: off');
    }
    return lines.join('\n');
}

function argValue(argv, i, flag) {
    if (typeof argv[i] !== 'string' || argv[i].trim() === '') throw new Error(`${flag} needs a value`);
    return argv[i];
}

/**
 * Command-line options of the replay tool. Throws on an unknown flag or a flag without a value.
 * @param {string[]} argv arguments after the script name
 * @returns {{ summary: boolean, extra: string[], copilotHome: string|undefined, since: string|undefined, until: string|undefined, outDir: string|undefined, sessions: string[], judgeMode: boolean }}
 */
export function parseArgs(argv) {
    const opts = { summary: false, extra: [], copilotHome: undefined, since: undefined, until: undefined, outDir: undefined, sessions: [], judgeMode: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--summary') opts.summary = true;
        else if (a === '--judge') opts.judgeMode = true;
        else if (a === '--exclude-cwd') opts.extra.push(argValue(argv, ++i, a));
        else if (a === '--copilot-home') opts.copilotHome = argValue(argv, ++i, a);
        else if (a === '--session') opts.sessions.push(argValue(argv, ++i, a));
        else if (a === '--since') opts.since = argValue(argv, ++i, a);
        else if (a === '--until') opts.until = argValue(argv, ++i, a);
        else if (a === '--out') opts.outDir = resolve(argValue(argv, ++i, a));
        else throw new Error(`unknown argument ${a}`);
    }
    return opts;
}

/**
 * CLI entry. Returns the exit code: 0 for a finished run (parity PASS/FAIL is reported, not an error), 2 on failure.
 * @param {string[]} [argv]
 * @param {{ log?: (s: string) => void, error?: (s: string) => void }} [io]
 */
export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        io.error(`replay: ${err.message}`);
        return 2;
    }
    try {
        const { results, files } = await runReplay({
            copilotHome: opts.copilotHome,
            extraExcludeCwds: opts.extra,
            since: opts.since,
            until: opts.until,
            outDir: opts.outDir,
            sessions: opts.sessions,
            judgeMode: opts.judgeMode,
        });
        io.log(opts.summary ? formatSummary(results) : `replay: wrote ${files.results} and ${files.askReview}`);
        return 0;
    } catch (err) {
        io.error(`replay failed: ${err.message}`);
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then((code) => { process.exitCode = code; });
}
