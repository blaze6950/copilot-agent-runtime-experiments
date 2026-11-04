// Keeper of the cache-keeper: owns the timer and runs tracker -> policy -> transport -> state file.
// Keeps the root agent's prompt cache warm (idle ladder, wait mode) and wires in the two helpers that deal with trouble:
// unblock.mjs (a ladder command we queued, held back by the CLI) and rescue.mjs (a turn blocked in a long sync tool).
// Cache lifetime is measured from the START of a request, so every root request start sets a provisional expiry.
// One timer is armed whenever the expiry is known and in the future; when it fires the keeper looks at the session
// (processing, tasks, queue, agent) and executes what policy.decide() says. Fires are serialized: one decision at a time.
import { ACTION, FOLLOW_UP, KEEPER_EVENT, TRANSPORT_TIMEOUT } from "./contracts.mjs";
import { commandToken } from "./commands.mjs";
import { realClock } from "./config.mjs";
import { deadline, decide, ladderStep, planNext, waitEndReason } from "./policy.mjs";
import { createRescue } from "./rescue.mjs";
import { applyEvent, createTrackerState } from "./tracker.mjs";
import { createOwnCommands } from "./unblock.mjs";

const MIN_DELAY_MS = 1000;
/** Pause before looking at the queue again after queueing a command. */
const RECHECK_MS = 10_000;
/** Re-check interval for an own command whose removal keeps failing (it still blocks the queue, so the keeper never stops, but slows down). */
const BACKOFF_RECHECK_MS = 60_000;
/** Pause before retrying after a failed action or an unknown session state. */
const RETRY_MS = 10_000;
/**
 * A retry may fire until marginSec / RETRY_CUTOFF_DIVISOR before expiry: the first attempt already happens at expiresAt - marginSec, and a
 * request that starts before the expiry still refreshes the cache, so the last retry is kept close to (but not at) the expiry.
 */
const RETRY_CUTOFF_DIVISOR = 3;
const STAT_BY_ACTION = {
    [ACTION.KEEPALIVE]: "keepalives", [ACTION.WAIT_KEEPALIVE]: "waitKeepalives", [ACTION.LADDER_ACTION]: "actions", [ACTION.UNBLOCK]: "unblocks",
};
/** The step of a deadline at which nothing is planned. */
const NO_STEP = Object.freeze({ action: ACTION.NONE, actionId: null, index: null, skipped: [] });
/** NONE decisions that stem from a failed RPC: the state may be known a moment later, so try again before the cache expires. */
const UNKNOWN_STATE = new Set(["processing-unknown", "queue-unknown", "tasks-unknown"]);

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./transport.mjs").createTransport>} deps.transport
 * @param {import("./contracts.mjs").KeeperConfig} deps.cfg
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}} [deps.clock]
 * @param {(msg: string) => void} [deps.log]
 * @param {(state: import("./contracts.mjs").PublishedState) => void} [deps.writeState]
 * @returns {{onEvent: (event: object) => void, stats: object}}
 */
export function createKeeper({ transport, cfg, clock = realClock, log = () => {}, writeState = () => {} }) {
    let state = createTrackerState();
    const timer = { handle: null, at: null, recheck: false };
    let generation = 0; // bumped whenever the timer is re-armed or cleared: an in-flight decision from an older timer is stale
    let chain = Promise.resolve(); // fires run one after the other
    let lastNothing = null; // "<reason>@<expiry>" of the last "nothing to do" line, so retries do not repeat it
    let sendTimedOut = false; // the decision being executed sent a prompt that got no answer
    let lastAgentName = null; // agent of the last snapshot, for the status line's plan
    let lastRunningTaskCount = 0; // running tasks of the last known snapshot (kept when tasks.list failed), for the status line's plan
    const stats = { requests: 0, hits: 0, misses: 0, keepalives: 0, waitKeepalives: 0, actions: 0, rescues: 0, unrescued: 0, unblocks: 0 };

    const track = (event) => { state = applyEvent(state, event, clock.now(), cfg); };
    const secLeft = () => (state.expiresAt ? Math.round((state.expiresAt - clock.now()) / 1000) : null);
    const logFireError = (e) => log(`fire-error ${e?.stack ?? e}`);
    const totalSteps = () => cfg.ladder.keepalives + cfg.ladder.actions.length;

    // ---------- injections: count, remember as our own, give back ----------
    /** Count the action and remember its text as our own (before sending, so the echo is recognised). */
    const startAction = (action, text, actionId = null) => {
        stats[STAT_BY_ACTION[action]]++;
        track({ type: KEEPER_EVENT.ACTION_STARTED, data: { action, text, actionId } });
    };
    /** The injection did not happen after all (or was removed from the queue): give its counters back. */
    const refund = (action, text, removed = false, actionId = null) => track({ type: KEEPER_EVENT.COMMAND_WITHDRAWN, data: { action, text, removed, actionId } });

    /** Send `text` as a prompt for `action`. @returns {Promise<boolean>} false when the send failed (counters given back) */
    async function sendOwnPrompt(action, text, actionId = null) {
        startAction(action, text, actionId);
        const sent = await transport.sendPrompt(text);
        if (sent === TRANSPORT_TIMEOUT) { // no answer: it may still arrive, and sending it again would deliver it twice
            log(`${actionId ?? action} send timed out; assuming it was delivered, not retrying`);
            sendTimedOut = true; // ... but if it never arrives nothing would wake the keeper: fireOnce schedules a re-decision
            return true;
        }
        if (!sent) refund(action, text, false, actionId);
        return sent;
    }
    const sendKeepalive = (action) => sendOwnPrompt(action, cfg.keepaliveText);

    const ownCommands = createOwnCommands({ transport, cfg, log, stats, getState: () => state, track, startAction, refund, sendKeepalive });
    const rescue = createRescue({ transport, log, stats, getState: () => state, secLeft });

    /** What the status line calls a planned step. */
    const labelOf = (step) => {
        if (step.action === ACTION.NONE) return null;
        if (step.action !== ACTION.LADDER_ACTION) return "keepalive";
        const action = cfg.ladder.actions[step.index];
        return action.kind === "command" ? commandToken(action.text) : action.id;
    };
    /** 1-based position of a planned step among the keep-alives plus the actions. */
    const stepOf = (step) => {
        if (step.action === ACTION.KEEPALIVE) return state.keepalives + 1;
        return step.action === ACTION.LADDER_ACTION ? cfg.ladder.keepalives + step.index + 1 : null;
    };

    /** @returns {import("./contracts.mjs").PublishedState} */
    const published = () => {
        const toolRunning = state.inFlight.size > 0;
        const facts = { agentName: lastAgentName, runningTaskCount: lastRunningTaskCount };
        const planned = timer.handle && !timer.recheck && !toolRunning ? planNext(state, cfg, facts) : NO_STEP;
        return {
            idle: state.idle, expiresAt: state.expiresAt, provisional: state.provisional,
            nextAt: planned.action === ACTION.NONE ? null : timer.at, nextAction: planned.action === ACTION.NONE ? null : planned.action,
            nextLabel: labelOf(planned), step: stepOf(planned), steps: totalSteps(),
            ladderDone: facts.runningTaskCount === 0 && ladderStep(state, cfg, facts).action === ACTION.NONE,
            waitEnd: planned.action === ACTION.NONE && !toolRunning ? waitEndReason(state, cfg, facts) : null,
            rescueAt: timer.handle && !timer.recheck && toolRunning ? timer.at : null, busyTools: [...state.inFlight.values()].map((t) => t.name),
            keepalives: state.keepalives, waitRefreshes: state.waitRefreshes, maxWaitRefreshes: cfg.wait.maxRefreshes,
            contextTokens: state.contextTokens,
            lastRefreshAt: state.lastRefreshAt, lastRefreshKind: state.lastRefreshKind, lastRefreshNanoAiu: state.lastRefreshNanoAiu,
            lastRefreshSavedNanoAiu: state.lastRefreshSavedNanoAiu, lastRefreshMiss: state.lastRefreshMiss,
            stats, updatedAt: clock.now(),
        };
    };
    const publish = () => writeState(published());

    // ---------- the one timer ----------
    const disarm = () => {
        generation++;
        if (timer.handle) clock.clearTimeout(timer.handle);
        Object.assign(timer, { handle: null, at: null, recheck: false });
    };
    const schedule = (at, recheck) => {
        timer.at = at;
        timer.recheck = recheck;
        timer.handle = clock.setTimeout(onFire, at - clock.now());
    };
    /** Arm the deadline timer for the current expiry (or none when the expiry is unknown or past). */
    const armDeadline = () => {
        disarm();
        const now = clock.now();
        if (state.expiresAt && state.expiresAt > now) schedule(deadline(state, cfg, now), false);
        else if (mustWatchCommand()) schedule(now + heldRecheckMs(), true); // expired: still watch our own command
        publish();
    };
    /**
     * Past the expiry, is there a command of ours that still has to be watched? A held-back one, unless a root tool runs (the turn is in the
     * tool, not stuck behind the command; the tool's end re-arms us). An enqueue whose outcome is not known yet is watched also during a tool.
     */
    const mustWatchCommand = () => ownCommands.hasUnconfirmed() || (ownCommands.hasHeld() && state.inFlight.size === 0);
    /** Re-check interval for a held own command: slower once its removal keeps failing. */
    const heldRecheckMs = () => (ownCommands.isBackingOff() ? BACKOFF_RECHECK_MS : RECHECK_MS);
    /**
     * Arm a timer `delayMs` from now. `recheck`: only look at our own queued commands first.
     * Unless `unclamped`, only while a request can still refresh the cache (nothing when there is no time left): a retry may fire until
     * marginSec / RETRY_CUTOFF_DIVISOR before expiry, a re-check until 1 s before it. A re-check of a held-back own command is unclamped:
     * it must happen whatever the expiry, because that command blocks the queue and suppresses assistant.idle (nothing else would wake us).
     */
    const armLater = (delayMs, recheck, unclamped = false) => {
        disarm();
        const now = clock.now();
        const cutoffMs = recheck ? MIN_DELAY_MS : Math.max(MIN_DELAY_MS, (cfg.marginSec * 1000) / RETRY_CUTOFF_DIVISOR);
        const at = unclamped ? now + delayMs : Math.min(now + delayMs, (state.expiresAt ?? 0) - cutoffMs);
        if (at > now) schedule(at, recheck);
        publish();
    };
    /**
     * After a fire: a held-back own command is looked at again (every RECHECK_MS, or BACKOFF_RECHECK_MS once its removal keeps failing);
     * otherwise do what the executed decision asked for. `holdRecheck: false` (after a RESCUE) leaves it to the tool events to re-arm the
     * deadline: repeating the rescue every 10 s would be pointless.
     */
    function scheduleFollowUp(followUp, { holdRecheck = true } = {}) {
        if (ownCommands.hasUnconfirmed() || (holdRecheck && ownCommands.hasHeld())) armLater(heldRecheckMs(), true, true);
        else if (followUp === FOLLOW_UP.RECHECK) armLater(RECHECK_MS, true);
        else if (followUp === FOLLOW_UP.RETRY) armLater(RETRY_MS, false);
        else publish();
    }

    // ---------- timer fired: snapshot -> decide -> execute ----------
    function onFire() {
        const { recheck } = timer;
        Object.assign(timer, { handle: null, at: null, recheck: false });
        const fired = generation;
        chain = chain.then(() => runFire(recheck, fired)).catch(logFireError);
    }

    /** @returns {Promise<import("./contracts.mjs").Snapshot>} */
    async function takeSnapshot() {
        const [processing, runningTasks, pending, agentName] = await Promise.all([
            transport.isProcessing(), transport.listTasks(), transport.pendingItems(), transport.currentAgentName(),
        ]);
        if (pending) ownCommands.syncWithQueue(pending.items); // only when the queue is actually known
        lastAgentName = agentName;
        if (runningTasks) lastRunningTaskCount = runningTasks.length;
        return {
            now: clock.now(), processing, runningTasks, pendingItems: pending?.items ?? null, steeringCount: pending?.steeringCount ?? 0,
            ownPendingIds: ownCommands.pendingIds(), agentName,
        };
    }

    /** One fire. An unexpected error is logged and a fallback retry is armed, so the keeper is never left without a timer by a bug or a surprise. */
    async function runFire(recheck, fired) {
        try {
            await fireOnce(recheck, fired);
        } catch (e) {
            logFireError(e);
            if (fired === generation && !timer.handle) armLater(RETRY_MS, false);
        }
    }

    async function fireOnce(recheck, fired) {
        if (fired !== generation) return; // an event re-armed the timer while this fire waited: stale
        const snapshot = await takeSnapshot();
        if (fired !== generation) return; // ... or while we looked at the session
        const decision = decide(state, snapshot, cfg);
        // a command's fate is still open: do not act on a guess, look again (also after expiry). Only a rescue is exempt: it never touches the
        // queue, so it runs at a real deadline (not at every re-check, or it would repeat every 10 s).
        if (ownCommands.hasUnconfirmed() && (decision.action !== ACTION.RESCUE || recheck)) return armLater(heldRecheckMs(), true, true);
        if (recheck && !snapshot.ownPendingIds.length) return armDeadline(); // nothing held back: back to the normal deadline
        sendTimedOut = false;
        const executed = await execute(decision, snapshot);
        // an unanswered send is not resent, but a later re-decision covers the case that it never arrived (its turn, if it did, re-arms the timer)
        const followUp = executed === FOLLOW_UP.NONE && sendTimedOut ? FOLLOW_UP.RETRY : executed;
        if (fired !== generation) return publish(); // events during the execution armed the timer already
        scheduleFollowUp(followUp, { holdRecheck: decision.action !== ACTION.RESCUE });
    }

    /** @returns {Promise<string>} a FOLLOW_UP value */
    async function execute(d, snapshot) {
        switch (d.action) {
            case ACTION.RESCUE: await rescue(); return FOLLOW_UP.NONE;
            case ACTION.UNBLOCK: return ownCommands.unblock(snapshot);
            case ACTION.WAIT_KEEPALIVE: return fireWaitKeepalive(snapshot.runningTasks);
            case ACTION.KEEPALIVE: return fireKeepalive();
            case ACTION.LADDER_ACTION: return fireLadderAction(d);
            default: logNothing(d); return UNKNOWN_STATE.has(d.reason) ? FOLLOW_UP.RETRY : FOLLOW_UP.NONE;
        }
    }

    const NOTHING_LOG = {
        "busy-model": (d) => `busy-model: ${d.detail}; nothing to do cacheLeft=${secLeft()}s`,
        "processing-unknown": (d) => `skip: processing state unknown (${d.detail})`,
        "queue-unknown": (d) => `skip: queue state unknown (${d.detail})`,
        "tasks-unknown": (d) => `skip: task state unknown (${d.detail})`,
        "input-queued": () => "skip: input already queued",
        "wait-cap": () => `wait cap reached (${cfg.wait.maxRefreshes})`,
        "ladder-done": () => "ladder done", // the skipped actions are logged one line each by logSkipped
    };
    const logNothing = (d) => {
        const line = NOTHING_LOG[d.reason];
        const key = `${d.reason}@${state.expiresAt}`;
        if (!line || key === lastNothing) return;
        lastNothing = key;
        if (d.reason === "ladder-done") logSkipped(d);
        log(line(d));
    };
    const logSkipped = (d) => { for (const s of d.skipped) log(`action ${s.id} skipped: ${s.reason}`); };

    // ---------- the actions ----------
    async function fireWaitKeepalive(running) {
        const sent = await sendKeepalive(ACTION.WAIT_KEEPALIVE);
        if (!sent) return FOLLOW_UP.RETRY;
        log(`wait-keepalive #${state.waitRefreshes} running=${running.length} [${running.map((t) => `${t.type}:${t.id}`).join(",")}] cacheLeft=${secLeft()}s ctx=${state.contextTokens}`);
        return FOLLOW_UP.NONE;
    }
    async function fireKeepalive() {
        const sent = await sendKeepalive(ACTION.KEEPALIVE);
        if (!sent) return FOLLOW_UP.RETRY;
        log(`keepalive #${state.keepalives} cacheLeft=${secLeft()}s ctx=${state.contextTokens}`);
        return FOLLOW_UP.NONE;
    }
    /** Run the ladder action the decision picked: queue a command, or send a text as a prompt. */
    async function fireLadderAction(d) {
        logSkipped(d);
        const action = cfg.ladder.actions[d.index];
        if (!action || action.id !== d.actionId) {
            log(`action ${d.actionId} not in config`);
            return FOLLOW_UP.NONE;
        }
        const stepText = `${cfg.ladder.keepalives + d.index + 1}/${totalSteps()}`;
        if (action.kind === "command") {
            return ownCommands.enqueue(
                ACTION.LADDER_ACTION, action.text,
                (r) => `action ${action.id} step ${stepText} queued=${r.queued} cacheLeft=${secLeft()}s ctx=${state.contextTokens}`, action.id,
            );
        }
        const sent = await sendOwnPrompt(ACTION.LADDER_ACTION, action.text, action.id);
        if (!sent) return FOLLOW_UP.RETRY;
        log(`action ${action.id} step ${stepText} sent cacheLeft=${secLeft()}s ctx=${state.contextTokens}`);
        return FOLLOW_UP.NONE;
    }

    // ---------- events ----------
    const logUsage = () => {
        const u = state.lastUsage;
        stats.requests++;
        if (u.miss) stats.misses++; else stats.hits++;
        const delta = u.provisionalDeltaSec === null ? "-" : `${u.provisionalDeltaSec}s`;
        log(`req #${stats.requests} ${u.miss ? "MISS" : "hit"} ctx=${u.contextTokens} cr=${u.cacheRead} cw=${u.cacheWrite} gap=${u.gapSec}s after=${u.after} provisionalDelta=${delta}`);
    };
    const movesDeadline = (before) => before.expiresAt !== state.expiresAt || before.inFlight !== state.inFlight;

    /** Feed one CLI session event: update the tracked state, then re-arm the timer and publish as needed. */
    function onEvent(ev) {
        try {
            if (ev.agentId) return; // sub-agent events: only the root agent's cache matters
            const before = state;
            track(ev);
            if (ev.type === "session.shutdown") { disarm(); log(`shutdown stats=${JSON.stringify(stats)}`); return; }
            ownCommands.release(ev); // before the "unchanged" return: a skill.invoked that the tracker ignores still ends a command's wait
            if (state === before) return;
            if (ev.type === "assistant.usage" && state.lastUsage !== before.lastUsage) logUsage();
            if (movesDeadline(before)) armDeadline(); else publish();
        } catch (e) { log(`event-error ${ev?.type}: ${e?.stack ?? e}`); }
    }

    publish();
    return { onEvent, stats };
}
