// AI judge: one long-running `copilot --acp` process (JSON-RPC 2.0 over stdio, newline-delimited), started lazily with an
// isolated empty COPILOT_HOME and an empty sandbox cwd. One ACP session per judgment, every permission request rejected,
// at most `maxConcurrent` judgments at once, verdicts cached per normalised script. Every failure (timeout, process
// failure, invalid output) becomes an ASK outcome; nothing here throws to the caller.
// Ported from the research spike (acp-judge.mjs sequence and permission handling, validate-raw.mjs extractObject).
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RATINGS, RATING_MAX } from './contracts.mjs';
import { buildJudgePrompt, normalizeScript } from './judge-prompt.mjs';

/** Judge sandbox and isolated homes live under the OS temp folder, outside any repository. */
const DEFAULT_HOME_ROOT = join(tmpdir(), 'shell-governor-judge');
/**
 * Environment variables (upper-case names; matched in any case) the judge process may inherit: what the CLI needs to
 * start and authenticate. Everything else is dropped, above all COPILOT_ALLOW_ALL and every other COPILOT_* /
 * GITHUB_COPILOT_* switch (they can auto-approve tools or trust the working directory).
 * Deliberate exception: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN (and GH_HOST, GH_ENTERPRISE_TOKEN) ARE passed on, because
 * the isolated `copilot --acp` process authenticates with them; without a token the judge cannot start a session. They are
 * credentials by design, so this list must only ever contain what authentication needs. USERPROFILE, HOME, APPDATA and
 * LOCALAPPDATA are passed for the same reason (profile and credential-store lookup of the CLI); COPILOT_HOME is always
 * overridden with the isolated home.
 */
const JUDGE_ENV_ALLOWLIST = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'TEMP', 'TMP',
    'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN',
]);

/**
 * Environment of the judge process: the allowlisted parent variables plus COPILOT_HOME set to the isolated home.
 * @param {NodeJS.ProcessEnv} parent @param {string} home
 * @returns {Record<string, string>}
 */
function judgeEnv(parent, home) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const [name, value] of Object.entries(parent)) {
        if (typeof value === 'string' && JUDGE_ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
    }
    env.COPILOT_HOME = home;
    return env;
}
/** Never pass an allow flag, `--yolo` or `--available-tools` (the latter is rejected in ACP mode). */
const COPILOT_FLAGS = ['--acp', '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user', '--no-auto-update', '--no-remote'];
const REQUEST_TIMEOUT_MS = 60000;
const KILL_WAIT_MS = 3000;
const MAX_SENTENCE_CHARS = 300;
const MAX_START_ATTEMPTS = 50;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * @typedef {{ outcome: 'ratings', ratings: import('./contracts.mjs').Ratings, latencyMs: number, cached: boolean }
 *   | { outcome: 'ask', reason: string }} JudgeOutcome
 */

/** Failure with a kind, converted to an ASK reason at the boundary. */
class JudgeError extends Error {
    /** @param {'timeout'|'process'|'invalid'|'request'} kind @param {string} message */
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

/**
 * Default spawn: the CLI is `copilot` on PATH, started as an argv array with `shell: false` (never a shell string).
 * This resolves `copilot.exe`; a `.cmd`/`.bat` shim is not supported (spawn fails with ENOENT, which the judge reports
 * once through `onLog` as `judge-spawn-failed` and then keeps failing closed with ASK).
 * @param {string} command @param {string[]} args @param {import('node:child_process').SpawnOptions} options
 */
function defaultSpawn(command, args, options) {
    return spawn(command, args, { ...options, shell: false });
}

/**
 * Kill the whole process tree of a child (the Windows shell shim has a child of its own).
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function defaultKillTree(child) {
    return new Promise((resolve) => {
        if (child.pid && process.platform === 'win32') {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
                try { child.kill(); } catch { /* already gone */ }
                resolve();
            });
            return;
        }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
    });
}

/**
 * First balanced JSON object in the text that parses (the CLI glues `Info:` banners in front of it without a newline;
 * a stray `{` in a banner is skipped). Bounded: at most MAX_START_ATTEMPTS candidate positions are tried.
 * @param {string} text
 * @returns {object | null}
 */
export function extractObject(text) {
    let start = text.indexOf('{');
    for (let attempt = 0; start >= 0 && attempt < MAX_START_ATTEMPTS; attempt += 1) {
        const obj = parseBalancedAt(text, start);
        if (obj) return obj;
        start = text.indexOf('{', start + 1);
    }
    return null;
}

/** @param {string} text @param {number} start index of a `{` */
function parseBalancedAt(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
        } else if (c === '"') {
            inString = true;
        } else if (c === '{') {
            depth += 1;
        } else if (c === '}') {
            depth -= 1;
            if (depth === 0) {
                try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

/**
 * Validate the judge's JSON against the 9-rating schema. The two sentence fields are optional strings: a missing one is
 * left out of the result, a present one that is not a string is a problem named by its key.
 * @param {any} obj
 * @returns {{ ratings: import('./contracts.mjs').Ratings } | { problems: string[] }}
 */
export function validateVerdict(obj) {
    const problems = [];
    const values = {};
    for (const key of RATINGS) {
        const v = obj?.ratings?.[key];
        if (!Number.isInteger(v) || v < 0 || v > RATING_MAX) problems.push(`ratings.${key}`);
        else values[key] = v;
    }
    const confidence = obj?.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) problems.push('confidence');
    for (const key of ['what_it_does', 'worst_consequence']) {
        if (obj?.[key] !== undefined && typeof obj[key] !== 'string') problems.push(key);
    }
    if (problems.length) return { problems };
    const ratings = { values, confidence };
    if (typeof obj.what_it_does === 'string') ratings.whatItDoes = obj.what_it_does.slice(0, MAX_SENTENCE_CHARS);
    if (typeof obj.worst_consequence === 'string') ratings.worstConsequence = obj.worst_consequence.slice(0, MAX_SENTENCE_CHARS);
    return { ratings };
}

/** @param {number} pid */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/**
 * Cache key (JSON array of fields): SHA-256 of the raw script (line endings normalised, nothing else: no comment
 * stripping, whitespace kept), agent name, cwd class, a hash of the judge context: dispatch prompt, recent user
 * messages, agent type, a hash of the agent's description, the task name, the task description and the call purpose
 * (task_mismatch and the claim handling depend on them), and the deterministic facts signature when there is one.
 * @param {{ script: string, facts?: { signature?: string }, agentName: string, agentType?: string, agentDescription?: string, dispatchPrompt?: string, recentUserMessages?: string[], taskName?: string, taskDescription?: string, callPurpose?: string }} input
 * @param {string | undefined} cwdClass
 */
function cacheKey(input, cwdClass) {
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const context = sha(JSON.stringify([
        input.dispatchPrompt ?? null, input.recentUserMessages ?? null, input.agentType ?? null, sha(input.agentDescription ?? ''),
        input.taskName ?? null, input.taskDescription ?? null, input.callPurpose ?? null,
    ]));
    const signature = typeof input.facts?.signature === 'string' ? input.facts.signature : '';
    return JSON.stringify([sha(normalizeScript(input.script)), input.agentName, cwdClass ?? '', context, signature]);
}

/**
 * Create the judge.
 * @param {object} options
 * @param {{ get: () => { governor: { judge: { model: string, maxConcurrent: number, timeoutMs: number, cacheSize: number } } } }} options.config config store
 * @param {(command: string, args: string[], options: object) => import('node:child_process').ChildProcess} [options.spawnFn] injectable spawn
 * @param {{ now: () => number }} [options.clock] clock for latency figures
 * @param {string} [options.homeRoot] folder that holds the per-process isolated homes (deleted on stop)
 * @param {(entry: object) => void} [options.onLog] receives audit-style events (never script text)
 * @param {(child: import('node:child_process').ChildProcess) => Promise<void>} [options.killTree] injectable process-tree kill
 */
export function createJudge({
    config, spawnFn = defaultSpawn, clock = { now: () => Date.now() }, homeRoot = DEFAULT_HOME_ROOT, onLog = () => {},
    killTree = defaultKillTree,
}) {
    const log = (entry) => { try { onLog(entry); } catch { /* logging must never break a judgment */ } };
    const settings = () => {
        const j = config.get().governor?.judge ?? {};
        return {
            model: j.model, maxConcurrent: Math.max(1, j.maxConcurrent ?? 2), timeoutMs: j.timeoutMs ?? 30000, cacheSize: j.cacheSize ?? 500,
        };
    };
    const realNow = () => Date.now();

    /** @typedef {ReturnType<typeof startConn>} Conn */
    /** @type {Conn | null} */
    let current = null;
    /** @type {Map<string, any>} */
    const cache = new Map();
    let active = 0;
    /** @type {Array<() => void>} */
    const waiters = [];

    async function acquire() {
        while (active >= settings().maxConcurrent) await new Promise((resolve) => waiters.push(resolve));
        active += 1;
    }
    function release() {
        active -= 1;
        waiters.shift()?.();
    }

    /** @param {Conn} conn @param {string} reason */
    function markDead(conn, reason) {
        if (conn.dead) return;
        conn.dead = true;
        if (current === conn) current = null;
        for (const p of conn.pending.values()) p.reject(new JudgeError('process', `process failure: ${reason}`));
        conn.pending.clear();
        log({ event: 'process-exit', reason });
    }

    let swept = false;
    let notFoundReported = false;
    /** Report once that the copilot executable was not found (ENOENT with shell:false; .cmd shims are unsupported). @param {any} e */
    function reportNotFound(e) {
        if (e?.code !== 'ENOENT' || notFoundReported) return;
        notFoundReported = true;
        log({ event: 'judge-spawn-failed', message: 'copilot executable not found (shell:false; .cmd shims unsupported)' });
    }
    /** Remove run-* dirs left by processes that no longer exist (crash, kill). Dirs of live processes are never touched. */
    function sweepStaleRuns() {
        if (swept) return;
        swept = true;
        let names = [];
        try { names = readdirSync(homeRoot); } catch { return; }
        for (const name of names) {
            const owner = /^run-(\d+)-/.exec(name);
            if (!owner || Number(owner[1]) === process.pid || pidAlive(Number(owner[1]))) continue;
            try {
                rmSync(join(homeRoot, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
                log({ event: 'stale-run-removed' });
            } catch (e) {
                log({ event: 'cleanup-failed', message: String(e.message).slice(0, 120) });
            }
        }
    }

    /** Disposals in flight, so stop() also waits for a process that a timeout already started killing. */
    const disposals = new Set();

    /** Kill the tree, wait for exit and delete the isolated home. Idempotent. @param {Conn} conn @param {string} reason */
    function dispose(conn, reason) {
        markDead(conn, reason);
        if (!conn.disposed) {
            conn.disposed = (async () => {
                const child = conn.child;
                if (child && child.exitCode === null && child.signalCode === null) {
                    const exit = new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, KILL_WAIT_MS).unref(); });
                    await killTree(child).catch((e) => log({ event: 'cleanup-failed', message: `kill: ${String(e?.message).slice(0, 120)}` }));
                    await exit;
                }
                await rm(conn.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
                    .catch((e) => log({ event: 'cleanup-failed', message: `rm: ${String(e?.message).slice(0, 120)}` }));
            })().finally(() => disposals.delete(conn.disposed));
            disposals.add(conn.disposed);
        }
        return conn.disposed;
    }

    /** @param {Conn} conn @param {object} message */
    function write(conn, message) {
        try {
            conn.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
        } catch (e) {
            throw new JudgeError('process', `process failure: write failed (${e.message})`);
        }
    }

    /** @param {Conn} conn @param {string} method @param {object} params @param {number} timeoutMs */
    function rpc(conn, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (conn.dead) return reject(new JudgeError('process', 'process failure: process is not running'));
            const id = conn.nextId++;
            const timer = setTimeout(() => {
                conn.pending.delete(id);
                reject(new JudgeError('timeout', `timeout after ${timeoutMs}ms (${method})`));
            }, Math.max(1, timeoutMs));
            conn.pending.set(id, {
                resolve: (m) => { clearTimeout(timer); resolve(m); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            try {
                write(conn, { id, method, params });
            } catch (e) {
                clearTimeout(timer);
                conn.pending.delete(id);
                reject(e);
            }
        });
    }

    /** @param {Conn} conn @param {any} m */
    function handleMessage(conn, m) {
        if (m.method === 'session/update') {
            const update = m.params?.update ?? {};
            const sid = m.params?.sessionId;
            if (update.sessionUpdate === 'agent_message_chunk' && conn.texts.has(sid)) {
                conn.texts.set(sid, conn.texts.get(sid) + (update.content?.text ?? ''));
            }
            return;
        }
        if (m.method === 'session/request_permission') {
            const options = m.params?.options ?? [];
            // by kind when the option has one; the optionId is consulted only for options without a kind
            const reject = options.find((o) => (o.kind ? /reject|deny/i.test(o.kind) : /reject|deny/i.test(o.optionId ?? '')));
            log({ event: 'permission-rejected', kinds: options.map((o) => o.kind ?? o.optionId) });
            write(conn, { id: m.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
            return;
        }
        if (m.method && m.id !== undefined) {
            write(conn, { id: m.id, error: { code: -32601, message: 'not supported by judge' } });
            return;
        }
        const pending = m.id !== undefined ? conn.pending.get(m.id) : undefined;
        if (!pending) return;
        conn.pending.delete(m.id);
        if (m.error) pending.reject(new JudgeError('process', `process failure: rpc error ${m.error.code ?? ''} ${String(m.error.message ?? '').slice(0, 120)}`.trim()));
        else pending.resolve(m);
    }

    /** Spawn the process in a fresh isolated home and run `initialize`. */
    function startConn() {
        mkdirSync(homeRoot, { recursive: true });
        sweepStaleRuns();
        const runDir = mkdtempSync(join(homeRoot, `run-${process.pid}-`));
        const home = join(runDir, 'home');
        const sandbox = join(runDir, 'sandbox');
        mkdirSync(home);
        mkdirSync(sandbox);
        const conn = {
            runDir, sandbox, home, nextId: 1, dead: false, child: /** @type {any} */ (null), disposed: /** @type {Promise<void> | undefined} */ (undefined),
            pending: /** @type {Map<number, { resolve: Function, reject: Function }>} */ (new Map()),
            texts: /** @type {Map<string, string>} */ (new Map()),
            ready: /** @type {Promise<any>} */ (Promise.resolve()),
        };
        current = conn;
        const model = settings().model;
        try {
            if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) throw new Error('invalid model name');
            conn.child = spawnFn('copilot', [...COPILOT_FLAGS, '--model', model], {
                cwd: sandbox, env: judgeEnv(process.env, home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
        } catch (e) {
            reportNotFound(e);
            const err = new JudgeError('process', `process failure: spawn failed (${String(e.message).slice(0, 120)})`);
            conn.ready = Promise.reject(err);
            conn.ready.catch(() => {});
            void dispose(conn, 'spawn failed');
            return conn;
        }
        log({ event: 'spawn', model });
        const child = conn.child;
        child.stdin?.on('error', () => {});
        child.stderr?.on('data', () => {});
        child.stderr?.on('error', () => {});
        child.on('error', (e) => {
            reportNotFound(e);
            void dispose(conn, `error ${String(e.message).slice(0, 120)}`);
        });
        child.on('exit', (code, signal) => void dispose(conn, `exited (${code ?? signal})`));
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let m;
                try { m = JSON.parse(line); } catch { continue; }
                try { handleMessage(conn, m); } catch (e) { log({ event: 'protocol-error', message: String(e.message).slice(0, 120) }); }
            }
        });
        conn.ready = rpc(conn, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, REQUEST_TIMEOUT_MS)
            .then(() => conn)
            .catch((e) => { void dispose(conn, e.message); throw e; });
        conn.ready.catch(() => {});
        return conn;
    }

    /** @param {Promise<any>} promise @param {number} ms */
    function withTimeout(promise, ms) {
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new JudgeError('timeout', `timeout after ${ms}ms`)), Math.max(1, ms)); });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    /** @param {string} key */
    function cacheGet(key) {
        if (!cache.has(key)) return undefined;
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return value;
    }
    /** @param {string} key @param {any} value @param {number} size */
    function cachePut(key, value, size) {
        if (size <= 0) return;
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > size) cache.delete(cache.keys().next().value);
    }

    /** Run one judgment against the process. @returns {Promise<import('./contracts.mjs').Ratings>} */
    async function runJudgment(prompt, timeoutMs) {
        const deadline = realNow() + timeoutMs;
        const remaining = () => deadline - realNow();
        const starting = current && !current.dead ? current : startConn();
        let conn;
        try {
            conn = await withTimeout(starting.ready, remaining());
        } catch (e) {
            if (e.kind === 'timeout') void dispose(starting, 'startup timeout');
            throw e;
        }
        let created;
        try {
            created = await rpc(conn, 'session/new', { cwd: conn.sandbox, mcpServers: [] }, Math.min(remaining(), REQUEST_TIMEOUT_MS));
        } catch (e) {
            if (e.kind === 'timeout') void dispose(conn, 'session/new timeout');
            throw e;
        }
        const sessionId = created.result?.sessionId;
        if (typeof sessionId !== 'string') throw new JudgeError('process', 'process failure: no session id');
        conn.texts.set(sessionId, '');
        let text;
        try {
            await rpc(conn, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, remaining());
            text = conn.texts.get(sessionId) ?? '';
        } catch (e) {
            if (e.kind === 'timeout' && !conn.dead) { try { write(conn, { method: 'session/cancel', params: { sessionId } }); } catch { /* best effort */ } }
            throw e;
        } finally {
            conn.texts.delete(sessionId);
        }
        const obj = extractObject(text);
        if (!obj) throw new JudgeError('invalid', 'invalid-output: no JSON object');
        const checked = validateVerdict(obj);
        if ('problems' in checked) throw new JudgeError('invalid', `invalid-output: ${checked.problems.join(', ')}`);
        return checked.ratings;
    }

    /**
     * Judge one script. Never throws: every failure is an `ask` outcome.
     * @param {object} request fields of JudgePromptInput plus `cwdClass` (part of the cache key)
     * @returns {Promise<JudgeOutcome>}
     */
    async function judge(request) {
        const started = clock.now();
        /** @type {JudgeOutcome} */
        let result;
        try {
            const { cwdClass, ...promptInput } = request ?? {};
            let prompt;
            try {
                prompt = buildJudgePrompt(promptInput);
            } catch (e) {
                throw new JudgeError('request', e?.code === 'SCRIPT_TOO_LONG' ? 'script too long to judge' : `invalid-request: ${e.message}`);
            }
            const s = settings();
            const key = cacheKey(promptInput, cwdClass);
            const hit = cacheGet(key);
            if (hit) {
                result = { outcome: 'ratings', ratings: structuredClone(hit), latencyMs: 0, cached: true };
            } else {
                await acquire();
                let ratings;
                try { ratings = await runJudgment(prompt, s.timeoutMs); } finally { release(); }
                cachePut(key, structuredClone(ratings), s.cacheSize);
                result = { outcome: 'ratings', ratings, latencyMs: clock.now() - started, cached: false };
            }
        } catch (e) {
            const reason = e instanceof JudgeError ? e.message : `process failure: ${String(e?.message ?? e).slice(0, 120)}`;
            result = { outcome: 'ask', reason };
        }
        log({ event: 'judgment', outcome: result.outcome, cached: result.outcome === 'ratings' ? result.cached : false, reason: result.outcome === 'ask' ? result.reason : undefined });
        return result;
    }

    /** Kill the process tree and delete the isolated home (also waits for disposals already running). A later judge() starts a fresh process. */
    async function stop() {
        const conn = current;
        current = null;
        if (conn) await dispose(conn, 'stopped');
        await Promise.all([...disposals]);
    }

    return { judge, stop };
}
