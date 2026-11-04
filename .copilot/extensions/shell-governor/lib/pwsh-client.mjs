// Node client for pwsh/worker.ps1 (persistent PowerShell AST "facts" worker).
// Lazy start, request multiplexing by id, one automatic restart after a crash, idle shutdown, stop().
// Never write to stdout from here: stdout of the extension process is the JSON-RPC channel.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Default worker script, next to the extension's `pwsh/` folder. */
export const DEFAULT_WORKER_PATH = fileURLToPath(new URL('../pwsh/worker.ps1', import.meta.url));

/**
 * Failure codes (`error.code`). The governor maps every one of them to ASK:
 * - `WORKER_UNAVAILABLE`: the worker could not be started, died, timed out, hit the restart limit, or the client was stopped.
 *   `error.reason` is a short machine-readable cause: `spawn-failed`, `ready-timeout`, `exited`, `restart-limit`, `request-timeout`, `stopped`.
 * - `WORKER_ERROR`: the worker answered the request with an error (unknown op, invalid config, internal exception).
 */
export class PwshClientError extends Error {
    /**
     * @param {'WORKER_UNAVAILABLE' | 'WORKER_ERROR'} code
     * @param {string} message
     * @param {string} [reason]
     */
    constructor(code, message, reason = code === 'WORKER_ERROR' ? 'worker-error' : 'unavailable') {
        super(message);
        this.name = 'PwshClientError';
        this.code = code;
        this.reason = reason;
    }
}

const unavailable = (message, reason) => new PwshClientError('WORKER_UNAVAILABLE', message, reason);

/**
 * @typedef {object} PwshClientOptions
 * @property {string} [pwshPath] pwsh executable (config `worker.pwshPath`), default "pwsh"
 * @property {string} [workerPath] worker script, default the extension's pwsh/worker.ps1
 * @property {number} [idleMs] stop the worker after this much inactivity (config `worker.idleMs`); 0 disables
 * @property {{ now: () => number }} [clock] injected clock used for the idle check
 * @property {object | (() => object)} [workerConfig] payload of the startup `config` request (userHome, copilotHome,
 *   secretPatterns, systemRoots, flagTable); evaluated on every worker start
 * @property {number} [requestTimeoutMs]
 * @property {number} [readyTimeoutMs]
 * @property {number} [maxRestarts] automatic restarts after crashes over the client's lifetime (default 1)
 * @property {typeof spawn} [spawnFn] injectable for tests
 * @property {(text: string) => void} [onLog] receives the worker's stderr and protocol noise
 */

export class PwshClient {
    /** @param {PwshClientOptions} [options] */
    constructor(options = {}) {
        this.pwshPath = options.pwshPath ?? 'pwsh';
        this.workerPath = options.workerPath ?? DEFAULT_WORKER_PATH;
        this.idleMs = options.idleMs ?? 600000;
        this.clock = options.clock ?? { now: () => Date.now() };
        this.workerConfig = options.workerConfig ?? {};
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
        this.readyTimeoutMs = options.readyTimeoutMs ?? 20000;
        this.maxRestarts = options.maxRestarts ?? 1;
        this.spawnFn = options.spawnFn ?? spawn;
        this.onLog = options.onLog ?? (() => {});

        /** @type {import('node:child_process').ChildProcess | null} */
        this.proc = null;
        this.restarts = 0;
        this.everStarted = false;
        this.crashed = false;
        this.deliberateStop = false;
        this.closed = false;
        this.nextId = 1;
        this.lastActivity = this.clock.now();
        /** @type {Promise<void> | null} */
        this.starting = null;
        /** @type {Map<number, { op: string, id: number, body: string, child: object, timer: any, sent?: boolean, resolve: Function, reject: Function }>} */
        this.pending = new Map();
        /** The request written to the worker that has no answer yet (the worker serves one at a time). */
        this.inflight = null;
        /** Idle shutdown in progress, or null. */
        this.stopping = null;
        this.idleTimer = null;
    }

    /** Process id of the running worker, or null while it is not running. */
    get pid() {
        return this.proc?.pid ?? null;
    }

    /**
     * Facts of a script without argv detail: parse errors, command names, redirections, dynamic-invocation counts.
     * @param {string} script
     * @returns {Promise<any>} the worker's response object (`id`, `parseErrors`, `commandCount`, `commands`, ...)
     */
    parse(script) {
        return this.request('parse', { script }).then((r) => {
            if (!(Array.isArray(r?.commands) && Array.isArray(r.parseErrors) && typeof r.commandCount === 'number')) {
                throw new PwshClientError('WORKER_ERROR', 'malformed parse response');
            }
            return r;
        });
    }

    /**
     * Extractor v2 facts: per command raw arguments (case preserved), constants, effective cwd, redirections,
     * path binding, inner scripts; plus `dotnetCalls`, `dotnet`, `flags`, `constVars`, `parseErrors`.
     * @param {string} script
     * @param {string | null} [cwd] working directory of the call; null when unknown
     * @param {{ joinPath?: boolean, dotnetArgs?: boolean } | null} [features] both default to true
     * @returns {Promise<any>}
     */
    argv(script, cwd = null, features = null) {
        return this.request('argv', { script, cwd, features }).then((r) => {
            if (!(Array.isArray(r?.commands) && Array.isArray(r.parseErrors) && typeof r.statementCount === 'number')) {
                throw new PwshClientError('WORKER_ERROR', 'malformed argv response');
            }
            return r;
        });
    }

    /** @returns {Promise<any>} worker pid, working set, requests served, configured tool count */
    stats() {
        return this.request('stats', {});
    }

    /**
     * Sends one request and resolves with the worker's response. Starts (or restarts) the worker on demand.
     * Rejects with {@link PwshClientError}.
     * @param {string} op
     * @param {object} [payload]
     * @returns {Promise<any>}
     */
    async request(op, payload = {}) {
        await this.#ensure();
        return this.#send(op, payload);
    }

    /** Stops the worker when it has been idle for `idleMs` and nothing is in flight. Called by an internal timer; public for tests. */
    async checkIdle() {
        if (this.idleMs <= 0 || !this.proc || this.pending.size > 0 || this.starting || this.stopping) return;
        if (this.clock.now() - this.lastActivity < this.idleMs) return;
        // `stopping` is set before the first await: a request that arrives meanwhile waits for it and starts a new worker
        this.stopping = this.#shutdownWorker('idle').finally(() => { this.stopping = null; });
        await this.stopping;
    }

    /** Stops the worker and all later requests fail with WORKER_UNAVAILABLE (reason `stopped`). */
    async stop() {
        this.closed = true;
        this.#clearIdleTimer();
        if (this.stopping) await this.stopping.catch(() => {});
        await this.#shutdownWorker('stopped');
    }

    async #ensure() {
        if (this.closed) throw unavailable('pwsh worker client was stopped', 'stopped');
        if (this.stopping) {
            await this.stopping.catch(() => {});
            if (this.closed) throw unavailable('pwsh worker client was stopped', 'stopped');
        }
        if (this.proc && this.proc.exitCode === null && !this.starting) return;
        if (this.starting) return this.starting;
        if (this.everStarted && this.crashed) {
            if (this.restarts >= this.maxRestarts) {
                throw unavailable(`pwsh worker died; restart limit (${this.maxRestarts}) reached`, 'restart-limit');
            }
            this.restarts++;
        }
        this.crashed = false;
        this.starting = this.#start().finally(() => { this.starting = null; });
        return this.starting;
    }

    async #start() {
        this.everStarted = true;
        await this.#spawnAndWaitReady();
        try {
            const config = typeof this.workerConfig === 'function' ? this.workerConfig() : this.workerConfig;
            await this.#send('config', config ?? {});
        } catch (e) {
            await this.#shutdownWorker('config-failed', true);
            throw e.code ? e : unavailable(`pwsh worker config failed: ${e.message}`, 'spawn-failed');
        }
        this.lastActivity = this.clock.now();
        this.#startIdleTimer();
    }

    #spawnAndWaitReady() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(readyTimer);
                fn(value);
            };
            let child;
            try {
                child = this.spawnFn(this.pwshPath,
                    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.workerPath],
                    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (e) {
                reject(unavailable(`pwsh worker could not be started: ${e.message}`, 'spawn-failed'));
                return;
            }
            this.proc = child;
            const readyTimer = setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
                settle(reject, unavailable('pwsh worker ready timeout', 'ready-timeout'));
            }, this.readyTimeoutMs);

            child.stderr?.on('data', (d) => this.onLog(`worker stderr: ${d.length} bytes\n`)); // sizes only: stderr can echo script text
            child.stdin?.on('error', () => { /* a dead worker surfaces through the exit handler */ });
            child.on('error', (e) => {
                this.onLog(`spawn error: ${e?.code ?? e?.name ?? 'unknown'}\n`);
                if (this.proc === child) this.proc = null;
                settle(reject, unavailable(`pwsh worker could not be started: ${e.message}`, 'spawn-failed'));
            });

            let gotReady = false;
            const rl = createInterface({ input: child.stdout });
            rl.on('line', (line) => {
                let msg;
                try { msg = JSON.parse(line); } catch { this.onLog(`bad stdout line: ${Buffer.byteLength(line)} bytes\n`); return; }
                if (!gotReady && msg.ready) {
                    gotReady = true;
                    settle(resolve, msg);
                    return;
                }
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                if (this.inflight === p) this.inflight = null;
                if (msg.error) {
                    this.onLog(`worker error: ${Buffer.byteLength(String(msg.error))} bytes\n`);
                    p.reject(new PwshClientError('WORKER_ERROR', `pwsh worker: ${msg.error}`));
                } else p.resolve(msg);
                this.#pump();
            });
            child.on('exit', (code) => {
                const err = unavailable(`pwsh worker exited (code ${code})`, 'exited');
                if (this.proc === child) {
                    this.proc = null;
                    if (!this.deliberateStop) this.crashed = true;
                }
                settle(reject, err);
                this.#rejectPending(err, child);
                this.#pump(); // a request of a newer worker may have queued behind an entry of this one
            });
        });
    }

    /** Rejects the pending requests of one worker (all when `child` is omitted). @param {Error} err @param {object} [child] */
    #rejectPending(err, child) {
        for (const [id, p] of this.pending) {
            if (child && p.child !== child) continue;
            clearTimeout(p.timer);
            this.pending.delete(id);
            if (this.inflight === p) this.inflight = null;
            p.reject(err);
        }
    }

    #send(op, payload) {
        const child = this.proc;
        if (!child || child.exitCode !== null) return Promise.reject(unavailable('pwsh worker not running', 'exited'));
        const id = this.nextId++;
        const body = `${JSON.stringify({ id, op, ...payload })}\n`;
        this.lastActivity = this.clock.now();
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                op, id, body, child, timer: null,
                resolve: (v) => {
                    this.lastActivity = this.clock.now();
                    // a worker that answers a real request is healthy: the next crash gets its restart again
                    if (op !== 'config') this.restarts = 0;
                    resolve(v);
                },
                reject,
            });
            this.#pump();
        });
    }

    /**
     * The worker serves one request at a time, so requests are written one at a time too: the timeout of a request
     * starts when it is written, not while it waits behind a slower one.
     */
    #pump() {
        if (this.inflight) return;
        const next = [...this.pending.values()].find((p) => !p.sent);
        if (!next) return;
        const child = next.child;
        if (this.proc !== child || child.exitCode !== null) {
            // the worker of this request is gone; its exit handler (or the timeout) rejects the entry
            return;
        }
        next.sent = true;
        this.inflight = next;
        next.timer = setTimeout(() => {
            this.pending.delete(next.id);
            if (this.inflight === next) this.inflight = null;
            next.reject(unavailable(`pwsh worker request ${next.id} timed out`, 'request-timeout'));
            // A hung worker is treated as dead right away (the next request starts a new one) and killed.
            if (this.proc === child) { this.proc = null; this.crashed = true; }
            try { child.kill(); } catch { /* ignore */ }
        }, this.requestTimeoutMs);
        child.stdin.write(next.body, (err) => {
            if (!err) return;
            clearTimeout(next.timer);
            this.pending.delete(next.id);
            if (this.inflight === next) this.inflight = null;
            next.reject(unavailable(`pwsh worker write failed: ${err.message}`, 'exited'));
            this.#pump();
        });
    }

    /** Asks the worker to exit; kills it when it does not comply quickly. Not counted as a crash. */
    async #shutdownWorker(reason, fromStart = false) {
        if (this.starting && !fromStart) { try { await this.starting; } catch { /* handled by the starter */ } }
        const running = this.proc;
        if (!running || running.exitCode !== null) { this.proc = null; return; }
        this.deliberateStop = true;
        const exited = new Promise((resolve) => running.once('exit', resolve));
        const err = unavailable(`pwsh worker stopped (${reason})`, reason === 'stopped' ? 'stopped' : 'exited');
        this.#rejectPending(err, running);
        this.#pump(); // entries of another worker that queued behind the rejected ones
        try { running.stdin.write(`${JSON.stringify({ id: 0, op: 'exit' })}\n`); } catch { /* ignore */ }
        const killer = setTimeout(() => { try { running.kill(); } catch { /* ignore */ } }, 1000);
        killer.unref?.();
        await exited;
        clearTimeout(killer);
        this.deliberateStop = false;
        this.proc = null;
    }

    #startIdleTimer() {
        if (this.idleMs <= 0 || this.idleTimer) return;
        const every = Math.max(250, Math.min(30000, Math.floor(this.idleMs / 2)));
        this.idleTimer = setInterval(() => { this.checkIdle().catch(() => {}); }, every);
        this.idleTimer.unref?.();
    }

    #clearIdleTimer() {
        if (this.idleTimer) clearInterval(this.idleTimer);
        this.idleTimer = null;
    }
}
