// Pure decision rules of the cache-keeper. No I/O, no timers.
// decide(): the single decision table for one deadline. Ladder: `ladder.keepalives` keep-alives, then the actions of `ladder.actions` in JSON
// order, one per deadline (an action whose conditions fail is skipped at the same deadline); wait-mode keep-alives while background tasks run.
// (Rescue of a blocked turn: rescue.mjs.)
//
// Rows of decide(), first answer wins:
//   1 expired            cache already gone and none of our commands is held back -> NONE
//   2 rootToolInFlight   a root tool blocks the turn                          -> RESCUE (NONE when rescue is off)
//   3 modelBusy          isProcessing() === true                              -> NONE (a held own command is re-checked, see keeper)
//   4 processingUnknown  isProcessing() unknown and no assistant.idle since the last request -> NONE (AC-9: act only on today's rule)
//   5 queueUnknown       queue.pendingItems failed                            -> NONE (cannot tell what waits in the queue)
//   6 ownCommandPending  a command the keeper queued is still pending         -> UNBLOCK, also after the cache expired
//   7 foreignInputPending the user queued something                           -> NONE
//   8 tasksUnknown       tasks.list failed                                    -> NONE (cannot tell whether a task runs)
//   9 backgroundTasks    a task is running                                    -> WAIT_KEEPALIVE until wait.maxRefreshes, then NONE
//  10 ladder             KEEPALIVE (until ladder.keepalives) | LADDER_ACTION (next action whose conditions hold) | NONE
// A held-back own command is always unblocked, whatever the expiry: it blocks the whole queue and suppresses assistant.idle, and the
// keep-alive that follows re-warms the cache. That is why row 1 yields to it, while the unknown rows (3-5) still come first: the keeper
// never removes anything blindly.
// processingUnknown sits before ownCommandPending on purpose: with a broken isProcessing and no assistant.idle the keeper cannot tell a
// held-back command from a turn in progress, so a held-back own command is NOT unblocked until the situation is known again (the keeper
// re-checks every 10 s meanwhile).
import { ACTION } from "./contracts.mjs";

const MIN_DELAY_MS = 1000;

/**
 * When the keeper has to act next: `marginSec` before the cache expires (`rescue.marginSec` while a root tool blocks the turn),
 * never earlier than one second from now.
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @param {number} now epoch ms
 * @returns {number|null} epoch ms, or null when the expiry is unknown
 */
export function deadline(state, cfg, now) {
    if (!state.expiresAt) return null;
    const marginSec = state.inFlight.size ? cfg.rescue.marginSec : cfg.marginSec;
    return Math.max(now + MIN_DELAY_MS, state.expiresAt - marginSec * 1000);
}

const decision = (action, reason, detail = "", extra = {}) => ({ action, reason, detail, actionId: null, index: null, skipped: [], ...extra });

/**
 * Why a ladder action cannot run now, checked in this order: nothing changed since it last ran, wrong agent, too little context, or a
 * background task is running (commands only: a command queued behind running work is held back by the CLI).
 * @param {import("./contracts.mjs").LadderAction} action
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {{agentName: string|null, runningTaskCount: number}} facts
 * @returns {string|null} the reason, or null when the action may run
 */
export function actionBlocker(action, state, facts) {
    if (action.when.changedSinceLastRun && state.changedSinceRun[action.id] !== true) return "unchanged since last run";
    if (action.when.agents && !action.when.agents.includes(facts.agentName)) return `agent=${facts.agentName ?? "default"}`;
    if (state.contextTokens < action.when.minContextTokens) return `context ${state.contextTokens} < ${action.when.minContextTokens}`;
    if (action.kind === "command" && facts.runningTaskCount > 0) return `${facts.runningTaskCount} background task(s) running`;
    return null;
}

/**
 * The ladder step for one deadline: a keep-alive while `ladder.keepalives` is not reached, then the first action from `nextActionIndex`
 * whose conditions hold (the ones before it are listed as skipped), then NONE.
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @param {{agentName: string|null, runningTaskCount: number}} facts
 * @returns {import("./contracts.mjs").LadderStep}
 */
export function ladderStep(state, cfg, facts) {
    if (state.keepalives < cfg.ladder.keepalives) return { action: ACTION.KEEPALIVE, actionId: null, index: null, skipped: [] };
    const skipped = [];
    for (let i = state.nextActionIndex; i < cfg.ladder.actions.length; i++) {
        const action = cfg.ladder.actions[i];
        const reason = actionBlocker(action, state, facts);
        if (reason === null) return { action: ACTION.LADDER_ACTION, actionId: action.id, index: i, skipped };
        skipped.push({ id: action.id, reason });
    }
    return { action: ACTION.NONE, actionId: null, index: null, skipped };
}

/** All keep-alives are sent and every action has been passed (run or counted as done). */
export const ladderExhausted = (state, cfg) =>
    state.keepalives >= cfg.ladder.keepalives && state.nextActionIndex >= cfg.ladder.actions.length;

/** The step of a forecast with nothing planned. */
const NOTHING_PLANNED = Object.freeze({ action: ACTION.NONE, actionId: null, index: null, skipped: [] });

/**
 * Next idle step for the tracked state, as decide() takes it at the next deadline for a snapshot with `facts.runningTaskCount` running
 * tasks (what the status line announces). A running task with wait enabled gives a wait keep-alive until the cap, then nothing (decide()
 * row 9, which comes before the ladder). Otherwise the ladder step; nothing once the ladder is done, because wait keep-alives are sent
 * only while a background task runs.
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @param {{agentName: string|null, runningTaskCount: number}} facts
 * @returns {import("./contracts.mjs").LadderStep} KEEPALIVE, LADDER_ACTION, WAIT_KEEPALIVE or NONE
 */
export function planNext(state, cfg, facts) {
    if (facts.runningTaskCount > 0 && cfg.wait.enabled) {
        return state.waitRefreshes < cfg.wait.maxRefreshes ? { action: ACTION.WAIT_KEEPALIVE, actionId: null, index: null, skipped: [] } : NOTHING_PLANNED;
    }
    return ladderStep(state, cfg, facts);
}

/**
 * Why nothing is sent while a background task runs: "cap" (wait keep-alives used up), "off" (wait mode disabled and the ladder has
 * nothing left), else null. Same rows as planNext() for a running task.
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @param {{agentName: string|null, runningTaskCount: number}} facts
 * @returns {"cap"|"off"|null}
 */
export function waitEndReason(state, cfg, facts) {
    if (facts.runningTaskCount === 0) return null;
    if (cfg.wait.enabled) return state.waitRefreshes >= cfg.wait.maxRefreshes ? "cap" : null;
    return ladderStep(state, cfg, facts).action === ACTION.NONE ? "off" : null;
}

// ---------- decide(): rows are tried in order, the first one that answers wins ----------
const isOwn = (ctx, item) => ctx.snapshot.ownPendingIds.includes(String(item.id));
const ownHeld = (ctx) => (ctx.snapshot.pendingItems ?? []).some((i) => isOwn(ctx, i));

const expired = (ctx) =>
    (!ctx.state.expiresAt || ctx.state.expiresAt <= ctx.snapshot.now) && !ownHeld(ctx) ? decision(ACTION.NONE, "expired", "cache already expired") : null;

const rootToolInFlight = ({ state, cfg }) => {
    if (!state.inFlight.size) return null;
    return cfg.rescue.enabled ? decision(ACTION.RESCUE, "root-tool") : decision(ACTION.NONE, "rescue-disabled");
};

const modelBusy = ({ snapshot }) =>
    snapshot.processing === true ? decision(ACTION.NONE, "busy-model", "model is processing and no root tool is running") : null;

const processingUnknown = ({ state, snapshot }) =>
    snapshot.processing === null && !state.idleSinceLastRequest
        ? decision(ACTION.NONE, "processing-unknown", "isProcessing unavailable and no assistant.idle since the last request") : null;

const queueUnknown = ({ snapshot }) =>
    snapshot.pendingItems === null ? decision(ACTION.NONE, "queue-unknown", "queue.pendingItems unavailable") : null;

const ownCommandPending = (ctx) => {
    const own = ctx.snapshot.pendingItems.filter((i) => isOwn(ctx, i));
    return own.length ? decision(ACTION.UNBLOCK, "own-command-pending", own.map((i) => i.id).join(",")) : null;
};

const foreignInputPending = (ctx) =>
    ctx.snapshot.pendingItems.length || ctx.snapshot.steeringCount ? decision(ACTION.NONE, "input-queued") : null;

const tasksUnknown = ({ snapshot }) =>
    snapshot.runningTasks === null ? decision(ACTION.NONE, "tasks-unknown", "tasks.list unavailable") : null;

const backgroundTasks = ({ state, snapshot, cfg }) => {
    if (!snapshot.runningTasks.length || !cfg.wait.enabled) return null;
    return state.waitRefreshes < cfg.wait.maxRefreshes ? decision(ACTION.WAIT_KEEPALIVE, "tasks-running") : decision(ACTION.NONE, "wait-cap");
};

const ladder = (ctx) => {
    const step = ladderStep(ctx.state, ctx.cfg, { agentName: ctx.snapshot.agentName, runningTaskCount: ctx.snapshot.runningTasks.length });
    const extra = { actionId: step.actionId, index: step.index, skipped: step.skipped };
    if (step.action === ACTION.KEEPALIVE) return decision(ACTION.KEEPALIVE, "ladder", "", extra);
    if (step.action === ACTION.LADDER_ACTION) return decision(ACTION.LADDER_ACTION, "ladder-action", step.actionId, extra);
    return decision(ACTION.NONE, "ladder-done", step.skipped.map((s) => `${s.id}: ${s.reason}`).join("; "), extra);
};

const DECISION_TABLE = [
    expired, rootToolInFlight, modelBusy, processingUnknown, queueUnknown, ownCommandPending, foreignInputPending, tasksUnknown, backgroundTasks, ladder,
];

/**
 * What to do at the deadline.
 * @param {import("./contracts.mjs").TrackerState} state
 * @param {import("./contracts.mjs").Snapshot} snapshot
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @returns {import("./contracts.mjs").Decision}
 */
export function decide(state, snapshot, cfg) {
    const ctx = { state, snapshot, cfg };
    for (const row of DECISION_TABLE) {
        const d = row(ctx);
        if (d) return d;
    }
    return decision(ACTION.NONE, "ladder-done");
}
