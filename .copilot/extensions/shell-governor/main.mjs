// Shell governor extension wiring: the only module that touches the Copilot SDK. extension.mjs (one line) imports this
// file, so it is loaded in every CLI session (AGENTS.md §7b); it decides only when "enabled" in config/governor.json is not false.
// Everything with logic lives in lib/ and is tested through createGovernor with fakes. Never use console.log here or in lib/:
// stdout of the extension process is the JSON-RPC channel.
import { joinSession } from '@github/copilot-sdk/extension';
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit } from './lib/audit.mjs';
import { catalogFromGroups, registerCatalogGroups } from './lib/catalog.mjs';
import { createConfigStore } from './lib/config.mjs';
import { createDialog } from './lib/dialog.mjs';
import { flagTableOf } from './lib/engine.mjs';
import { createGovernor } from './lib/governor.mjs';
import { createJudge } from './lib/judge.mjs';
import { registerDirectoryPolicy } from './lib/paths.mjs';
import { PwshClient } from './lib/pwsh-client.mjs';

// Runtime folders and config root. SHELL_GOVERNOR_STATE_DIR and SHELL_GOVERNOR_CONFIG_ROOT are for tests only (main.test.mjs
// points them at temp folders): the state dir receives logs/ and reviews/, the config root must contain config/governor.json
// and config/agents.json; unset, both are the extension folder. Directory rules and the catalog always come from this extension.
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.SHELL_GOVERNOR_STATE_DIR || HERE;
const CONFIG_ROOT = process.env.SHELL_GOVERNOR_CONFIG_ROOT || HERE;
const LOGS_DIR = join(STATE_DIR, 'logs');
const REVIEWS_DIR = join(STATE_DIR, 'reviews');
const HOME =  process.env.USERPROFILE || process.env.HOME || homedir();
const COPILOT_HOME = process.env.COPILOT_HOME || join(HOME, '.copilot');

/** Epoch-based clock that only moves forward (performance.now deltas), so review-file stamps and pruning are not shifted by a wall-clock jump. */
const clock = (() => {
    const wallStart = Date.now();
    const perfStart = performance.now();
    return Object.freeze({ now: () => wallStart + (performance.now() - perfStart) });
})();

const MAX_LOG_BYTES = 1024 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/;

/**
 * Text that is safe to write to governor.log: for an Error only its name, code, reason and message size (messages can
 * carry script or argument text); any other value is a short status string built by the callers, never script text.
 */
function logText(detail) {
    if (detail instanceof Error) {
        const parts = [`name=${SAFE_TOKEN.test(detail.name) ? detail.name : 'Error'}`];
        for (const field of ['code', 'reason']) {
            const value = detail[field];
            if (typeof value === 'string' && SAFE_TOKEN.test(value)) parts.push(`${field}=${value}`);
        }
        parts.push(`messageBytes=${Buffer.byteLength(String(detail.message ?? ''))}`);
        return parts.join(' ');
    }
    return String(detail?.message ?? detail).replace(/\s+/g, ' ').slice(0, 500);
}

/** Keeps governor.log below about 1 MB: a larger file becomes governor.log.1 (one older file is kept). */
function rotateLog(file) {
    try {
        if (statSync(file).size <= MAX_LOG_BYTES) return;
    } catch {
        return; // no file yet
    }
    try { unlinkSync(`${file}.1`); } catch { /* none */ }
    renameSync(file, `${file}.1`);
}

/** Diagnostics file (never script text, never stdout). Never throws. */
function log(context, detail) {
    try {
        mkdirSync(LOGS_DIR, { recursive: true });
        const file = join(LOGS_DIR, 'governor.log');
        rotateLog(file);
        appendFileSync(file, `${new Date().toISOString()} ${context} ${logText(detail)}\n`, 'utf8');
    } catch {
        // logging must never break a decision
    }
}

/** Set once joinSession resolves; the hook can be called before that (fail-closed through the governor). */
let session = null;

const config = createConfigStore({
    rootDir: CONFIG_ROOT,
    copilotHome: COPILOT_HOME,
    clock,
    onWarning: (warning) => log('config-warning', `${warning.code} ${warning.file}: ${warning.message}`),
});
try {
    registerDirectoryPolicy(config);
    registerCatalogGroups(config);
} catch (err) {
    log('config-error', err); // the hook must still register: every governed call then asks (the engine reports an unavailable catalog)
}

let workerSettings = {};
try {
    workerSettings = config.get().governor?.worker ?? {};
} catch (err) {
    log('config-error', err); // defaults; the per-call path keeps asking while the config is unreadable
}
const worker = new PwshClient({
    pwshPath: typeof workerSettings.pwshPath === 'string' ? workerSettings.pwshPath : undefined,
    idleMs: Number.isFinite(workerSettings.idleMs) ? workerSettings.idleMs : undefined,
    clock,
    workerConfig: () => ({
        userHome: HOME,
        copilotHome: COPILOT_HOME,
        secretPatterns: [],
        systemRoots: [process.env.SystemRoot ?? 'C:\\Windows'],
        flagTable: flagTableOf(catalogFromGroups(config.get().groups)),
    }),
    onLog: (text) => log('worker', text),
});

const judge = createJudge({ config, clock, onLog: (entry) => log('judge', JSON.stringify(entry)) }); // sandbox and home: os.tmpdir()/shell-governor-judge
const audit = createAudit({ logsDir: LOGS_DIR, clock, onError: (err) => log('audit-error', err) });

const dialog = createDialog({
    ui: { elicitation: (params) => session.ui.elicitation(params) },
    clock,
    reviewsDir: REVIEWS_DIR,
    agentsDir: join(COPILOT_HOME, 'agents'),
    config: () => config.get().governor ?? {},
    // evaluated on every ask (session is set after joinSession). No session.ui.elicitation means no dialog; otherwise the
    // host's own flags (elicitation, canvases) are passed on, the rule is documented in lib/dialog.mjs
    capabilities: {
        get ui() {
            try {
                if (typeof session?.ui?.elicitation !== 'function') return { elicitation: false };
                return { ...session.capabilities?.ui };
            } catch {
                return { elicitation: false };
            }
        },
    },
    onError: (err) => log('dialog-error', err),
});

const governor = createGovernor({
    config,
    worker,
    judge,
    dialog,
    audit,
    sessionId: () => session?.sessionId,
    resolveMainAgentName: async () => (await session.rpc.agent.getCurrent())?.agent?.name,
    home: HOME,
    copilotHome: COPILOT_HOME,
    onError: (err, context) => log(`error:${context ?? 'governor'}`, err),
});

let stopping = null;
/** Stops accepting governed calls, then stops the worker and the judge process (idempotent). */
function shutdown() {
    governor.beginShutdown();
    stopping ??= Promise.allSettled([worker.stop(), judge.stop()]);
    return stopping;
}

const ASK_INTERNAL_ERROR = Object.freeze({ permissionDecision: 'ask', permissionDecisionReason: 'shell governor: internal error' });

/** The registered hook: any failure of the governor, synchronous or not, is an ASK. */
function onPreToolUse(input) {
    try {
        return Promise.resolve(governor.onPreToolUse(input)).catch((err) => {
            log('error:hook', err);
            return { ...ASK_INTERNAL_ERROR };
        });
    } catch (err) {
        log('error:hook', err);
        return Promise.resolve({ ...ASK_INTERNAL_ERROR });
    }
}

session = await joinSession({ hooks: { onPreToolUse } });
session.on((event) => {
    governor.onEvent(event);
    if (event?.type === 'session.shutdown') void shutdown();
});
