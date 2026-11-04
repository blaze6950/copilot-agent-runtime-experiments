// Event tracker of the cache-keeper: folds CLI session events into a plain state object. Pure: no timers, no I/O.
import { ACTION, KEEPER_EVENT, REFRESH_KIND } from "./contracts.mjs";
import { commandName, commandToken } from "./commands.mjs";

const OWN_ECHO_WINDOW_MS = 60_000;
const REFRESH_KIND_BY_ACTION = {
    [ACTION.KEEPALIVE]: REFRESH_KIND.KEEPALIVE, [ACTION.WAIT_KEEPALIVE]: REFRESH_KIND.WAIT,
    [ACTION.LADDER_ACTION]: REFRESH_KIND.ACTION, [ACTION.UNBLOCK]: REFRESH_KIND.UNBLOCK,
};

/** @returns {import("./contracts.mjs").TrackerState} the state of a session that has not produced events yet */
export function createTrackerState() {
    return {
        idle: false, expiresAt: null, provisional: false, contextTokens: 0,
        keepalives: 0, waitRefreshes: 0, nextActionIndex: 0, changedSinceRun: {}, startedAction: null, retriedActionIds: [],
        inFlight: new Map(),
        requestStartedAt: null, lastUsageAt: null, idleSinceLastRequest: false,
        own: [], ownRequestKind: null, steered: [],
        lastRefreshAt: null, lastRefreshKind: null, lastRefreshNanoAiu: null, lastRefreshSavedNanoAiu: null, lastRefreshMiss: null,
        lastUsage: null, lastUserMessageOwn: null,
    };
}

/**
 * Apply one event. Sub-agent events are ignored: only the root agent's cache matters.
 * @param {import("./contracts.mjs").TrackerState} state never mutated
 * @param {{type: string, agentId?: string, data?: object}} event CLI session event or a KEEPER_EVENT
 * @param {number} now epoch ms
 * @param {import("./contracts.mjs").KeeperConfig} cfg
 * @returns {import("./contracts.mjs").TrackerState} a new state (the same object when the event changes nothing)
 */
export function applyEvent(state, event, now, cfg) {
    if (event.agentId) return state;
    const data = event.data ?? {};
    switch (event.type) {
        case "assistant.turn_start": return onTurnStart(state, now, cfg);
        case "assistant.usage": return onUsage(state, data, now, cfg);
        case "tool.execution_start": return onToolStart(state, data, now);
        case "tool.execution_complete": return onToolComplete(state, data);
        case "assistant.idle": return { ...state, idle: true, idleSinceLastRequest: true, inFlight: new Map() };
        case "user.message": return onUserMessage(state, String(data.content ?? ""), now, cfg);
        case "skill.invoked": return onSkillInvoked(state, String(data.name ?? ""), cfg);
        case "session.compaction_complete": return data.success && typeof data.postCompactionTokens === "number" ? { ...state, contextTokens: data.postCompactionTokens } : state;
        case KEEPER_EVENT.ACTION_STARTED: return onActionStarted(state, data, now, cfg);
        case KEEPER_EVENT.COMMAND_WITHDRAWN: return onCommandWithdrawn(state, data, cfg);
        case KEEPER_EVENT.MESSAGE_STEERED: return { ...state, steered: [...liveSteered(state, now), { text: String(data.text ?? ""), until: now + OWN_ECHO_WINDOW_MS }] };
        default: return state;
    }
}

const liveSteered = (state, now) => state.steered.filter((s) => s.until > now);

/**
 * A request is a cache miss when it mostly wrote cache and the prompt is big enough to matter.
 * @param {number} contextTokens
 * @param {number} cacheWriteTokens
 * @param {import("./contracts.mjs").KeeperConfig["miss"]} missCfg
 * @returns {boolean}
 */
export function isMiss(contextTokens, cacheWriteTokens, missCfg) {
    return contextTokens >= missCfg.minContextTokens && cacheWriteTokens > missCfg.writeRatio * contextTokens;
}

/** One root model request starts: its cache lifetime starts now, so expiry is provisional until usage confirms it. */
function onTurnStart(state, now, cfg) {
    return { ...state, idle: false, requestStartedAt: now, expiresAt: now + cfg.fallbackTtlSec * 1000, provisional: true };
}

/** Cost of one request in nano-AIU (the CLI's copilotUsage.totalNanoAiu), or null when the usage has none. */
const totalNanoAiuOf = (data) => {
    const v = data.copilotUsage?.totalNanoAiu;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
};

/** nano-AIU per token of one token type (costPerBatch / batchSize), or null when that entry is missing or malformed. */
function rateOf(details, tokenType) {
    const entry = details.find((d) => d?.tokenType === tokenType);
    const usable = entry && Number.isFinite(entry.costPerBatch) && Number.isFinite(entry.batchSize) && entry.batchSize > 0;
    return usable ? entry.costPerBatch / entry.batchSize : null;
}

/**
 * Gross saving of a request in nano-AIU: its cache reads at the cache_write rate minus the cache_read rate, both from
 * copilotUsage.tokenDetails. A 1-hour cache TTL is written at the cache_write_1h rate. Null when a rate is missing.
 */
function savedNanoAiuOf(data, cacheReadTokens) {
    const details = data.copilotUsage?.tokenDetails;
    if (!Array.isArray(details)) return null;
    const writeRate = rateOf(details, data.cacheTtlSeconds === 3600 ? "cache_write_1h" : "cache_write");
    const readRate = rateOf(details, "cache_read");
    return writeRate === null || readRate === null ? null : cacheReadTokens * (writeRate - readRate);
}

/**
 * The keeper's own request has come back: it records the cost and, unless it was a miss, the saving, and ends the ping.
 * A miss has no saving (the cache was written, not read).
 */
function refreshOf(state, data, now, miss, cacheReadTokens) {
    return {
        lastRefreshAt: now, lastRefreshKind: state.ownRequestKind, lastRefreshNanoAiu: totalNanoAiuOf(data),
        lastRefreshSavedNanoAiu: miss ? null : savedNanoAiuOf(data, cacheReadTokens), lastRefreshMiss: miss, ownRequestKind: null,
    };
}

function onUsage(state, data, now, cfg) {
    if (data.interactionType && data.interactionType !== "conversation-agent") return state;
    const reported = data.cacheExpiresAt ? Date.parse(data.cacheExpiresAt) : NaN;
    const expiresAt = Number.isFinite(reported) ? reported : now + cfg.fallbackTtlSec * 1000;
    const cacheRead = data.cacheReadTokens ?? 0, cacheWrite = data.cacheWriteTokens ?? 0;
    const contextTokens = Math.max(data.inputTokens ?? 0, cacheRead + cacheWrite);
    const miss = isMiss(contextTokens, cacheWrite, cfg.miss);
    const lastUsage = {
        miss, contextTokens, cacheRead, cacheWrite,
        gapSec: state.lastUsageAt ? Math.round((now - state.lastUsageAt) / 1000) : null,
        after: state.idleSinceLastRequest ? "idle" : "busy",
        provisionalDeltaSec: state.provisional && state.expiresAt ? Math.round((expiresAt - state.expiresAt) / 1000) : null,
    };
    // The ping is credited by its own request: a cache miss, or a request that read at least the miss threshold of tokens
    // (`miss.minContextTokens`, no separate key). A smaller auxiliary request leaves the ping pending.
    const ownRequest = miss || cacheRead >= cfg.miss.minContextTokens;
    const refreshed = state.ownRequestKind && ownRequest ? refreshOf(state, data, now, miss, cacheRead) : {};
    return { ...state, ...refreshed, expiresAt, provisional: false, contextTokens, lastUsage, lastUsageAt: now, idleSinceLastRequest: false };
}

function onToolStart(state, data, now) {
    if (!data.toolCallId) return state;
    const inFlight = new Map(state.inFlight).set(data.toolCallId, { name: data.toolName ?? "?", at: now, shellId: data.arguments?.shellId ?? null });
    return { ...state, inFlight };
}

function onToolComplete(state, data) {
    if (!data.toolCallId) return state;
    const inFlight = new Map(state.inFlight);
    inFlight.delete(data.toolCallId);
    return { ...state, inFlight };
}

/** An echo of a keeper injection leaves the ladder alone; anything else is the user: the ladder starts over. */
function onUserMessage(state, content, now, cfg) {
    const live = state.own.filter((o) => o.until > now);
    const index = live.findIndex((o) => content === o.text || content.startsWith(o.text));
    if (index >= 0) {
        return { ...state, own: live.filter((_, i) => i !== index), ownRequestKind: live[index].kind, lastUserMessageOwn: true };
    }
    const steered = liveSteered(state, now);
    const steeredAt = steered.findIndex((s) => content === s.text || content.startsWith(s.text));
    return {
        ...state, own: live, steered: steered.filter((_, i) => i !== steeredAt),
        ownRequestKind: steeredAt >= 0 ? REFRESH_KIND.UNBLOCK : null, lastUserMessageOwn: false,
        keepalives: 0, waitRefreshes: 0, nextActionIndex: 0, startedAction: null, retriedActionIds: [], changedSinceRun: changedFlagsAfter(content, cfg),
    };
}

/** Per action id: the user spoke since it last ran. A command typed by the user counts as running that command. */
const changedFlagsAfter = (content, cfg) =>
    Object.fromEntries(cfg.ladder.actions.map((a) => [a.id, !(a.kind === "command" && commandToken(content) === commandToken(a.text))]));

/** The CLI ran the skill of a command action by itself (`skill.invoked`): that action has nothing new to do. */
function onSkillInvoked(state, name, cfg) {
    const ranIds = cfg.ladder.actions
        .filter((a) => a.kind === "command" && commandName(a.text) === name && state.changedSinceRun[a.id] === true)
        .map((a) => a.id);
    if (!ranIds.length) return state;
    return { ...state, changedSinceRun: { ...state.changedSinceRun, ...Object.fromEntries(ranIds.map((id) => [id, false])) } };
}

/**
 * A keeper injection did not happen (rejected, send failed) or its queued command was removed before it ran: forget its echo and
 * give its counters back. A removed ladder action follows its `ifRemoved` rule (see `withdrawAction`).
 */
function onCommandWithdrawn(state, data, cfg) {
    const at = state.own.findIndex((o) => o.text === data.text);
    const own = state.own.filter((_, i) => i !== at);
    switch (data.action) {
        case ACTION.KEEPALIVE: return { ...state, own, keepalives: Math.max(0, state.keepalives - 1) };
        case ACTION.WAIT_KEEPALIVE: return { ...state, own, waitRefreshes: Math.max(0, state.waitRefreshes - 1) };
        case ACTION.LADDER_ACTION: return withdrawAction({ ...state, own }, data, cfg);
        default: return { ...state, own };
    }
}

/**
 * Give a withdrawn ladder action back: it is the next action again with the flag it had before. A rejected action is always given back;
 * a removed one only when its rule says `retry` and it was not given back before in this idle period (a second removal counts as done).
 * A withdrawal after a real user message (the ladder started over meanwhile) changes nothing.
 */
function withdrawAction(state, data, cfg) {
    const started = state.startedAction;
    if (!started || started.id !== data.actionId) return state;
    const removed = data.removed === true;
    const giveBack = !removed || (cfg.ladder.actions[started.index]?.ifRemoved === "retry" && !state.retriedActionIds.includes(started.id));
    if (!giveBack) return { ...state, startedAction: null };
    return {
        ...state, startedAction: null, nextActionIndex: started.index,
        changedSinceRun: { ...state.changedSinceRun, [started.id]: started.changedBefore },
        retriedActionIds: removed ? [...state.retriedActionIds, started.id] : state.retriedActionIds,
    };
}

/** The keeper is about to inject `data.text` for `data.action`: remember it as its own and count the step. */
function onActionStarted(state, data, now, cfg) {
    const own = [...state.own, { text: data.text, until: now + OWN_ECHO_WINDOW_MS, kind: REFRESH_KIND_BY_ACTION[data.action] ?? null }];
    switch (data.action) {
        case ACTION.KEEPALIVE: return { ...state, own, keepalives: state.keepalives + 1 };
        case ACTION.WAIT_KEEPALIVE: return { ...state, own, waitRefreshes: state.waitRefreshes + 1 };
        case ACTION.LADDER_ACTION: return startLadderAction(state, own, data.actionId, cfg);
        default: return { ...state, own }; // an unblock keep-alive is no ladder step: it only replaces the command that was removed
    }
}

/** The action is on its way: its flag is cleared and the ladder moves past it; `startedAction` remembers what a withdrawal has to restore. */
function startLadderAction(state, own, actionId, cfg) {
    const index = cfg.ladder.actions.findIndex((a) => a.id === actionId);
    if (index < 0) return { ...state, own };
    return {
        ...state, own, nextActionIndex: index + 1,
        startedAction: { id: actionId, index, changedBefore: state.changedSinceRun[actionId] === true },
        changedSinceRun: { ...state.changedSinceRun, [actionId]: false },
    };
}
