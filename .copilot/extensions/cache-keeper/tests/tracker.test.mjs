import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION, KEEPER_EVENT, REFRESH_KIND } from "../lib/contracts.mjs";
import { mergeConfig } from "../lib/config.mjs";
import { applyEvent, createTrackerState } from "../lib/tracker.mjs";
import { T0 } from "./helpers/fakes.mjs";

const cfg = mergeConfig({});
const TTL = cfg.fallbackTtlSec * 1000;

// step builders: [msAfterT0, event]
const ev = (ms, type, data = {}, extra = {}) => [ms, { type, data, ...extra }];
const usage = (ms, o = {}) => ev(ms, "assistant.usage", { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, ...o });
const sent = (ms, action, text, actionId) => ev(ms, KEEPER_EVENT.ACTION_STARTED, { action, text, actionId });
const withdrawn = (ms, action, text, o = {}) => ev(ms, KEEPER_EVENT.COMMAND_WITHDRAWN, { action, text, ...o });
const replay = (steps, withCfg = cfg) => steps.reduce((s, [ms, e]) => applyEvent(s, e, T0 + ms, withCfg), createTrackerState());
const ALL_CHANGED = { save: true, compact: true };
const NOTE_TEXT = "Summarise open work in one line.";
const noteCfg = mergeConfig({ ladder: { keepalives: 0, actions: [{ id: "note", text: NOTE_TEXT }] } });
// copilotUsage.tokenDetails as the CLI reports it: costPerBatch nano-AIU per batchSize tokens (1,000,000 here)
const detail = (tokenType, costPerBatch) => ({ tokenType, costPerBatch, batchSize: 1_000_000, tokenCount: 0, model: "claude-opus-5.5" });
const OPUS_DETAILS = [detail("input", 400_000_000_000), detail("cache_read", 20_000_000_000), detail("cache_write", 500_000_000_000), detail("output", 2_000_000_000_000)];
const PING_NANO_AIU = 10_000_000_000; // $0.10

const CASES = [
    {
        name: "turn_start sets a provisional expiry from the request start",
        steps: [ev(5_000, "assistant.turn_start")],
        check: (s) => {
            assert.equal(s.expiresAt, T0 + 5_000 + TTL);
            assert.equal(s.provisional, true);
            assert.equal(s.idle, false);
            assert.equal(s.requestStartedAt, T0 + 5_000);
        },
    },
    {
        name: "turn_start while idle leaves idle",
        steps: [ev(0, "assistant.idle"), ev(1_000, "assistant.turn_start")],
        check: (s) => assert.equal(s.idle, false),
    },
    {
        name: "usage takes the expiry from cacheExpiresAt and drops the provisional flag",
        steps: [ev(0, "assistant.turn_start"), usage(56_000, { cacheExpiresAt: new Date(T0 + 300_500).toISOString() })],
        check: (s) => {
            assert.equal(s.expiresAt, T0 + 300_500);
            assert.equal(s.provisional, false);
            assert.equal(s.lastUsage.provisionalDeltaSec, 1);
        },
    },
    {
        name: "usage without cacheExpiresAt falls back to now + fallbackTtl",
        steps: [usage(10_000)],
        check: (s) => assert.equal(s.expiresAt, T0 + 10_000 + TTL),
    },
    {
        name: "usage computes context tokens as the larger of input and cache read + write",
        steps: [usage(0, { inputTokens: 100, cacheReadTokens: 5_000, cacheWriteTokens: 1_000 })],
        check: (s) => assert.equal(s.contextTokens, 6_000),
    },
    {
        name: "usage with a small cache write is a hit",
        steps: [usage(0, { inputTokens: 400_000, cacheReadTokens: 398_000, cacheWriteTokens: 2_000 })],
        check: (s) => assert.deepEqual([s.lastUsage.miss, s.lastUsage.contextTokens, s.lastUsage.cacheRead, s.lastUsage.cacheWrite], [false, 400_000, 398_000, 2_000]),
    },
    {
        name: "usage that mostly writes cache is a miss",
        steps: [usage(0, { inputTokens: 400_000, cacheReadTokens: 1_000, cacheWriteTokens: 399_000 })],
        check: (s) => assert.equal(s.lastUsage.miss, true),
    },
    {
        name: "small prompts are never misses",
        steps: [usage(0, { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 10_000 })],
        check: (s) => assert.equal(s.lastUsage.miss, false),
    },
    {
        name: "usage records the gap since the previous usage and whether the user was away",
        steps: [usage(0), ev(1_000, "assistant.idle"), usage(301_000)],
        check: (s) => {
            assert.equal(s.lastUsage.gapSec, 301);
            assert.equal(s.lastUsage.after, "idle");
            assert.equal(s.idleSinceLastRequest, false);
        },
    },
    {
        name: "the first usage has no gap and follows a busy period",
        steps: [usage(0)],
        check: (s) => assert.deepEqual([s.lastUsage.gapSec, s.lastUsage.after, s.lastUsage.provisionalDeltaSec], [null, "busy", null]),
    },
    {
        name: "usage of another interaction type is ignored",
        steps: [ev(0, "assistant.turn_start"), usage(1_000, { interactionType: "title-generation" })],
        check: (s) => assert.deepEqual([s.provisional, s.lastUsage, s.contextTokens], [true, null, 0]),
    },
    {
        name: "tool start adds an in-flight entry with name and shellId",
        steps: [ev(7_000, "tool.execution_start", { toolCallId: "tc1", toolName: "powershell", arguments: { shellId: "build" } })],
        check: (s) => assert.deepEqual([...s.inFlight], [["tc1", { name: "powershell", at: T0 + 7_000, shellId: "build" }]]),
    },
    {
        name: "tool start without a toolCallId is ignored",
        steps: [ev(0, "tool.execution_start", { toolName: "powershell" })],
        check: (s) => assert.equal(s.inFlight.size, 0),
    },
    {
        name: "tool complete removes only its own entry",
        steps: [ev(0, "tool.execution_start", { toolCallId: "a", toolName: "view" }), ev(1, "tool.execution_start", { toolCallId: "b", toolName: "grep" }), ev(2, "tool.execution_complete", { toolCallId: "a" })],
        check: (s) => assert.deepEqual([...s.inFlight.keys()], ["b"]),
    },
    {
        name: "assistant.idle sets the idle flag and clears in-flight tools",
        steps: [ev(0, "tool.execution_start", { toolCallId: "a", toolName: "view" }), ev(1, "assistant.idle")],
        check: (s) => assert.deepEqual([s.idle, s.idleSinceLastRequest, s.inFlight.size], [true, true, 0]),
    },
    {
        name: "B1: a real user message resets keepalives, waitRefreshes, nextActionIndex, startedAction and retriedActionIds",
        steps: [
            ev(0, "user.message", { content: "hello" }),
            sent(1, ACTION.LADDER_ACTION, "/save", "save"), withdrawn(2, ACTION.LADDER_ACTION, "/save", { removed: true, actionId: "save" }),
            sent(3, ACTION.LADDER_ACTION, "/save", "save"), sent(4, ACTION.KEEPALIVE, "ka"), sent(5, ACTION.WAIT_KEEPALIVE, "ka"),
            ev(6, "user.message", { content: "I am back" }),
        ],
        check: (s) => assert.deepEqual(
            [s.keepalives, s.waitRefreshes, s.nextActionIndex, s.startedAction, s.retriedActionIds, s.lastUserMessageOwn],
            [0, 0, 0, null, [], false],
        ),
    },
    {
        name: "B1 AC-3: a real user message sets changedSinceRun for every action",
        steps: [ev(0, "user.message", { content: "I am back" })],
        check: (s) => assert.deepEqual(s.changedSinceRun, ALL_CHANGED),
    },
    {
        name: "B1 AC-3: a user-typed /save with notes clears only the save flag",
        steps: [ev(0, "user.message", { content: "/save now" })],
        check: (s) => assert.deepEqual(s.changedSinceRun, { save: false, compact: true }),
    },
    {
        name: "an own keep-alive echo does not reset the ladder",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText })],
        check: (s) => assert.deepEqual([s.keepalives, s.lastUserMessageOwn, s.own.length, s.changedSinceRun], [1, true, 0, {}]),
    },
    {
        name: "an own echo is consumed once; the same text from the user afterwards is foreign",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(1, "user.message", { content: "ka" }), ev(2, "user.message", { content: "ka" })],
        check: (s) => assert.deepEqual([s.keepalives, s.lastUserMessageOwn, s.changedSinceRun], [0, false, ALL_CHANGED]),
    },
    {
        name: "an own echo is recognised by prefix",
        steps: [sent(0, ACTION.LADDER_ACTION, "/save", "save"), ev(1, "user.message", { content: "/save extra args" })],
        check: (s) => assert.equal(s.lastUserMessageOwn, true),
    },
    {
        name: "B1 AC-2: the echo of a text action is the keeper's own (no reset, kind action)",
        cfg: noteCfg,
        steps: [
            ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, NOTE_TEXT, "note"),
            ev(2, "user.message", { content: NOTE_TEXT }), usage(5_000),
        ],
        check: (s) => assert.deepEqual(
            [s.lastUserMessageOwn, s.own.length, s.nextActionIndex, s.changedSinceRun, s.lastRefreshKind],
            [true, 0, 1, { note: false }, REFRESH_KIND.ACTION],
        ),
    },
    {
        name: "an own entry expires after 60 seconds",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(61_000, "user.message", { content: "ka" })],
        check: (s) => assert.deepEqual([s.lastUserMessageOwn, s.keepalives], [false, 0]),
    },
    {
        name: "B1 AC-3: skill.invoked save clears the save flag; another skill returns the same state object",
        steps: [ev(0, "user.message", { content: "hello" }), ev(1, "skill.invoked", { name: "save" })],
        check: (s) => {
            assert.deepEqual(s.changedSinceRun, { save: false, compact: true });
            assert.equal(applyEvent(s, { type: "skill.invoked", data: { name: "other" } }, T0, cfg), s);
            assert.equal(applyEvent(s, { type: "skill.invoked", data: { name: "save" } }, T0, cfg), s);
        },
    },
    {
        name: "successful compaction sets the context tokens",
        steps: [usage(0), ev(1, "session.compaction_complete", { success: true, postCompactionTokens: 12_345 })],
        check: (s) => assert.equal(s.contextTokens, 12_345),
    },
    {
        name: "failed compaction keeps the context tokens",
        steps: [usage(0), ev(1, "session.compaction_complete", { success: false, postCompactionTokens: 1 })],
        check: (s) => assert.equal(s.contextTokens, 200_000),
    },
    {
        name: "sub-agent events are ignored",
        steps: [
            ev(0, "assistant.turn_start", {}, { agentId: "sub1" }), ev(1, "user.message", { content: "worker prompt" }, { agentId: "sub1" }),
            ev(2, "tool.execution_start", { toolCallId: "x", toolName: "view" }, { agentId: "sub1" }), ev(3, "assistant.idle", {}, { agentId: "sub1" }),
        ],
        check: (s) => assert.deepEqual(s, createTrackerState()),
    },
    {
        name: "unknown events leave the state unchanged",
        steps: [ev(0, "system.notification")],
        check: (s) => assert.deepEqual(s, createTrackerState()),
    },
    {
        name: "B1 AC-3: starting an action clears its flag and moves nextActionIndex past it",
        steps: [ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, "/save", "save")],
        check: (s) => assert.deepEqual(
            [s.keepalives, s.waitRefreshes, s.nextActionIndex, s.changedSinceRun, s.startedAction],
            [0, 0, 1, { save: false, compact: true }, { id: "save", index: 0, changedBefore: true }],
        ),
    },
    {
        name: "B1 AC-3: starting the last action moves nextActionIndex to the list length",
        steps: [sent(0, ACTION.LADDER_ACTION, "/compact", "compact")],
        check: (s) => assert.deepEqual([s.nextActionIndex, s.startedAction], [2, { id: "compact", index: 1, changedBefore: false }]),
    },
    {
        name: "a started wait keep-alive counts only the wait refresh",
        steps: [sent(0, ACTION.WAIT_KEEPALIVE, "ka")],
        check: (s) => assert.deepEqual([s.keepalives, s.waitRefreshes], [0, 1]),
    },
    {
        name: "usage after an own keep-alive records lastRefreshAt / lastRefreshKind",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(1, "user.message", { content: "ka" }), ev(2, "assistant.turn_start"), usage(9_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [T0 + 9_000, REFRESH_KIND.KEEPALIVE]),
    },
    {
        name: "usage after an own wait keep-alive records kind wait",
        steps: [sent(0, ACTION.WAIT_KEEPALIVE, "ka"), ev(1, "user.message", { content: "ka" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [T0 + 5_000, REFRESH_KIND.WAIT]),
    },
    {
        name: "usage after an own ladder action records kind action",
        steps: [sent(0, ACTION.LADDER_ACTION, "/save", "save"), ev(1, "user.message", { content: "/save" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [T0 + 5_000, REFRESH_KIND.ACTION]),
    },
    {
        name: "usage after an own unblock records kind unblock",
        steps: [sent(0, ACTION.UNBLOCK, "/continue"), ev(1, "user.message", { content: "/continue" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [T0 + 5_000, REFRESH_KIND.UNBLOCK]),
    },
    {
        name: "only the first usage of a keeper request is recorded",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(1, "user.message", { content: "ka" }), usage(5_000), usage(9_000)],
        check: (s) => assert.equal(s.lastRefreshAt, T0 + 5_000),
    },
    {
        name: "usage of a user request does not touch lastRefreshAt / lastRefreshKind",
        steps: [ev(0, "user.message", { content: "hello" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [null, null]),
    },
    {
        name: "a user message in between cancels the pending keeper request label",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(1, "user.message", { content: "ka" }), ev(2, "user.message", { content: "real input" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind], [null, null]),
    },
    {
        name: "B1 AC-3: a rejected action (not removed) is always given back",
        steps: [
            ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, "/save", "save"),
            withdrawn(2, ACTION.LADDER_ACTION, "/save", { actionId: "save" }),
            sent(3, ACTION.LADDER_ACTION, "/save", "save"), withdrawn(4, ACTION.LADDER_ACTION, "/save", { actionId: "save" }),
        ],
        check: (s) => assert.deepEqual(
            [s.nextActionIndex, s.changedSinceRun, s.startedAction, s.retriedActionIds, s.own.length],
            [0, ALL_CHANGED, null, [], 0],
        ),
    },
    {
        name: "B1 AC-3: a rejected skip action is given back too",
        steps: [
            ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, "/save", "save"), sent(2, ACTION.LADDER_ACTION, "/compact", "compact"),
            withdrawn(3, ACTION.LADDER_ACTION, "/compact", { actionId: "compact" }),
        ],
        check: (s) => assert.deepEqual([s.nextActionIndex, s.changedSinceRun, s.own.map((o) => o.text)], [1, { save: false, compact: true }, ["/save"]]),
    },
    {
        name: "B1 AC-3: a removed retry action is given back once, a second removal counts as done",
        steps: [
            ev(0, "user.message", { content: "hello" }),
            sent(1, ACTION.LADDER_ACTION, "/save", "save"), withdrawn(2, ACTION.LADDER_ACTION, "/save", { removed: true, actionId: "save" }),
        ],
        check: (s) => {
            assert.deepEqual([s.nextActionIndex, s.changedSinceRun, s.startedAction, s.retriedActionIds, s.own.length], [0, ALL_CHANGED, null, ["save"], 0]);
            const again = [sent(3, ACTION.LADDER_ACTION, "/save", "save"), withdrawn(4, ACTION.LADDER_ACTION, "/save", { removed: true, actionId: "save" })]
                .reduce((state, [ms, e]) => applyEvent(state, e, T0 + ms, cfg), s);
            assert.deepEqual(
                [again.nextActionIndex, again.changedSinceRun, again.startedAction, again.retriedActionIds, again.own.length],
                [1, { save: false, compact: true }, null, ["save"], 0],
            );
        },
    },
    {
        name: "B1 AC-3: a removed skip action counts as done",
        steps: [
            ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, "/compact", "compact"),
            withdrawn(2, ACTION.LADDER_ACTION, "/compact", { removed: true, actionId: "compact" }),
        ],
        check: (s) => assert.deepEqual([s.nextActionIndex, s.startedAction, s.retriedActionIds, s.own.length], [2, null, [], 0]),
    },
    {
        name: "B1: a withdrawal after a real user message does not move the ladder",
        steps: [
            sent(0, ACTION.LADDER_ACTION, "/save", "save"), ev(1, "user.message", { content: "I am back" }),
            withdrawn(2, ACTION.LADDER_ACTION, "/save", { removed: true, actionId: "save" }),
        ],
        check: (s) => assert.deepEqual([s.nextActionIndex, s.changedSinceRun, s.retriedActionIds], [0, ALL_CHANGED, []]),
    },
    {
        name: "a withdrawn keep-alive never drives keepalives below zero (the ladder was reset in between)",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), ev(1, "user.message", { content: "I am back" }), withdrawn(2, ACTION.KEEPALIVE, "ka")],
        check: (s) => assert.deepEqual([s.keepalives, s.changedSinceRun], [0, ALL_CHANGED]),
    },
    {
        name: "a started unblock keep-alive is not a ladder step",
        steps: [sent(0, ACTION.UNBLOCK, "ka")],
        check: (s) => assert.deepEqual([s.keepalives, s.waitRefreshes, s.nextActionIndex], [0, 0, 0]),
    },
    {
        name: "B1 AC-3: after a removed retry action the unblock keep-alive is not a step and the action runs again",
        steps: [
            ev(0, "user.message", { content: "hello" }), sent(1, ACTION.LADDER_ACTION, "/save", "save"),
            withdrawn(2, ACTION.LADDER_ACTION, "/save", { removed: true, actionId: "save" }), sent(3, ACTION.UNBLOCK, "ka"),
        ],
        check: (s) => assert.deepEqual([s.keepalives, s.nextActionIndex, s.changedSinceRun.save], [0, 0, true]),
    },
    {
        name: "a failed keep-alive / unblock keep-alive gives its ladder step back",
        steps: [sent(0, ACTION.KEEPALIVE, "ka"), sent(1, ACTION.UNBLOCK, "ka"), withdrawn(2, ACTION.KEEPALIVE, "ka"), withdrawn(3, ACTION.UNBLOCK, "ka")],
        check: (s) => assert.deepEqual([s.keepalives, s.own.length], [0, 0]),
    },
    {
        name: "a failed wait keep-alive gives its wait refresh back",
        steps: [sent(0, ACTION.WAIT_KEEPALIVE, "ka"), withdrawn(1, ACTION.WAIT_KEEPALIVE, "ka")],
        check: (s) => assert.deepEqual([s.keepalives, s.waitRefreshes, s.own.length], [0, 0, 0]),
    },
    {
        name: "a keep-alive leaves the changed flags alone",
        steps: [ev(0, "user.message", { content: "hello" }), sent(1, ACTION.KEEPALIVE, "ka"), ev(2, "user.message", { content: "ka" })],
        check: (s) => assert.deepEqual([s.keepalives, s.changedSinceRun], [1, ALL_CHANGED]),
    },
    {
        name: "a steered foreign message is a real user message that is labelled unblock",
        steps: [sent(0, ACTION.LADDER_ACTION, "/save", "save"), ev(1, KEEPER_EVENT.MESSAGE_STEERED, { text: "do this" }), ev(2, "user.message", { content: "do this" }), usage(5_000)],
        check: (s) => assert.deepEqual([s.keepalives, s.changedSinceRun, s.lastUserMessageOwn, s.lastRefreshKind, s.lastRefreshAt], [0, ALL_CHANGED, false, REFRESH_KIND.UNBLOCK, T0 + 5_000]),
    },
    {
        name: "a user message that was not steered is not labelled unblock",
        steps: [ev(0, KEEPER_EVENT.MESSAGE_STEERED, { text: "do this" }), ev(1, "user.message", { content: "something else" }), usage(5_000)],
        check: (s) => assert.equal(s.lastRefreshKind, null),
    },
    {
        name: "a steered label expires after 60 seconds",
        steps: [ev(0, KEEPER_EVENT.MESSAGE_STEERED, { text: "do this" }), ev(61_000, "user.message", { content: "do this" }), usage(65_000)],
        check: (s) => assert.equal(s.lastRefreshKind, null),
    },
    {
        name: "B1 AC-6: the first root usage after an own keep-alive echo records its totalNanoAiu",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, { copilotUsage: { totalNanoAiu: 11_898_860_000 } })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshKind], [11_898_860_000, REFRESH_KIND.KEEPALIVE]),
    },
    {
        name: "B1 AC-6: a later request of the same turn does not change the price",
        steps: [
            sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }),
            usage(2_000, { copilotUsage: { totalNanoAiu: 11_898_860_000 } }), usage(4_000, { copilotUsage: { totalNanoAiu: 5 } }),
        ],
        check: (s) => assert.equal(s.lastRefreshNanoAiu, 11_898_860_000),
    },
    {
        name: "B1 AC-6: sub-agent usage is ignored",
        steps: [
            sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }),
            ev(1_500, "assistant.usage", { interactionType: "conversation-agent", copilotUsage: { totalNanoAiu: 7 } }, { agentId: "sub1" }),
            usage(2_000, { copilotUsage: { totalNanoAiu: 11_898_860_000 } }),
        ],
        check: (s) => assert.equal(s.lastRefreshNanoAiu, 11_898_860_000),
    },
    {
        name: "B1 AC-6: usage without a cost field gives no price",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000)],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshKind], [null, REFRESH_KIND.KEEPALIVE]),
    },
    {
        name: "B1 AC-6: a wait keep-alive is priced too",
        steps: [sent(0, ACTION.WAIT_KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, { copilotUsage: { totalNanoAiu: 42 } })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshKind], [42, REFRESH_KIND.WAIT]),
    },
    {
        name: "B1 AC-6: a usage that is not after an own echo leaves the price unchanged",
        steps: [usage(0, { copilotUsage: { totalNanoAiu: 9 } })],
        check: (s) => {
            assert.equal(createTrackerState().lastRefreshNanoAiu, null);
            assert.equal(s.lastRefreshNanoAiu, null);
        },
    },
    {
        name: "B3 AC-13: a new state has no saving and no miss flag",
        steps: [],
        check: (s) => assert.deepEqual([s.lastRefreshSavedNanoAiu, s.lastRefreshMiss], [null, null]),
    },
    {
        name: "B3 AC-13: the saving is the cache reads times the cache_write minus cache_read rate (report sample)",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, {
            inputTokens: 498_840, cacheReadTokens: 498_717, cacheWriteTokens: 119, cacheTtlSeconds: 300,
            copilotUsage: { totalNanoAiu: PING_NANO_AIU, tokenDetails: OPUS_DETAILS },
        })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshSavedNanoAiu, s.lastRefreshMiss], [PING_NANO_AIU, 498_717 * (500_000 - 20_000), false]),
    },
    {
        name: "B3 AC-13: a 1-hour cache TTL takes the cache_write_1h rate",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, {
            inputTokens: 200_000, cacheReadTokens: 200_000, cacheWriteTokens: 1_000, cacheTtlSeconds: 3600,
            copilotUsage: { totalNanoAiu: PING_NANO_AIU, tokenDetails: [...OPUS_DETAILS, detail("cache_write_1h", 1_000_000_000_000)] },
        })],
        check: (s) => assert.equal(s.lastRefreshSavedNanoAiu, 200_000 * (1_000_000 - 20_000)),
    },
    {
        name: "B3 AC-13: a usage without tokenDetails keeps the price and gives no saving",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, { copilotUsage: { totalNanoAiu: 42 } })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshSavedNanoAiu], [42, null]),
    },
    {
        name: "B3 AC-13: tokenDetails without a cache_read entry gives no saving",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, {
            copilotUsage: { totalNanoAiu: PING_NANO_AIU, tokenDetails: [detail("cache_write", 500_000_000_000)] },
        })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshSavedNanoAiu], [PING_NANO_AIU, null]),
    },
    {
        name: "B3 AC-13: an auxiliary usage with fewer than 20000 cache reads is not credited and the ping stays pending",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, {
            inputTokens: 5_000, cacheReadTokens: 4_000, cacheWriteTokens: 0, copilotUsage: { totalNanoAiu: 7, tokenDetails: OPUS_DETAILS },
        })],
        check: (s) => assert.deepEqual([s.lastRefreshKind, s.lastRefreshAt, s.lastRefreshNanoAiu, s.lastRefreshSavedNanoAiu], [null, null, null, null]),
    },
    {
        name: "B3 AC-13: the next qualifying usage after an auxiliary one is credited",
        steps: [
            sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }),
            usage(2_000, { inputTokens: 5_000, cacheReadTokens: 4_000, cacheWriteTokens: 0, copilotUsage: { totalNanoAiu: 7 } }),
            usage(4_000, { inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, copilotUsage: { totalNanoAiu: 9 } }),
        ],
        check: (s) => assert.deepEqual([s.lastRefreshAt, s.lastRefreshKind, s.lastRefreshNanoAiu], [T0 + 4_000, REFRESH_KIND.KEEPALIVE, 9]),
    },
    {
        name: "B3 AC-13: a miss is credited with its cost, no saving and the miss flag, even with 0 cache reads",
        steps: [sent(0, ACTION.KEEPALIVE, cfg.keepaliveText), ev(1, "user.message", { content: cfg.keepaliveText }), usage(2_000, {
            inputTokens: 498_930, cacheReadTokens: 0, cacheWriteTokens: 498_926, cacheTtlSeconds: 300,
            copilotUsage: { totalNanoAiu: 249_472_600_000, tokenDetails: OPUS_DETAILS },
        })],
        check: (s) => assert.deepEqual([s.lastRefreshNanoAiu, s.lastRefreshSavedNanoAiu, s.lastRefreshMiss, s.lastRefreshKind], [249_472_600_000, null, true, REFRESH_KIND.KEEPALIVE]),
    },
];

for (const c of CASES) {
    test(`tracker: ${c.name}`, () => c.check(replay(c.steps, c.cfg ?? cfg)));
}

test("tracker: applyEvent returns a new object and leaves its input untouched", () => {
    const before = createTrackerState();
    const snapshot = structuredClone(before);
    const after = applyEvent(before, { type: "assistant.idle", data: {} }, T0, cfg);
    assert.notEqual(after, before);
    assert.deepEqual(before, snapshot);
    assert.equal(after.idle, true);
});
