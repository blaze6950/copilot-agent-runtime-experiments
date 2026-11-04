// Commands the keeper queued itself (ladder actions with a `command`) and what can go wrong with them.
// The CLI may hold a queued slash command back (behind background work), and then it blocks the whole queue and suppresses
// assistant.idle. This module remembers which queue items are ours, reconciles enqueues that did not confirm, and unblocks
// (removes our command, then runs the first waiting user message or sends a keep-alive). It never removes an item that is not ours.
import { ACTION, FOLLOW_UP, KEEPER_EVENT } from "./contracts.mjs";
import { commandName, commandToken } from "./commands.mjs";
import { ladderExhausted } from "./policy.mjs";

/** Failed removals of the same own command in a row before the keeper backs off to slower re-checks (it never gives up on it). */
const MAX_REMOVE_FAILURES = 5;

/**
 * Is this pending item the command we queued: a command item whose name (first token, e.g. "/name") matches? Arguments may differ.
 * Live shape (CLI 1.0.98, commands.enqueue({command: "/probe-noop"})): {"id":"3","kind":"command","displayText":"/probe-noop","agentMode":"interactive"}.
 */
const isOurItem = (item, own) => item.kind === "command" && commandToken(item.displayText) === commandToken(own.text);

/** Does this user message / skill event mean that the command `own` has started to run? */
const isEchoOf = (own, text, skill) => (text !== null && text.startsWith(own.text)) || (skill && skill === commandName(own.text));

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./transport.mjs").createTransport>} deps.transport
 * @param {import("./contracts.mjs").KeeperConfig} deps.cfg
 * @param {(msg: string) => void} deps.log
 * @param {{unblocks: number}} deps.stats counters, updated here
 * @param {() => import("./contracts.mjs").TrackerState} deps.getState
 * @param {(event: object) => void} deps.track feed a KEEPER_EVENT to the tracker
 * @param {(action: string, text: string, actionId?: string|null) => void} deps.startAction count an injection and remember its text as our own
 * @param {(action: string, text: string, removed?: boolean, actionId?: string|null) => void} deps.refund give the counters of an injection that did not happen back
 * @param {(action: string) => Promise<boolean>} deps.sendKeepalive
 */
export function createOwnCommands({ transport, cfg, log, stats, getState, track, startAction, refund, sendKeepalive }) {
    /** Commands we queued that may still wait in the queue: queueId -> {action, text, actionId}. */
    const held = new Map();
    /** queueId -> number of failed removals in a row. */
    const removeFailures = new Map();
    /** Commands whose enqueue was unanswered and not yet reconciled with the queue: {action, text, actionId, timedOut, checks}. */
    const unconfirmed = [];

    // ---------- enqueue ----------
    /**
     * Queue a slash command. An accepted command is tracked and, if the CLI holds it back, checked again.
     * A rejected enqueue is refunded at once (nothing was queued); an unanswered one is reconciled with the queue.
     * @param {string} action ACTION.LADDER_ACTION
     * @param {string} command the command line
     * @param {(reply: {queued: boolean}) => string} describe log line for the reply
     * @param {string|null} [actionId] id of the ladder action
     * @returns {Promise<string>} a FOLLOW_UP value
     */
    async function enqueue(action, command, describe, actionId = null) {
        startAction(action, command, actionId);
        const reply = await transport.enqueueCommand(command);
        log(describe(reply));
        if (!reply.queued) return settleRejected({ action, text: command, actionId, timedOut: reply.timedOut === true, checks: 0 });
        if (reply.queueId === null) return FOLLOW_UP.NONE; // cannot be tracked
        const id = String(reply.queueId);
        held.set(id, { action, text: command, actionId });
        if (await stillPending(id)) return FOLLOW_UP.RECHECK;
        held.delete(id); // it started: its own events re-arm the timer
        return FOLLOW_UP.NONE;
    }
    /** Does the queue still hold the command (or is that unknown)? */
    async function stillPending(id) {
        const pending = await transport.pendingItems();
        return pending === null || pending.items.some((i) => String(i.id) === id);
    }

    // ---------- commands whose enqueue did not confirm ----------
    /** @returns {Promise<string>} a FOLLOW_UP value: retry after a refund, otherwise look at the queue again */
    async function settleRejected(entry) {
        if (!entry.timedOut) { refund(entry.action, entry.text, false, entry.actionId); return FOLLOW_UP.RETRY; } // definitely rejected: never adopt an item
        const pending = await transport.pendingItems();
        const outcome = pending === null ? "later" : reconcile(entry, pending.items); // unknown queue: stay unconfirmed
        if (outcome === "later") unconfirmed.push(entry);
        return outcome === "refunded" ? FOLLOW_UP.RETRY : FOLLOW_UP.RECHECK;
    }
    /**
     * Compare an unanswered enqueue with the queue. A matching untracked command item is ours (the decision to queue it was taken with an
     * empty queue, so nobody else can have put it there): adopt its id, the normal re-check/unblock path applies. Nothing matches: refund,
     * except that the item of an unanswered enqueue may not show up yet, so that gets one more look.
     * Accepted trade-off: after an enqueue timeout the keeper cannot tell its own command from the same command typed by the user in the
     * same ~20 s window, so it adopts the match. If that was the user's item, the unblock removes it and the removed action follows its
     * `ifRemoved` rule (a `retry` action is queued again later). (Needs a >5 s local RPC delay.)
     * @returns {"adopted"|"later"|"refunded"}
     */
    function reconcile(entry, items) {
        const found = items.find((i) => isOurItem(i, entry) && !held.has(String(i.id)));
        if (found) {
            held.set(String(found.id), { action: entry.action, text: entry.text, actionId: entry.actionId });
            log(`reconcile: adopted pending ${found.id} as our ${entry.text}`);
            return "adopted";
        }
        if (entry.timedOut && ++entry.checks < 2) return "later";
        refund(entry.action, entry.text, false, entry.actionId);
        return "refunded";
    }

    /**
     * Bring our bookkeeping in line with a queue that is actually known (never call it with an unknown queue):
     * settle unconfirmed commands, and forget held commands that are no longer in the queue (they run or are gone).
     * @param {object[]} items the pending queue items
     */
    function syncWithQueue(items) {
        for (const entry of unconfirmed.splice(0)) if (reconcile(entry, items) === "later") unconfirmed.push(entry);
        const inQueue = new Set(items.map((i) => String(i.id)));
        for (const id of held.keys()) if (!inQueue.has(id)) { held.delete(id); removeFailures.delete(id); }
    }

    /** The echo of one of our commands (user.message / skill.invoked) means it has started: stop tracking it. */
    function release(ev) {
        const text = ev.type === "user.message" && getState().lastUserMessageOwn ? String(ev.data?.content ?? "") : null;
        const skill = ev.type === "skill.invoked" ? ev.data?.name : null;
        for (const [id, own] of held) if (isEchoOf(own, text, skill)) held.delete(id);
        for (let i = unconfirmed.length - 1; i >= 0; i--) if (isEchoOf(unconfirmed[i], text, skill)) unconfirmed.splice(i, 1);
    }

    // ---------- unblock ----------
    /**
     * Take our command(s) out of the queue, then let the first foreign message run or send a keep-alive.
     * Withdrawing the removed command applies its action's `ifRemoved` rule in the tracker (retry: it runs again at the next deadline, at
     * most once per idle period; skip: it counts as done). The keep-alive that replaces it is not a ladder step.
     * An item that does not look like our command is never removed: a keep-alive refreshes the cache instead.
     * @param {import("./contracts.mjs").Snapshot} snapshot with a known queue
     * @returns {Promise<string>} a FOLLOW_UP value
     */
    async function unblock(snapshot) {
        const ownIds = snapshot.ownPendingIds;
        const removed = [], failed = [], skipped = [];
        for (const id of ownIds) {
            const item = snapshot.pendingItems.find((i) => String(i.id) === id);
            const own = held.get(id);
            if (!item || !own) continue;
            if (!isOurItem(item, own)) {
                log(`unblock skipped: pending item ${id} is not our ${own.text} (kind=${item.kind} displayText=${item.displayText})`);
                skipped.push(id);
                held.delete(id); // never removed, so nothing to re-check: it gets one keep-alive and is not tracked further
                removeFailures.delete(id);
            } else if (await removeConfirmed(id)) { removed.push(id); withdraw(id); } else failed.push(id);
        }
        if (failed.length) log(`unblock failed: could not remove ${failed.join(",")}${countRemoveFailures(failed) ? " (backing off: re-checking every 60 s)" : ""}`);
        if (!removed.length) return skipped.length ? keepaliveInstead(skipped) : (failed.length ? FOLLOW_UP.RECHECK : FOLLOW_UP.NONE);
        const message = snapshot.pendingItems.find((i) => i.kind === "message" && !ownIds.includes(String(i.id)));
        const next = (message && (await steer(message))) ? `sendNow:${message.id}` : (await sendKeepalive(ACTION.UNBLOCK)) ? "keepalive" : "none";
        log(`unblock removed=${removed.join(",")} then=${next}`);
        if (failed.length) return FOLLOW_UP.RECHECK;
        return next === "none" ? FOLLOW_UP.RETRY : FOLLOW_UP.NONE;
    }
    /** Remove our command; a failed or unanswered removal may still have gone through, so the queue decides. */
    async function removeConfirmed(id) {
        if (await transport.removeQueued(id)) return true;
        const pending = await transport.pendingItems();
        return pending !== null && !pending.items.some((i) => String(i.id) === id);
    }
    /**
     * Count one more failed removal per id. A command that keeps refusing stays held (it still blocks the queue), but after
     * MAX_REMOVE_FAILURES in a row the keeper backs off to slower re-checks (see `isBackingOff`), so it neither gives up nor floods the log.
     * @returns {boolean} true when at least one of the ids is now backing off
     */
    function countRemoveFailures(ids) {
        for (const id of ids) removeFailures.set(id, (removeFailures.get(id) ?? 0) + 1);
        return isBackingOff();
    }
    /** Do we keep re-checking a command that refused to be removed several times in a row? */
    const isBackingOff = () => [...removeFailures.values()].some((n) => n >= MAX_REMOVE_FAILURES);
    /** Nothing was removed because the pending item is not ours: refresh the cache with one keep-alive (while the ladder is not exhausted). */
    async function keepaliveInstead(skipped) {
        if (ladderExhausted(getState(), cfg)) {
            log(`unblock skipped=${skipped.join(",")} then=none (ladder exhausted)`);
            return FOLLOW_UP.NONE;
        }
        const sent = await sendKeepalive(ACTION.UNBLOCK);
        log(`unblock skipped=${skipped.join(",")} then=${sent ? "keepalive" : "none"}`);
        return sent ? FOLLOW_UP.NONE : FOLLOW_UP.RETRY;
    }
    /** Our command was removed from the queue: give its step back according to its action's `ifRemoved` rule. */
    function withdraw(id) {
        const own = held.get(id);
        held.delete(id);
        removeFailures.delete(id);
        if (own) refund(own.action, own.text, true, own.actionId);
    }
    async function steer(message) {
        const steered = await transport.sendNow(message.id);
        if (!steered) return false;
        track({ type: KEEPER_EVENT.MESSAGE_STEERED, data: { text: message.displayText } });
        stats.unblocks++;
        return true;
    }

    return {
        enqueue, unblock, syncWithQueue, release,
        /** @returns {string[]} queue ids of our commands that may still be pending */
        pendingIds: () => [...held.keys()],
        hasHeld: () => held.size > 0,
        hasUnconfirmed: () => unconfirmed.length > 0,
        isBackingOff,
    };
}
