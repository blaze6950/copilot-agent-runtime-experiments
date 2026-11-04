import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION } from "../lib/contracts.mjs";
import { mergeConfig } from "../lib/config.mjs";
import { createTrackerState, isMiss } from "../lib/tracker.mjs";
import * as policy from "../lib/policy.mjs";
import { pickRootTask } from "../lib/rescue.mjs";
import { T0 } from "./helpers/fakes.mjs";
import { SAVE_ACTION } from "./helpers/ladder-fixtures.mjs";

// Called through the namespace so that a missing export fails only the tests that need it.
const { decide, deadline } = policy;
const planNext = (...args) => policy.planNext(...args);
const ladderStep = (...args) => policy.ladderStep(...args);
const ladderExhausted = (...args) => policy.ladderExhausted(...args);

const base = { keepalives: 0, nextActionIndex: 0, changedSinceRun: {}, contextTokens: 200_000, waitRefreshes: 0 };
const FACTS = { agentName: "1main", runningTaskCount: 0 };

const PLAN_CASES = [
    { name: "keep-alives first -> KEEPALIVE", state: { changedSinceRun: { save: true } }, expect: [ACTION.KEEPALIVE, null] },
    { name: "last keep-alive (keepalives 9) -> KEEPALIVE", state: { keepalives: 9, changedSinceRun: { save: true } }, expect: [ACTION.KEEPALIVE, null] },
    { name: "keep-alives done, save changed -> action save", state: { keepalives: 10, changedSinceRun: { save: true } }, expect: [ACTION.LADDER_ACTION, "save"] },
    { name: "keep-alives done, save unchanged -> action compact", state: { keepalives: 10 }, expect: [ACTION.LADDER_ACTION, "compact"] },
    { name: "save unchanged and context below 150000, no running task -> NONE", state: { keepalives: 10, contextTokens: 149_999 }, expect: [ACTION.NONE, null] },
    { name: "save unchanged and context below 150000, a task runs -> WAIT_KEEPALIVE", state: { keepalives: 10, contextTokens: 149_999 }, facts: { runningTaskCount: 1 }, expect: [ACTION.WAIT_KEEPALIVE, null] },
    { name: "all actions done, no running task -> NONE (the ladder is done)", state: { keepalives: 10, nextActionIndex: 2 }, expect: [ACTION.NONE, null] },
    { name: "all actions done, a task runs -> WAIT_KEEPALIVE", state: { keepalives: 10, nextActionIndex: 2 }, facts: { runningTaskCount: 1 }, expect: [ACTION.WAIT_KEEPALIVE, null] },
    { name: "all actions done, a task runs, wait cap reached -> NONE", state: { keepalives: 10, nextActionIndex: 2, waitRefreshes: 50 }, facts: { runningTaskCount: 1 }, expect: [ACTION.NONE, null] },
    { name: "all actions done, a task runs, wait disabled -> NONE", state: { keepalives: 10, nextActionIndex: 2 }, cfg: { wait: { enabled: false } }, facts: { runningTaskCount: 1 }, expect: [ACTION.NONE, null] },
    { name: "keep-alives not done, a task runs -> WAIT_KEEPALIVE (decide() row 9 comes before the ladder)", state: { keepalives: 0 }, facts: { runningTaskCount: 1 }, expect: [ACTION.WAIT_KEEPALIVE, null] },
    { name: "keep-alives not done, a task runs, wait disabled -> KEEPALIVE", state: { keepalives: 0 }, cfg: { wait: { enabled: false } }, facts: { runningTaskCount: 1 }, expect: [ACTION.KEEPALIVE, null] },
    { name: "all actions done, wait cap reached -> NONE", state: { keepalives: 10, nextActionIndex: 2, waitRefreshes: 50 }, expect: [ACTION.NONE, null] },
    { name: "all actions done, wait disabled -> NONE", state: { keepalives: 10, nextActionIndex: 2 }, cfg: { wait: { enabled: false } }, expect: [ACTION.NONE, null] },
    { name: "empty action list after the keep-alives, no running task -> NONE", state: { keepalives: 10 }, cfg: { ladder: { actions: [] } }, expect: [ACTION.NONE, null] },
    { name: "empty action list after the keep-alives, a task runs -> WAIT_KEEPALIVE", state: { keepalives: 10 }, cfg: { ladder: { actions: [] } }, facts: { runningTaskCount: 1 }, expect: [ACTION.WAIT_KEEPALIVE, null] },
    { name: "keepalives 0 -> the first action at once", state: { changedSinceRun: { save: true } }, cfg: { ladder: { keepalives: 0 } }, expect: [ACTION.LADDER_ACTION, "save"] },
];

for (const c of PLAN_CASES) {
    test(`planNext: ${c.name}`, () => {
        const step = planNext({ ...base, ...c.state }, mergeConfig(c.cfg ?? {}), { ...FACTS, ...c.facts });
        assert.deepEqual([step.action, step.actionId], c.expect);
    });
}

test("B1 AC-5: planNext forecasts the action decide() takes for the same state and running task count", () => {
    const cfgs = [mergeConfig({}), mergeConfig({ wait: { enabled: false } }), mergeConfig({ wait: { maxRefreshes: 2 } })];
    const states = [
        { keepalives: 0 },
        { keepalives: 10, changedSinceRun: { save: true } },
        { keepalives: 10, nextActionIndex: 2 },
        { keepalives: 10, nextActionIndex: 2, waitRefreshes: 2 },
    ];
    for (const cfg of cfgs) for (const state of states) for (const runningTaskCount of [0, 1]) {
        const runningTasks = Array.from({ length: runningTaskCount }, (_, i) => ({ type: "agent", id: `t${i}`, status: "running" }));
        const snapshot = { now: T0, processing: false, runningTasks, pendingItems: [], steeringCount: 0, ownPendingIds: [], agentName: "1main" };
        const { action } = decide({ ...base, ...state, expiresAt: T0 + 300_000, inFlight: new Map() }, snapshot, cfg);
        const forecast = planNext({ ...base, ...state }, cfg, { agentName: "1main", runningTaskCount });
        assert.equal(forecast.action, action, `state ${JSON.stringify(state)}, running ${runningTaskCount}, wait ${cfg.wait.enabled}/${cfg.wait.maxRefreshes}`);
    }
});

test("B1 AC-2: ladderStep lists skipped actions with their reasons in JSON order", () => {
    const cfg = mergeConfig({
        ladder: {
            keepalives: 10,
            actions: [
                { id: "a", command: "/a", when: { changedSinceLastRun: true } },
                { id: "b", command: "/b", when: { agents: ["1main"] } },
                { id: "c", command: "/c", when: { minContextTokens: 150_000 } },
                { id: "d", command: "/d" },
            ],
        },
    });
    const step = ladderStep({ ...base, keepalives: 10, contextTokens: 1 }, cfg, { agentName: "util-x", runningTaskCount: 1 });
    assert.equal(step.action, ACTION.NONE);
    assert.deepEqual(step.skipped, [
        { id: "a", reason: "unchanged since last run" },
        { id: "b", reason: "agent=util-x" },
        { id: "c", reason: "context 1 < 150000" },
        { id: "d", reason: "1 background task(s) running" },
    ]);
});

test("B1: ladderExhausted is true only after all keep-alives and all actions", () => {
    const cfg = mergeConfig({});
    assert.equal(ladderExhausted({ ...base, keepalives: 9, nextActionIndex: 2 }, cfg), false);
    assert.equal(ladderExhausted({ ...base, keepalives: 10, nextActionIndex: 1 }, cfg), false);
    assert.equal(ladderExhausted({ ...base, keepalives: 10, nextActionIndex: 2 }, cfg), true);
});

// ---------- decide(state, snapshot, cfg): one row per decision, in table order ----------
const NOW = T0;
const rootTool = () => new Map([["tc1", { name: "powershell", at: NOW, shellId: null }]]);
const trackerState = (o = {}) => ({ ...createTrackerState(), expiresAt: NOW + 100_000, idleSinceLastRequest: true, contextTokens: 200_000, ...o });
const snapshot = (o = {}) => ({ now: NOW, processing: false, runningTasks: [], pendingItems: [], steeringCount: 0, ownPendingIds: [], agentName: "1main", ...o });
const ownSave = { id: "7", kind: "command", displayText: "/save" };
const foreignMessage = { id: "9", kind: "message", displayText: "do this" };
const runningTask = { type: "agent", id: "w1", status: "running" };

const DECIDE_CASES = [
    { name: "cache already expired -> NONE", state: { expiresAt: NOW - 1 }, expect: [ACTION.NONE, "expired"] },
    { name: "expired but one of our commands is held back -> UNBLOCK (a held command is always unblocked)", state: { expiresAt: NOW - 1 }, snap: { pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.UNBLOCK, "own-command-pending"] },
    { name: "expiry unknown but one of our commands is held back -> UNBLOCK", state: { expiresAt: null }, snap: { pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.UNBLOCK, "own-command-pending"] },
    { name: "expired, own command held, model busy -> NONE (busy-model; the keeper re-checks)", state: { expiresAt: NOW - 1 }, snap: { processing: true, pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.NONE, "busy-model"] },
    { name: "expired, own id tracked but queue unknown -> NONE, nothing is removed blindly (the keeper keeps re-checking)", state: { expiresAt: NOW - 1 }, snap: { pendingItems: null, ownPendingIds: ["7"] }, expect: [ACTION.NONE, "expired"] },
    { name: "expired, only a foreign item pending -> NONE (expired)", state: { expiresAt: NOW - 1 }, snap: { pendingItems: [foreignMessage] }, expect: [ACTION.NONE, "expired"] },
    { name: "cache expired beats a root tool in flight", state: { expiresAt: NOW, inFlight: rootTool() }, expect: [ACTION.NONE, "expired"] },
    { name: "expiry unknown -> NONE", state: { expiresAt: null }, expect: [ACTION.NONE, "expired"] },
    { name: "root tool in flight -> RESCUE", state: { inFlight: rootTool() }, snap: { processing: true }, expect: [ACTION.RESCUE, "root-tool"] },
    { name: "root tool in flight, rescue disabled -> NONE", state: { inFlight: rootTool() }, cfg: { rescue: { enabled: false } }, expect: [ACTION.NONE, "rescue-disabled"] },
    { name: "model processing, no root tool -> NONE (busy-model)", snap: { processing: true }, expect: [ACTION.NONE, "busy-model"] },
    { name: "busy model beats a pending own command", snap: { processing: true, pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.NONE, "busy-model"] },
    { name: "own command pending -> UNBLOCK", snap: { pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.UNBLOCK, "own-command-pending"] },
    { name: "own command pending beats a foreign item and a running task", snap: { pendingItems: [foreignMessage, ownSave], ownPendingIds: ["7"], runningTasks: [runningTask] }, expect: [ACTION.UNBLOCK, "own-command-pending"] },
    { name: "own id that is no longer pending is ignored", snap: { ownPendingIds: ["7"] }, state: { keepalives: 10, changedSinceRun: { save: true } }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "save" },
    { name: "foreign item pending -> NONE (input-queued)", snap: { pendingItems: [foreignMessage] }, expect: [ACTION.NONE, "input-queued"] },
    { name: "steering message pending -> NONE (input-queued)", snap: { steeringCount: 1 }, expect: [ACTION.NONE, "input-queued"] },
    { name: "running task -> WAIT_KEEPALIVE", snap: { runningTasks: [runningTask] }, expect: [ACTION.WAIT_KEEPALIVE, "tasks-running"] },
    { name: "running task below the wait cap -> WAIT_KEEPALIVE", state: { waitRefreshes: 49 }, snap: { runningTasks: [runningTask] }, expect: [ACTION.WAIT_KEEPALIVE, "tasks-running"] },
    { name: "running task, wait cap reached -> NONE", state: { waitRefreshes: 50 }, snap: { runningTasks: [runningTask] }, expect: [ACTION.NONE, "wait-cap"] },
    { name: "running task beats a changed save", state: { keepalives: 10, changedSinceRun: { save: true } }, snap: { runningTasks: [runningTask] }, expect: [ACTION.WAIT_KEEPALIVE, "tasks-running"] },
    { name: "B1 AC-2: wait mode off and a task running: command actions are skipped", state: { keepalives: 10, changedSinceRun: { save: true } }, cfg: { wait: { enabled: false } }, snap: { runningTasks: [runningTask] }, expect: [ACTION.NONE, "ladder-done"], skipped: ["save", "compact"] },
    { name: "B1 AC-2: a text action is not skipped while a task runs (wait mode off)", cfg: { wait: { enabled: false }, ladder: { keepalives: 0, actions: [{ id: "note", text: "Summarise open work in one line." }] } }, snap: { runningTasks: [runningTask] }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "note" },
    { name: "B1 AC-1: ladder step below keepalives -> KEEPALIVE ladder", state: { keepalives: 0, changedSinceRun: { save: true } }, expect: [ACTION.KEEPALIVE, "ladder"] },
    { name: "B1 AC-1: keep-alives done, save changed, agent 1main -> LADDER_ACTION save", state: { keepalives: 10, changedSinceRun: { save: true } }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "save" },
    { name: "B1 AC-1: save for another agent is skipped, compact runs at the same deadline", state: { keepalives: 10, changedSinceRun: { save: true } }, snap: { agentName: "util-x" }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "compact", skipped: ["save"] },
    { name: "B1 AC-1: save with no agent known is skipped, compact runs", state: { keepalives: 10, changedSinceRun: { save: true } }, snap: { agentName: null }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "compact", skipped: ["save"] },
    { name: "B1 AC-1: save unchanged is skipped, compact runs", state: { keepalives: 10 }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "compact", skipped: ["save"] },
    { name: "B1 AC-1: compact below minContextTokens and save done -> NONE ladder-done", state: { keepalives: 10, nextActionIndex: 1, contextTokens: 149_999 }, expect: [ACTION.NONE, "ladder-done"], skipped: ["compact"] },
    { name: "B1 AC-1: all actions done -> NONE ladder-done", state: { keepalives: 10, nextActionIndex: 2, changedSinceRun: { save: true }, contextTokens: 1 }, expect: [ACTION.NONE, "ladder-done"], skipped: [] },
    { name: "ladder below keepalives, nothing changed -> KEEPALIVE", state: { keepalives: 4 }, expect: [ACTION.KEEPALIVE, "ladder"] },
    { name: "queue state unknown -> NONE (queue-unknown)", snap: { pendingItems: null }, state: { changedSinceRun: { save: true } }, expect: [ACTION.NONE, "queue-unknown"] },
    { name: "queue state unknown beats a running task", snap: { pendingItems: null, runningTasks: [runningTask] }, expect: [ACTION.NONE, "queue-unknown"] },
    { name: "tasks state unknown -> NONE (tasks-unknown), never an action", snap: { runningTasks: null }, state: { keepalives: 10, changedSinceRun: { save: true } }, expect: [ACTION.NONE, "tasks-unknown"] },
    { name: "tasks state unknown does not stop an UNBLOCK", snap: { runningTasks: null, pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.UNBLOCK, "own-command-pending"] },
    { name: "processing unknown without assistant.idle beats an own pending command (not unblocked)", state: { idleSinceLastRequest: false }, snap: { processing: null, pendingItems: [ownSave], ownPendingIds: ["7"] }, expect: [ACTION.NONE, "processing-unknown"] },
    { name: "keep-alives done, context at the threshold -> compact", state: { keepalives: 10, contextTokens: 150_000 }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "compact" },
    { name: "keep-alives done, context below the threshold -> NONE", state: { keepalives: 10, contextTokens: 149_999 }, expect: [ACTION.NONE, "ladder-done"] },
    { name: "only the save action configured and unchanged -> NONE", state: { keepalives: 10 }, cfg: { ladder: { actions: [SAVE_ACTION] } }, expect: [ACTION.NONE, "ladder-done"] },
    { name: "empty action list after the keep-alives -> NONE", state: { keepalives: 10 }, cfg: { ladder: { actions: [] } }, expect: [ACTION.NONE, "ladder-done"] },
    { name: "processing unknown, no assistant.idle since the last request -> NONE", state: { idleSinceLastRequest: false, changedSinceRun: { save: true } }, snap: { processing: null }, expect: [ACTION.NONE, "processing-unknown"] },
    { name: "processing unknown but assistant.idle was seen -> acts like before", state: { keepalives: 10, changedSinceRun: { save: true } }, snap: { processing: null }, expect: [ACTION.LADDER_ACTION, "ladder-action"], actionId: "save" },
    { name: "processing false without assistant.idle (stuck state) -> KEEPALIVE", state: { idleSinceLastRequest: false }, expect: [ACTION.KEEPALIVE, "ladder"] },
    { name: "processing unknown, root tool in flight -> RESCUE (needs no processing flag)", state: { idleSinceLastRequest: false, inFlight: rootTool() }, snap: { processing: null }, expect: [ACTION.RESCUE, "root-tool"] },
];

for (const c of DECIDE_CASES) {
    test(`decide: ${c.name}`, () => {
        const d = decide(trackerState(c.state), snapshot(c.snap), mergeConfig(c.cfg ?? {}));
        assert.deepEqual([d.action, d.reason], c.expect);
        assert.equal(typeof d.detail, "string");
        if (c.actionId !== undefined) assert.equal(d.actionId, c.actionId);
        if (c.skipped !== undefined) assert.deepEqual(d.skipped.map((s) => s.id), c.skipped);
    });
}

test("B1 AC-2: a skipped action names its reason in the decision", () => {
    const d = decide(trackerState({ keepalives: 10, changedSinceRun: { save: true } }), snapshot({ agentName: "util-x" }), mergeConfig({}));
    assert.deepEqual(d.skipped, [{ id: "save", reason: "agent=util-x" }]);
});

test("B1 AC-1: a finished ladder lists what it skipped in the detail", () => {
    const d = decide(trackerState({ keepalives: 10, contextTokens: 1 }), snapshot(), mergeConfig({}));
    assert.equal(d.detail, "save: unchanged since last run; compact: context 1 < 150000");
});

test("decide: an UNBLOCK names the own ids", () => {
    const d = decide(trackerState(), snapshot({ pendingItems: [ownSave], ownPendingIds: ["7"] }), mergeConfig({}));
    assert.match(d.detail, /7/);
});

// ---------- deadline(state, cfg, now) ----------
const DEADLINE_CASES = [
    { name: "idle: expiresAt - marginSec", state: { expiresAt: NOW + 300_000 }, expect: NOW + 270_000 },
    { name: "root tool in flight: expiresAt - rescue.marginSec", state: { expiresAt: NOW + 300_000, inFlight: rootTool() }, expect: NOW + 255_000 },
    { name: "custom margins are honoured", state: { expiresAt: NOW + 300_000, inFlight: rootTool() }, cfg: { marginSec: 10, rescue: { marginSec: 20 } }, expect: NOW + 280_000 },
    { name: "never earlier than now + 1 s (margin already passed)", state: { expiresAt: NOW + 10_000 }, expect: NOW + 1_000 },
    { name: "never earlier than now + 1 s (expiry in the past)", state: { expiresAt: NOW - 5_000 }, expect: NOW + 1_000 },
    { name: "rescue margin also clamps to now + 1 s", state: { expiresAt: NOW + 30_000, inFlight: rootTool() }, expect: NOW + 1_000 },
    { name: "unknown expiry -> null", state: { expiresAt: null }, expect: null },
];

for (const c of DEADLINE_CASES) {
    test(`deadline: ${c.name}`, () => {
        assert.equal(deadline(trackerState(c.state), mergeConfig(c.cfg ?? {}), NOW), c.expect);
    });
}

const MISS_CASES = [
    { name: "mostly cache reads -> hit", ctx: 400_000, cw: 2_000, expect: false },
    { name: "mostly cache writes -> miss", ctx: 400_000, cw: 399_000, expect: true },
    { name: "writes exactly at the ratio -> hit", ctx: 100_000, cw: 50_000, expect: false },
    { name: "small prompts are never misses", ctx: 10_000, cw: 10_000, expect: false },
    { name: "context exactly at the minimum counts", ctx: 20_000, cw: 20_000, expect: true },
];

for (const c of MISS_CASES) {
    test(`isMiss: ${c.name}`, () => {
        assert.equal(isMiss(c.ctx, c.cw, mergeConfig({}).miss), c.expect);
    });
}

const agentTask = (id, toolCallId) => ({ type: "agent", id, toolCallId });
const shellTask = (id) => ({ type: "shell", id });
const tool = (toolCallId, name, shellId = null) => ({ toolCallId, name, shellId });

const PICK_CASES = [
    { name: "agent task whose toolCallId belongs to the root", candidates: [agentTask("a1", "tc1")], tools: [tool("tc1", "task")], expect: { task: agentTask("a1", "tc1") } },
    { name: "agent task of another agent is not promoted", candidates: [agentTask("a1", "tcX")], tools: [tool("tc1", "task")], expect: { task: null } },
    { name: "root agent task wins over a sub-agent shell listed first", candidates: [shellTask("s3"), agentTask("a9", "tc-root")], tools: [tool("tc-root", "task")], expect: { task: agentTask("a9", "tc-root") } },
    { name: "no shell tool in flight -> nothing", candidates: [shellTask("1")], tools: [tool("tc1", "ask_user")], expect: { task: null } },
    { name: "shell matched by the shellId the root passed", candidates: [shellTask("other"), shellTask("build")], tools: [tool("tc1", "powershell", "build")], expect: { task: shellTask("build") } },
    { name: "single shell and single root shell tool", candidates: [shellTask("12")], tools: [tool("tc1", "powershell")], expect: { task: shellTask("12") } },
    { name: "bash and shell tool names count as shells", candidates: [shellTask("12")], tools: [tool("tc1", "bash")], expect: { task: shellTask("12") } },
    { name: "several shells without a unique match are ambiguous", candidates: [shellTask("0"), shellTask("0")], tools: [tool("tc1", "powershell")], expect: { task: null, ambiguous: true } },
    { name: "shell tool but no shell candidates -> nothing, not ambiguous", candidates: [], tools: [tool("tc1", "powershell")], expect: { task: null, ambiguous: false } },
    { name: "two root shell tools and one candidate are not matched", candidates: [shellTask("5")], tools: [tool("tc1", "powershell"), tool("tc2", "powershell")], expect: { task: null, ambiguous: false } },
];

for (const c of PICK_CASES) {
    test(`pickRootTask: ${c.name}`, () => {
        assert.deepEqual(pickRootTask(c.candidates, c.tools), c.expect);
    });
}

test("B1 AC-15: a LADDER_ACTION decision carries the action's index", () => {
    const cfg = mergeConfig({});
    const saveDue = decide(trackerState({ keepalives: 10, changedSinceRun: { save: true } }), snapshot(), cfg);
    const compactDue = decide(trackerState({ keepalives: 10 }), snapshot(), cfg);
    const keepalive = decide(trackerState({ keepalives: 0 }), snapshot(), cfg);
    assert.deepEqual([saveDue.action, saveDue.index], [ACTION.LADDER_ACTION, 0]);
    assert.deepEqual([compactDue.action, compactDue.index], [ACTION.LADDER_ACTION, 1]);
    assert.deepEqual([keepalive.action, keepalive.index], [ACTION.KEEPALIVE, null]);
});

const waitEndReason = (...args) => policy.waitEndReason(...args);

const WAIT_END_CASES = [
    { name: "no running task -> null", state: { keepalives: 10, nextActionIndex: 2, waitRefreshes: 50 }, facts: { runningTaskCount: 0 }, expect: null },
    { name: "task, wait on, below the cap -> null", state: { waitRefreshes: 0 }, facts: { runningTaskCount: 1 }, expect: null },
    { name: "task, wait on, cap reached -> cap", state: { waitRefreshes: 50 }, facts: { runningTaskCount: 1 }, expect: "cap" },
    { name: "task, wait off, ladder done -> off", state: { keepalives: 10, nextActionIndex: 2 }, cfg: { wait: { enabled: false } }, facts: { runningTaskCount: 1 }, expect: "off" },
    { name: "task, wait off, keep-alives left -> null", state: { keepalives: 0 }, cfg: { wait: { enabled: false } }, facts: { runningTaskCount: 1 }, expect: null },
];

for (const c of WAIT_END_CASES) {
    test(`B1 AC-16: waitEndReason: ${c.name}`, () => {
        assert.equal(waitEndReason({ ...base, ...c.state }, mergeConfig(c.cfg ?? {}), { agentName: "1main", ...c.facts }), c.expect);
    });
}
