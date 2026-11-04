// Transport of the cache-keeper: the only module that talks to the CLI session.
// Every method catches errors, bounds the call with a timeout, logs a failure and returns a safe default.
import { TRANSPORT_TIMEOUT } from "./contracts.mjs";

/** A single RPC that does not answer within this time counts as failed (so one hung call cannot wedge the keeper). */
export const DEFAULT_TIMEOUT_MS = 5000;
/** The same error/timeout tag is logged at most once per this window (retries would otherwise repeat it). */
export const LOG_WINDOW_MS = 60_000;

const TIMED_OUT = Symbol("timed-out");

/**
 * @param {object} session Copilot CLI session (`send` + `rpc` namespaces)
 * @param {(msg: string) => void} [log]
 * @param {{timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function, now?: () => number}} [options] timer source and clock (tests inject a fake)
 */
export function createTransport(session, log = () => {}, options = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS, setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout, now = Date.now,
    } = options;
    /** key -> {at, suppressed}: last time a line with this key was logged and how many were held back since. */
    const lastLogged = new Map();
    const logOnce = (key, text) => {
        const entry = lastLogged.get(key);
        if (entry && now() - entry.at < LOG_WINDOW_MS) { entry.suppressed++; return; }
        lastLogged.set(key, { at: now(), suppressed: 0 });
        log(`${key} ${text}${entry?.suppressed ? ` (+${entry.suppressed} suppressed)` : ""}`);
    };
    /**
     * Wrap `fn` so that a failure is logged as `<tag>-error ...` and `fallback()` is returned instead. A hang is logged as `<tag>-timeout ...`
     * and `onTimeout()` is returned: for calls that change the session it differs from `fallback()`, because the call may still have
     * taken effect and the caller has to reconcile.
     */
    const safe = (tag, fallback, fn, onTimeout = fallback) => async (...args) => {
        let handle;
        const timeout = new Promise((resolve) => { handle = startTimer(() => resolve(TIMED_OUT), timeoutMs); handle?.unref?.(); });
        try {
            const result = await Promise.race([fn(...args), timeout]);
            if (result !== TIMED_OUT) return result;
            logOnce(`${tag}-timeout`, `no answer after ${timeoutMs}ms`);
            return onTimeout();
        } catch (e) {
            logOnce(`${tag}-error`, e?.message ?? e);
        } finally {
            stopTimer(handle);
        }
        return fallback();
    };
    /** A reply of the wrong shape is an unknown state, not an empty one: the keeper must not act as if nothing were queued or running. */
    const asArray = (value, what) => {
        if (!Array.isArray(value)) throw new Error(`malformed ${what} reply`);
        return value;
    };
    const allTasks = async () => asArray((await session.rpc.tasks.list())?.tasks, "tasks.list");
    const isRunning = (t) => t.status === "running";
    const isPromotable = (t) => isRunning(t) && t.executionMode === "sync" && t.canPromoteToBackground !== false;

    const listPromotableTasks = safe("tasks-list", () => [], async () => (await allTasks()).filter(isPromotable));
    const currentPromotableTask = safe("promotable", () => [], async () => {
        const task = (await session.rpc.tasks.getCurrentPromotable())?.task;
        return task ? [task] : [];
    });

    return {
        /** Send a prompt as a new user turn. @returns {Promise<boolean|"timeout">} true when sent, false on failure, TRANSPORT_TIMEOUT when unanswered (it may still arrive) */
        sendPrompt: safe("send-prompt", () => false, async (text) => { await session.send({ prompt: text }); return true; }, () => TRANSPORT_TIMEOUT),

        /** Queue a slash command. @returns {Promise<{queued: boolean, queueId: string|null, timedOut?: boolean}>} `timedOut`: unanswered, the command may be queued anyway */
        enqueueCommand: safe("enqueue-command", () => ({ queued: false, queueId: null }), async (command) => {
            const r = await session.rpc.commands.enqueue({ command });
            return { queued: r?.queued === true, queueId: r?.queueId ?? null };
        }, () => ({ queued: false, queueId: null, timedOut: true })),

        /** Queued user-facing items and the number of steering messages. @returns {Promise<{items: object[], steeringCount: number}|null>} null when unknown */
        pendingItems: safe("pending-items", () => null, async () => {
            const q = await session.rpc.queue.pendingItems();
            return { items: asArray(q?.items, "queue.pendingItems"), steeringCount: q?.steeringMessages?.length ?? 0 };
        }),

        /** Remove a queued item by id. @returns {Promise<boolean>} */
        removeQueued: safe("remove-queued", () => false, async (id) => (await session.rpc.queue.removeAt({ id }))?.removed === true),

        /** Steer a queued item into the live turn. @returns {Promise<boolean>} */
        sendNow: safe("send-now", () => false, async (id) => (await session.rpc.queue.sendNow({ id }))?.steered === true),

        /** Running background tasks (agents and shells). @returns {Promise<object[]|null>} null when unknown */
        listTasks: safe("tasks-list", () => null, async () => (await allTasks()).filter(isRunning)),

        /** Sync tasks that could move to the background; falls back to the CLI's current promotable task. */
        async promotableCandidates() {
            const tasks = await listPromotableTasks();
            return tasks.length ? tasks : currentPromotableTask();
        },

        /** Move a task to the background. @returns {Promise<boolean>} */
        promote: safe("promote", () => false, async (id) => (await session.rpc.tasks.promoteToBackground({ id }))?.promoted === true),

        /** Whether the CLI is processing a turn. @returns {Promise<boolean|null>} null when unknown */
        isProcessing: safe("is-processing", () => null, async () => {
            const processing = (await session.rpc.metadata.isProcessing())?.processing;
            return typeof processing === "boolean" ? processing : null;
        }),

        /** Name of the current agent. @returns {Promise<string|null>} */
        currentAgentName: safe("current-agent", () => null, async () => (await session.rpc.agent.getCurrent())?.agent?.name ?? null),
    };
}
