// Shared contracts of the cache-keeper: frozen enums and JSDoc typedefs. No imports, no runtime dependencies.

/** What the keeper can do. The string values are published in the state file (`nextAction`), so keep them stable. */
export const ACTION = Object.freeze({
    KEEPALIVE: "keepalive", WAIT_KEEPALIVE: "wait", LADDER_ACTION: "action", RESCUE: "rescue", UNBLOCK: "unblock", NONE: "none",
});

/** Why a root request was started by the keeper (published as `lastRefreshKind`). */
export const REFRESH_KIND = Object.freeze({ KEEPALIVE: "keepalive", WAIT: "wait", ACTION: "action", UNBLOCK: "unblock" });

/**
 * What `transport.sendPrompt` returns when the session did not answer in time: the prompt may still be delivered, so the caller must not
 * send it again. (Other transport calls report a timeout as their safe default, except `enqueueCommand`, which sets `timedOut: true`.)
 */
export const TRANSPORT_TIMEOUT = "timeout";

/** What has to happen after a decision was executed. */
export const FOLLOW_UP = Object.freeze({ NONE: "none", RECHECK: "recheck", RETRY: "retry" });

/** Event types the keeper feeds into the tracker itself (everything else is a CLI session event). */
export const KEEPER_EVENT = Object.freeze({
    /** The keeper is about to inject a prompt/command: `data = {action, text, actionId?}`. */
    ACTION_STARTED: "keeper.action_started",
    /** An injection did not happen (command rejected, send failed) or was removed from the queue before it ran: `data = {action, text, removed?, actionId?}`; its counters are given back (a removed ladder action follows its `ifRemoved` rule). */
    COMMAND_WITHDRAWN: "keeper.command_withdrawn",
    /** A foreign queued message was steered into the live turn by an UNBLOCK: `data = {text}`; its request is labelled `unblock`. */
    MESSAGE_STEERED: "keeper.message_steered",
});

/**
 * Effective configuration (DEFAULTS merged with config.json).
 * @typedef {object} KeeperConfig
 * @property {boolean} enabled
 * @property {number} marginSec seconds before expiry at which a refresh fires
 * @property {number} fallbackTtlSec assumed cache lifetime when the CLI reports no expiry
 * @property {string} keepaliveText prompt sent as a keep-alive
 * @property {{keepalives: number, actions: LadderAction[]}} ladder keep-alives first, then the actions in list order
 * @property {{enabled: boolean, marginSec: number}} rescue
 * @property {{countdown: boolean}} statusLine status-line options (read by statusline.mjs on every refresh, not by the keeper)
 * @property {{enabled: boolean, maxRefreshes: number}} wait
 * @property {{writeRatio: number, minContextTokens: number}} miss
 * @property {string[]} problems config problems, logged once at start
 */

/**
 * One step of the idle ladder after the keep-alives, as normalized by `normalizeLadder`.
 * @typedef {object} LadderAction
 * @property {string} id unique name of the action
 * @property {"command"|"text"} kind a slash command queued as a command, or a prompt sent as text
 * @property {string} text the command line or the prompt
 * @property {{changedSinceLastRun: boolean, agents: string[]|null, minContextTokens: number}} when conditions that must all hold
 * @property {"retry"|"skip"} ifRemoved what a removal from the queue means: run again (once per idle period) or count as done
 */

/**
 * What the idle ladder does at one deadline.
 * @typedef {object} LadderStep
 * @property {string} action ACTION.KEEPALIVE, ACTION.LADDER_ACTION or ACTION.NONE
 * @property {string|null} actionId id of the ladder action to run
 * @property {number|null} index position of that action in `ladder.actions`
 * @property {Array<{id: string, reason: string}>} skipped actions passed over at this deadline, with their reasons
 */

/**
 * Everything the tracker knows about the root agent, derived from session events only.
 * @typedef {object} TrackerState
 * @property {boolean} idle root agent finished its turn and waits for input
 * @property {number|null} expiresAt epoch ms at which the prompt cache expires
 * @property {boolean} provisional expiresAt is an estimate from the request start, not yet confirmed by usage
 * @property {number} contextTokens size of the last root prompt
 * @property {number} keepalives ladder keep-alives taken since the last real user message
 * @property {number} waitRefreshes wait-mode keep-alives since the last real user message
 * @property {number} nextActionIndex index in `ladder.actions` at which the next action is looked for
 * @property {Object<string, boolean>} changedSinceRun per action id: the user spoke since the action last ran
 * @property {{id: string, index: number, changedBefore: boolean}|null} startedAction the ladder action that was started last and may still be withdrawn
 * @property {string[]} retriedActionIds ids of `retry` actions that were already given back once in this idle period
 * @property {Map<string, {name: string, at: number, shellId: string|null}>} inFlight running root tool calls by toolCallId
 * @property {number|null} requestStartedAt epoch ms of the last root request start
 * @property {number|null} lastUsageAt epoch ms of the last root usage event
 * @property {boolean} idleSinceLastRequest the root went idle after its previous request
 * @property {Array<{text: string, until: number, kind: string|null}>} own injected texts waiting for their echo
 * @property {string|null} ownRequestKind kind of the keeper request that is running now (until its usage arrives)
 * @property {number|null} lastRefreshAt epoch ms of the usage of the last keeper-started request
 * @property {string|null} lastRefreshKind REFRESH_KIND of that request
 * @property {number|null} lastRefreshNanoAiu cost (nano-AIU, copilotUsage.totalNanoAiu) of the first root request after the last keeper injection's echo; null when the usage had no cost
 * @property {number|null} lastRefreshSavedNanoAiu gross saving of that request in nano-AIU (cache reads at the write rate minus the read rate, from tokenDetails); null on a miss or without rates
 * @property {boolean|null} lastRefreshMiss that request was a cache miss; null before the first credited request
 * @property {object|null} lastUsage details of the last root usage (hit/miss, gap, ...); a new object per usage
 * @property {boolean|null} lastUserMessageOwn whether the last user.message was an echo of a keeper injection
 * @property {Array<{text: string, until: number}>} steered foreign messages the keeper steered in (UNBLOCK), waiting for their user.message
 */

/**
 * Point-in-time view of the session as seen through the transport.
 * @typedef {object} Snapshot
 * @property {number} now epoch ms when the snapshot was taken
 * @property {boolean|null} processing the CLI is processing a turn (null when unknown)
 * @property {object[]|null} runningTasks running background tasks (null when tasks.list failed)
 * @property {object[]|null} pendingItems queued user-facing items `{id, kind, displayText, ...}` (null when queue.pendingItems failed)
 * @property {number} steeringCount steering messages waiting to be delivered
 * @property {string[]} ownPendingIds queue ids of items the keeper queued itself that are still pending
 * @property {string|null} agentName current agent
 */

/**
 * One policy decision.
 * @typedef {object} Decision
 * @property {string} action value of ACTION
 * @property {string} reason short machine-readable reason
 * @property {string} detail short human-readable detail for the log
 * @property {string|null} actionId id of the ladder action to run (LADDER_ACTION only)
 * @property {number|null} index position of the action in ladder.actions (LADDER_ACTION only, else null)
 * @property {Array<{id: string, reason: string}>} skipped ladder actions passed over at this deadline
 */

/**
 * State file content, read by the status line.
 * @typedef {object} PublishedState
 * @property {boolean} idle
 * @property {number|null} expiresAt
 * @property {boolean} provisional
 * @property {number|null} nextAt epoch ms of the next scheduled keeper action
 * @property {string|null} nextAction value of ACTION scheduled at nextAt
 * @property {string|null} nextLabel what the next step is called in the status line ("keepalive", a command token or an action id)
 * @property {number|null} step 1-based position of the next step among keep-alives plus actions (null when none is planned)
 * @property {number} steps number of keep-alives plus actions
 * @property {boolean} ladderDone the ladder has nothing left to do and no background task ran at the last snapshot (the status line then shows "ladder done, waiting for you")
 * @property {"cap"|"off"|null} waitEnd why nothing is sent although a background task ran at the last snapshot: "cap" wait keep-alives used up, "off" wait mode disabled and the ladder done; null otherwise
 * @property {number|null} rescueAt
 * @property {string[]} busyTools names of running root tools
 * @property {number} keepalives
 * @property {number} waitRefreshes
 * @property {number} maxWaitRefreshes
 * @property {number} contextTokens
 * @property {number|null} lastRefreshAt epoch ms of the assistant.usage of the last keeper-started request
 * @property {string|null} lastRefreshKind REFRESH_KIND of that request
 * @property {number|null} lastRefreshNanoAiu cost of that request in nano-AIU (dollars = value / 1e11)
 * @property {number|null} lastRefreshSavedNanoAiu gross saving of that request in nano-AIU; null on a miss, without rates, or in state files from before this field
 * @property {boolean|null} lastRefreshMiss that request was a cache miss
 * @property {object} stats counters since start
 * @property {number} updatedAt
 */
