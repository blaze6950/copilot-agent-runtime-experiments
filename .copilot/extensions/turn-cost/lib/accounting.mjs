// Accounting of the turn-cost extension: turns the event stream of a session into turn blocks and agent blocks.
// Pure state machine, no I/O. The caller feeds every session event to `apply` and writes the blocks it returns.
// Which block becomes ready when (design: plan-tasks-r16.md, assumptions A-1..A-4):
//   - a real root turn (user prompt, agent notice, keeper command) yields one turn block at the root `session.idle`;
//   - a keep-alive turn yields no block; its cost is carried to the next turn block and is part of the session total;
//   - a sub-agent still running at its turn's block yields its own agent block when it finishes (after the open turn's block if a turn is open then).

import { KEEPALIVE_PREFIX, NANO_AIU_PER_USD, ROOT_AGENT, STATUS, TURN_TRIGGER } from "./contracts.mjs";
import { exclusiveMs, unionMs } from "./intervals.mjs";

const DIALOG_EVENT = /^(permission|elicitation|user_input)\.(requested|completed)$/;
const PRE_TOOL_USE = "preToolUse";
const UNKNOWN_AGENT = "unknown";
const DEFAULT_AGENT = "agent";
/** Ended sub-agent keys kept so that a repeated end event writes nothing; the oldest key is forgotten beyond this count. */
const SETTLED_AGENT_KEYS_LIMIT = 64;

/** @returns {number} the value when it is a finite number, else 0 */
const finiteOrZero = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const isObject = (value) => value !== null && typeof value === "object";

/**
 * One agent's running figures over its lifetime (root: over one turn).
 * @param {string} key agentId, or ROOT_AGENT
 * @param {string} agent
 * @param {number} startMs
 */
function newRecord(key, agent, startMs) {
    return {
        key, agent, task: null, models: [], status: STATUS.RUNNING, startMs, endMs: null,
        req: 0, nanoAiu: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, llmMs: 0, ttftSumMs: 0, ttftCount: 0,
        toolWindows: [], govWindows: [], waitWindows: [],
    };
}

/**
 * Creates one accounting for one session (one extension process).
 * @returns {{apply: (event: object, nowMs: number) => object[], sessionUsd: () => number, memory: () => object}}
 */
export function createAccounting() {
    /** Sub-agent records by agentId (running, or finished and not yet reported). */
    const subAgents = new Map();
    const taskNameByToolCallId = new Map();
    const agentKeyByToolCallId = new Map();
    const openTools = new Map();
    const openHooks = new Map();
    const openDialogs = new Map();
    /** Sub-agents that finished while a turn was open and have no row in it: written after that turn's block. */
    let deferredRecords = [];
    /** Sub-agents whose block is ready or written (or whose row is in a closed turn): a later end event for them writes nothing. */
    const settledKeys = new Set();
    let keepalive = { count: 0, nanoAiu: 0 };
    let turnNumber = 0;
    let totalNanoAiu = 0;
    /** The open root turn: {isKeepalive, trigger, startMs, root, subAgents}. */
    let turn = null;

    const sessionUsd = () => totalNanoAiu / NANO_AIU_PER_USD;

    function recordOf(key) {
        return key === ROOT_AGENT ? turn?.root : subAgents.get(key);
    }

    // ---------------------------------------------------------------- windows

    function openWindow(windows, id, key, startMs) {
        if (typeof id === "string" && id !== "") windows.set(id, { key, start: startMs });
    }

    function closeWindow(windows, id, endMs, field) {
        const window = windows.get(id);
        if (!window) return;
        windows.delete(id);
        recordOf(window.key)?.[field].push({ start: window.start, end: endMs });
    }

    function openWindowsOf(windows, key) {
        return [...windows.values()].filter((window) => window.key === key);
    }

    /** Closes every window still open for the agent at `endMs` and records it; nothing stays open for the agent. */
    function closeOpenWindowsOf(key, endMs) {
        for (const [windows, field] of [[openTools, "toolWindows"], [openHooks, "govWindows"], [openDialogs, "waitWindows"]]) {
            for (const [id, window] of windows) {
                if (window.key === key) closeWindow(windows, id, endMs, field);
            }
        }
    }

    /** Drops every window still open for the agent without recording it. */
    function forgetOpenWindowsOf(key) {
        for (const windows of [openTools, openHooks, openDialogs]) {
            for (const [id, window] of windows) {
                if (window.key === key) windows.delete(id);
            }
        }
    }

    // ---------------------------------------------------------------- measuring

    /** The row of an agent measured at `atMs`; windows still open are closed at the end of the measurement. */
    function rowOf(record, atMs) {
        const endMs = record.endMs ?? atMs;
        const closed = (windows, field, key) => [
            ...record[field],
            ...openWindowsOf(windows, key).map((window) => ({ start: window.start, end: endMs })),
        ].map((window) => ({ start: Math.max(window.start, record.startMs), end: Math.min(window.end, endMs) }));
        const waitWindows = closed(openDialogs, "waitWindows", record.key);
        const govWindows = closed(openHooks, "govWindows", record.key);
        const toolWindows = closed(openTools, "toolWindows", record.key);

        const waitMs = unionMs(waitWindows);
        const govMs = exclusiveMs(govWindows, waitWindows);
        const toolsMs = exclusiveMs(toolWindows, [...govWindows, ...waitWindows]);
        const wallMs = Math.max(0, endMs - record.startMs);
        const lastModel = record.models[record.models.length - 1] ?? "";
        const model = record.models.length > 1 ? `${lastModel} +${record.models.length - 1}` : lastModel;
        return {
            agent: record.agent,
            task: record.task,
            model,
            status: record.status,
            req: record.req,
            costUsd: record.nanoAiu / NANO_AIU_PER_USD,
            tokensIn: record.tokensIn,
            tokensOut: record.tokensOut,
            cacheRead: record.cacheRead,
            wallMs,
            llmMs: record.llmMs,
            ttftSumMs: record.ttftSumMs,
            ttftCount: record.ttftCount,
            toolsMs,
            govMs,
            waitMs,
            otherMs: Math.max(0, wallMs - record.llmMs - toolsMs - govMs - waitMs),
        };
    }

    function agentBlockOf(record) {
        return { kind: "agent", sessionUsd: sessionUsd(), row: rowOf(record, record.endMs) };
    }

    // ---------------------------------------------------------------- turns

    function openTurn(isKeepalive, trigger, startMs) {
        const root = newRecord(ROOT_AGENT, ROOT_AGENT, startMs);
        root.status = STATUS.DONE;
        turn = { isKeepalive, trigger, startMs, root, subAgents: [] };
    }

    function onUserMessage(event, data, t) {
        if (event.agentId != null) return [];
        const isKeepalive = typeof data.content === "string" && data.content.startsWith(KEEPALIVE_PREFIX);
        if (!turn) openTurn(isKeepalive, TURN_TRIGGER.USER, t);
        else if (turn.isKeepalive && !isKeepalive) turn.isKeepalive = false;
        return [];
    }

    function onTurnStart(event, t) {
        if (event.agentId == null && !turn) openTurn(false, TURN_TRIGGER.NOTICE, t);
        return [];
    }

    function onIdle(event, t) {
        if (event.agentId != null || !turn) return [];
        const finishedTurn = turn;
        turn = null;
        const turnBlocks = finishedTurn.isKeepalive ? closeKeepaliveTurn(finishedTurn) : [closeRealTurn(finishedTurn, t)];
        forgetOpenWindowsOf(ROOT_AGENT);
        const deferredBlocks = deferredRecords.map((record) => {
            subAgents.delete(record.key);
            return agentBlockOf(record);
        });
        deferredRecords = [];
        return [...turnBlocks, ...deferredBlocks];
    }

    /** A keep-alive turn writes no block: its cost joins the keep-alive figures of the next real turn. */
    function closeKeepaliveTurn(finishedTurn) {
        keepalive.count += 1;
        keepalive.nanoAiu += finishedTurn.root.nanoAiu;
        return [];
    }

    function closeRealTurn(finishedTurn, t) {
        const rows = [rowOf(finishedTurn.root, t), ...finishedTurn.subAgents.map((record) => rowOf(record, t))];
        for (const record of finishedTurn.subAgents) {
            if (record.status !== STATUS.RUNNING) {
                subAgents.delete(record.key);
                rememberSettled(record.key);
            }
        }
        turnNumber += 1;
        const block = {
            kind: "turn",
            number: turnNumber,
            trigger: finishedTurn.trigger,
            wallMs: Math.max(0, t - finishedTurn.startMs),
            agentTimeMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
            costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
            sessionUsd: sessionUsd(),
            keepalive: { count: keepalive.count, usd: keepalive.nanoAiu / NANO_AIU_PER_USD },
            rows,
        };
        keepalive = { count: 0, nanoAiu: 0 };
        return block;
    }

    // ---------------------------------------------------------------- usage

    function onUsage(event, data, t) {
        const key = event.agentId ?? ROOT_AGENT;
        const cost = data.copilotUsage?.totalNanoAiu;
        const nanoAiu = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
        totalNanoAiu += nanoAiu;

        // A usage with no open record is dropped: an ended agent has no record, and a usage from an agent whose start was not seen
        // cannot be attributed to a block. The session total above still counts it.
        const record = recordOf(key);
        if (!record || record.endMs !== null) return [];
        record.req += 1;
        record.nanoAiu += nanoAiu;
        record.tokensIn += finiteOrZero(data.inputTokens);
        record.tokensOut += finiteOrZero(data.outputTokens);
        record.cacheRead += finiteOrZero(data.cacheReadTokens);
        record.llmMs += finiteOrZero(data.duration);
        if (typeof data.timeToFirstTokenMs === "number" && Number.isFinite(data.timeToFirstTokenMs)) {
            record.ttftSumMs += data.timeToFirstTokenMs;
            record.ttftCount += 1;
        }
        if (typeof data.model === "string" && data.model !== "" && !record.models.includes(data.model)) record.models.push(data.model);
        return [];
    }

    // ---------------------------------------------------------------- tool, hook and dialog windows

    function onToolStart(event, data, t) {
        const key = event.agentId ?? ROOT_AGENT;
        if (typeof data.toolCallId === "string") {
            agentKeyByToolCallId.set(data.toolCallId, key);
            const taskName = data.arguments?.name;
            if (key === ROOT_AGENT && data.toolName === "task" && typeof taskName === "string") {
                taskNameByToolCallId.set(data.toolCallId, taskName);
            }
        }
        openWindow(openTools, data.toolCallId, key, t);
        return [];
    }

    function onToolComplete(data, t) {
        closeWindow(openTools, data.toolCallId, t, "toolWindows");
        agentKeyByToolCallId.delete(data.toolCallId);
        return [];
    }

    function onHookStart(event, data, t) {
        if (data.hookType !== PRE_TOOL_USE) return [];
        const key = event.agentId ?? ROOT_AGENT;
        const toolCalls = Array.isArray(data.input?.toolCalls) ? data.input.toolCalls : [];
        for (const toolCall of toolCalls) {
            if (isObject(toolCall) && typeof toolCall.id === "string") agentKeyByToolCallId.set(toolCall.id, key);
        }
        openWindow(openHooks, data.hookInvocationId, key, t);
        return [];
    }

    function onHookEnd(data, t) {
        if (data.hookType === PRE_TOOL_USE) closeWindow(openHooks, data.hookInvocationId, t, "govWindows");
        return [];
    }

    /** A dialog without agentId belongs to the agent of its tool call, else to the only open preToolUse window, else to the root. */
    function dialogOwnerKey(event, data) {
        if (event.agentId != null) return event.agentId;
        const toolCallKey = agentKeyByToolCallId.get(data.toolCallId);
        if (toolCallKey !== undefined) return toolCallKey;
        if (openHooks.size === 1) return openHooks.values().next().value.key;
        return ROOT_AGENT;
    }

    function onDialog(event, data, t) {
        if (event.type.endsWith(".requested")) openWindow(openDialogs, data.requestId, dialogOwnerKey(event, data), t);
        else closeWindow(openDialogs, data.requestId, t, "waitWindows");
        return [];
    }

    // ---------------------------------------------------------------- sub-agents

    /** Remembers an ended sub-agent key (most recent last); beyond the limit the oldest key is forgotten. */
    function rememberSettled(key) {
        settledKeys.delete(key);
        settledKeys.add(key);
        if (settledKeys.size > SETTLED_AGENT_KEYS_LIMIT) settledKeys.delete(settledKeys.values().next().value);
    }

    function onSubAgentStart(event, data, t) {
        const key = event.agentId;
        if (typeof key !== "string" || key === "") return [];
        const record = subAgents.get(key) ?? newRecord(key, UNKNOWN_AGENT, t);
        record.agent = typeof data.agentName === "string" && data.agentName !== "" ? data.agentName : DEFAULT_AGENT;
        record.task = taskNameByToolCallId.get(data.toolCallId) ?? null;
        taskNameByToolCallId.delete(data.toolCallId);
        record.status = STATUS.RUNNING;
        record.startMs = t;
        record.endMs = null;
        settledKeys.delete(key);
        subAgents.set(key, record);
        if (turn) {
            turn.subAgents.push(record);
            turn.isKeepalive = false;
        }
        return [];
    }

    function onSubAgentEnd(event, data, t) {
        const key = event.agentId;
        if (typeof key !== "string" || key === "") return [];
        if (settledKeys.has(key)) return [];
        let record = subAgents.get(key);
        if (!record) {
            const durationMs = finiteOrZero(data.durationMs);
            record = newRecord(key, typeof data.agentName === "string" && data.agentName !== "" ? data.agentName : DEFAULT_AGENT, t - durationMs);
            subAgents.set(key, record);
        }
        const failed = event.type === "subagent.failed" || data.cancelled === true;
        record.status = failed ? STATUS.FAILED : STATUS.DONE;
        record.endMs = t;
        closeOpenWindowsOf(key, t);

        if (turn?.subAgents.includes(record)) return [];
        if (turn) {
            rememberSettled(key);
            deferredRecords.push(record);
            return [];
        }
        subAgents.delete(key);
        rememberSettled(key);
        return [agentBlockOf(record)];
    }

    // ---------------------------------------------------------------- entry point

    /**
     * Feeds one session event. Returns the blocks that became ready, in the order they are to be written.
     * @param {object} event
     * @param {number} nowMs used when the event has no valid timestamp
     * @returns {(import("./contracts.mjs").TurnBlock | import("./contracts.mjs").AgentBlock)[]}
     */
    function apply(event, nowMs) {
        if (!isObject(event) || typeof event.type !== "string") return [];
        const parsedMs = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
        const t = Number.isFinite(parsedMs) ? parsedMs : nowMs;
        const data = isObject(event.data) ? event.data : null;

        if (event.type === "session.idle") return onIdle(event, t);
        if (event.type === "assistant.turn_start") return onTurnStart(event, t);
        if (!data) return [];
        switch (event.type) {
            case "user.message": return onUserMessage(event, data, t);
            case "assistant.usage": return onUsage(event, data, t);
            case "tool.execution_start": return onToolStart(event, data, t);
            case "tool.execution_complete": return onToolComplete(data, t);
            case "hook.start": return onHookStart(event, data, t);
            case "hook.end": return onHookEnd(data, t);
            case "subagent.started": return onSubAgentStart(event, data, t);
            case "subagent.completed":
            case "subagent.failed": return onSubAgentEnd(event, data, t);
            default: return DIALOG_EVENT.test(event.type) ? onDialog(event, data, t) : [];
        }
    }

    return {
        apply,
        sessionUsd,
        /** Retained state, for the tests: agent records, remembered ended keys and deferred records. */
        memory: () => ({ agentRecords: subAgents.size, settledKeys: settledKeys.size, deferredRecords: deferredRecords.length }),
    };
}
