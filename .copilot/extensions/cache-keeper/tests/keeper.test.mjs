import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "../lib/config.mjs";
import { createKeeper } from "../lib/keeper.mjs";
import { T0, fakeClock, fakeSession, fakeTransport, flush } from "./helpers/fakes.mjs";
import { createTransport } from "../lib/transport.mjs";
import { render } from "../lib/statusline-render.mjs";
import { COMPACT_ACTION, SAVE_ACTION } from "./helpers/ladder-fixtures.mjs";
import { TRANSPORT_TIMEOUT } from "../lib/contracts.mjs";

/** The shipped actions run at the first deadline. */
const FIRST_ACTION = { ladder: { keepalives: 0 } };

function setup(cfgOver = {}, tOver = {}) {
    const clock = fakeClock(), transport = fakeTransport(tOver), logs = [];
    let state = null;
    const cfg = mergeConfig(cfgOver);
    const k = createKeeper({ transport, cfg, clock, log: (m) => logs.push(m), writeState: (s) => { state = s; } });
    return { clock, transport, logs, k, cfg, st: () => state };
}
// one root model request: start -> (stream durMs) -> usage
async function request(env, { ctx = 200_000, cw = 1_000, durMs = 2_000, nanoAiu } = {}) {
    const start = env.clock.now();
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(durMs);
    const copilotUsage = nanoAiu === undefined ? {} : { copilotUsage: { totalNanoAiu: nanoAiu } };
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: ctx, cacheReadTokens: ctx - cw, cacheWriteTokens: cw, cacheExpiresAt: new Date(start + 300_000).toISOString(), ...copilotUsage } });
}
const idle = (env) => env.k.onEvent({ type: "assistant.idle", data: {} });
async function userTurn(env, text = "hello", o) { env.k.onEvent({ type: "user.message", data: { content: text } }); await request(env, o); idle(env); }
// the CLI echoes injected prompts as user.message and runs a turn for them
async function answerInjected(env, from) {
    const sends = env.transport.calls.sends.slice(from.s), cmds = env.transport.calls.enqueued.slice(from.c);
    from.s += sends.length; from.c += cmds.length;
    for (const text of [...sends, ...cmds]) { env.k.onEvent({ type: "user.message", data: { content: text } }); await request(env); idle(env); }
    return sends.length + cmds.length;
}
async function runIdleLadder(env, maxSteps = 80) {
    const from = { s: env.transport.calls.sends.length, c: env.transport.calls.enqueued.length };
    for (let i = 0; i < maxSteps; i++) { await env.clock.advance(300_000); if (!(await answerInjected(env, from))) break; }
}

test("C1: request start sets a provisional expiry (lifetime starts with the request); usage replaces it", async () => {
    const env = setup();
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    assert.equal(env.st().expiresAt, T0 + 300_000);
    assert.equal(env.st().provisional, true);
    await env.clock.advance(56_000); // long streaming response
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 1000, cacheExpiresAt: new Date(T0 + 300_500).toISOString() } });
    assert.equal(env.st().provisional, false);
    assert.equal(env.st().expiresAt, T0 + 300_500);
    assert.ok(env.logs.some((l) => /provisionalDelta=1s|provisionalDelta=0s/.test(l)));
});

test("B1 AC-1: shipped config: 10 keep-alives, then /save, then /compact, one per deadline, then nothing", async () => {
    const env = setup();
    await userTurn(env);
    const from = { s: 0, c: 0 };
    for (let i = 1; i <= 10; i++) {
        await env.clock.advance(300_000);
        assert.equal(env.transport.calls.sends.length, i);
        assert.deepEqual(env.transport.calls.enqueued, []);
        await answerInjected(env, from);
    }
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
    await answerInjected(env, from);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/compact"]);
    await answerInjected(env, from);
    await env.clock.advance(300_000);
    assert.equal(sentCount(env), 12);
    assert.equal(env.k.stats.waitKeepalives, 0);
    assert.equal(env.st().ladderDone, true);
});

test("B1 AC-1: /save is skipped for agents other than 1main and logged", async () => {
    const env = setup(FIRST_ACTION, { agent: "util-workflow-analyst" });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
    assert.equal(env.transport.calls.sends.length, 0);
    assert.ok(env.logs.some((l) => l.includes("action save skipped: agent=util-workflow-analyst")));
});

test("queued user input suppresses the action", async () => {
    const env = setup();
    await userTurn(env);
    env.transport.pending = true;
    await env.clock.advance(300_000);
    assert.equal(env.transport.calls.sends.length + env.transport.calls.enqueued.length, 0);
});

test("a real user message resets the ladder", async () => {
    const env = setup({ ladder: { keepalives: 2, actions: [SAVE_ACTION] } });
    await userTurn(env);
    await runIdleLadder(env);
    const before = env.transport.calls.sends.length + env.transport.calls.enqueued.length;
    assert.equal(before, 3);
    await userTurn(env, "I am back");
    await runIdleLadder(env);
    assert.equal(env.transport.calls.sends.length + env.transport.calls.enqueued.length, 6);
});

test("C3: while background tasks run, keep-alives do not consume the ladder and nothing is compacted", async () => {
    const env = setup({ wait: { maxRefreshes: 30 } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env, "/1implement");
    // 2 hours of workers running while the user is away
    const from = { s: 0, c: 0 };
    for (let i = 0; i < 26; i++) { await env.clock.advance(300_000); await answerInjected(env, from); }
    assert.deepEqual(env.transport.calls.enqueued, []); // a running task skips command actions: no /save, no /compact
    assert.equal(env.st().keepalives, 0);
    assert.equal(env.k.stats.waitKeepalives, 26);
    assert.equal(env.st().ladderDone, false);
    // workers finish: the ladder applies again, starting with its keep-alives; the save stayed changed
    env.transport.tasks = [];
    await runIdleLadder(env);
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/compact"]);
    assert.equal(env.k.stats.keepalives, 10);
});

test("C3: wait keep-alives stop at wait.maxRefreshes", async () => {
    const env = setup({ wait: { maxRefreshes: 3 }, ladder: { actions: [COMPACT_ACTION] } }, { tasks: [{ type: "shell", id: "7", status: "running" }] });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    for (let i = 0; i < 10; i++) { await env.clock.advance(300_000); await answerInjected(env, from); }
    assert.equal(env.k.stats.waitKeepalives, 3);
    assert.ok(env.logs.some((l) => l.startsWith("wait cap reached")));
});

test("C3: ladder exhausted after compaction + tasks running -> wait keep-alives continue", async () => {
    const env = setup({ ladder: { keepalives: 1, actions: [COMPACT_ACTION] } });
    await userTurn(env);
    await runIdleLadder(env); // keepalive, compact
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
    env.transport.tasks = [{ type: "agent", id: "w2", status: "running" }];
    env.k.onEvent({ type: "system.notification", data: {} });
    await request(env); idle(env); // a notification-driven turn (no user.message)
    await env.clock.advance(300_000);
    assert.equal(env.k.stats.waitKeepalives, 1);
});

test("C2: root busy in a sync shell -> promoted shortly before expiry", async () => {
    const env = setup({ rescue: { marginSec: 45 } }, { promotable: { type: "shell", id: "12", status: "running", executionMode: "sync" } });
    env.k.onEvent({ type: "user.message", data: { content: "run the build" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    await env.clock.advance(250_000); // rescue fires at start+255s
    assert.deepEqual(env.transport.calls.promoted, []);
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.promoted, ["12"]);
    assert.equal(env.k.stats.rescues, 1);
});

test("C2: sync subagent promoted only when its toolCallId belongs to the root", async () => {
    const env = setup({}, { promotable: { type: "agent", id: "a1", toolCallId: "tcX", status: "running" } });
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc-root", toolName: "task" } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, []);
    assert.equal(env.k.stats.unrescued, 1);

    const env2 = setup({}, { promotable: { type: "agent", id: "a2", toolCallId: "tc-root", status: "running" } });
    env2.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env2);
    env2.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc-root", toolName: "task" } });
    await env2.clock.advance(300_000);
    assert.deepEqual(env2.transport.calls.promoted, ["a2"]);
});

test("C2: ask_user cannot be rescued and is logged", async () => {
    const env = setup();
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "ask_user" } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, []);
    assert.ok(env.logs.some((l) => l.includes("rescue impossible: waiting in ask_user")));
});

test("C2: no rescue when the tool finishes and the turn continues or ends in time", async () => {
    const env = setup();
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    await env.clock.advance(100_000);
    env.k.onEvent({ type: "tool.execution_complete", data: { toolCallId: "tc1" } });
    await request(env); // next request re-anchors expiry
    idle(env);
    await env.clock.advance(260_000);
    assert.equal(env.k.stats.rescues + env.k.stats.unrescued, 0);
});

test("sub-agent events are ignored", async () => {
    const env = setup();
    env.k.onEvent({ type: "assistant.turn_start", agentId: "sub1", data: {} });
    env.k.onEvent({ type: "user.message", agentId: "sub1", data: { content: "prompt for worker" } });
    assert.equal(env.st().expiresAt, null);
    assert.equal(env.st().provisional, false);
    assert.equal(env.st().nextAction, null);
});

test("C4: hit/miss classification", async () => {
    const env = setup();
    await request(env, { ctx: 400_000, cw: 2_000 });
    await request(env, { ctx: 400_000, cw: 399_000 });
    await request(env, { ctx: 10_000, cw: 10_000 }); // small prompts are never counted as misses
    assert.equal(env.k.stats.hits, 2);
    assert.equal(env.k.stats.misses, 1);
});
test("C2: picks the root's sync agent task from tasks.list even when a sub-agent shell is listed first", async () => {
    const env = setup({}, { tasks: [
        { type: "shell", id: "sub-shell-3", status: "running", executionMode: "sync", canPromoteToBackground: true },
        { type: "agent", id: "a9", toolCallId: "tc-root", status: "running", executionMode: "sync", canPromoteToBackground: true },
    ] });
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc-root", toolName: "task" } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, ["a9"]);
});

test("C2: shell matched by shellId when the root passed one", async () => {
    const env = setup({}, { tasks: [
        { type: "shell", id: "other", status: "running", executionMode: "sync" },
        { type: "shell", id: "build", status: "running", executionMode: "sync" },
    ] });
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell", arguments: { shellId: "build" } } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, ["build"]);
});
test("C2: ambiguous shells (root and sub-agent both '0'-style ids, no shellId) are not promoted", async () => {
    const env = setup({}, { tasks: [
        { type: "shell", id: "0", status: "running", executionMode: "sync" },
        { type: "shell", id: "0", status: "running", executionMode: "sync" },
    ] });
    env.k.onEvent({ type: "user.message", data: { content: "x" } });
    await request(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, []);
    assert.ok(env.logs.some((l) => l.includes("not promoting")));
});

test("C3: a wait keep-alive does not consume the ladder", async () => {
    const env = setup({}, { agent: "util-workflow-analyst", tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.equal(env.st().keepalives, 0);
    assert.equal(env.k.stats.waitKeepalives, 1);
});

test("AC-10: the published state carries lastRefreshAt and lastRefreshKind of the last keeper-started request", async () => {
    const env = setup({ ladder: { keepalives: 1 } });
    await userTurn(env);
    assert.deepEqual([env.st().lastRefreshAt, env.st().lastRefreshKind], [null, null]);
    const from = { s: 0, c: 0 };
    await env.clock.advance(300_000); // keep-alive
    await answerInjected(env, from);
    assert.equal(env.st().lastRefreshKind, "keepalive");
    assert.equal(env.st().lastRefreshAt, env.clock.now());
    await env.clock.advance(300_000); // save
    await answerInjected(env, from);
    assert.equal(env.st().lastRefreshKind, "action");
    env.transport.tasks = [{ type: "agent", id: "w1", status: "running" }];
    await env.clock.advance(300_000); // wait keep-alive
    await answerInjected(env, from);
    assert.equal(env.st().lastRefreshKind, "wait");
    assert.equal(env.st().lastRefreshAt, env.clock.now());
});

test("B1 AC-6: the published state carries the price of the keep-alive's first root request", async () => {
    const env = setup();
    await userTurn(env);
    await env.clock.advance(300_000); // keep-alive
    assert.equal(env.transport.calls.sends.length, 1);
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    await request(env, { nanoAiu: 11_898_860_000 });
    await request(env, { nanoAiu: 5 });
    idle(env);
    assert.equal(env.st().lastRefreshNanoAiu, 11_898_860_000);
    assert.equal(env.st().lastRefreshKind, "keepalive");
});

// ---------- deadline-driven decisions (T2) ----------
test("B3 AC-13: the published state carries the saving and the miss flag of the keep-alive's first root request", async () => {
    const env = setup();
    await userTurn(env);
    await env.clock.advance(300_000); // keep-alive
    assert.equal(env.transport.calls.sends.length, 1);
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    const tokenDetails = [
        { tokenType: "cache_read", costPerBatch: 20_000_000_000, batchSize: 1_000_000, tokenCount: 498_717, model: "claude-opus-5.5" },
        { tokenType: "cache_write", costPerBatch: 500_000_000_000, batchSize: 1_000_000, tokenCount: 119, model: "claude-opus-5.5" },
    ];
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 498_840, cacheReadTokens: 498_717, cacheWriteTokens: 119, cacheTtlSeconds: 300, copilotUsage: { totalNanoAiu: 10_000_000_000, tokenDetails } } });
    idle(env);
    assert.deepEqual([env.st().lastRefreshNanoAiu, env.st().lastRefreshSavedNanoAiu, env.st().lastRefreshMiss], [10_000_000_000, 498_717 * (500_000 - 20_000), false]);
});

test("B3 AC-13: the published state flags a keep-alive that was a cache miss, with no saving", async () => {
    const env = setup();
    await userTurn(env);
    await env.clock.advance(300_000); // keep-alive
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 498_930, cacheReadTokens: 0, cacheWriteTokens: 498_926, copilotUsage: { totalNanoAiu: 249_472_600_000 } } });
    idle(env);
    assert.deepEqual([env.st().lastRefreshNanoAiu, env.st().lastRefreshSavedNanoAiu, env.st().lastRefreshMiss], [249_472_600_000, null, true]);
});

// the user speaks and the root answers, but the turn ends WITHOUT assistant.idle (the stuck state of the live bug)
async function stuckTurn(env, text = "hello") { env.k.onEvent({ type: "user.message", data: { content: text } }); await request(env); }
const logged = (env, re) => env.logs.filter((l) => re.test(l));
const sentCount = (env) => env.transport.calls.sends.length + env.transport.calls.enqueued.length;

test("AC-4: a turn that ended without assistant.idle still gets a keep-alive before the cache expires", async () => {
    const env = setup();
    await stuckTurn(env);
    await env.clock.advance(267_000); // deadline: expiry (start + 300 s) - 30 s = start + 270 s
    assert.equal(sentCount(env), 0);
    await env.clock.advance(5_000);
    assert.deepEqual(env.transport.calls.sends, [env.cfg.keepaliveText]);
    assert.equal(logged(env, /^keepalive #1/).length, 1);
});

test("AC-4: the same stuck state with a background task running gets a wait keep-alive", async () => {
    const env = setup({}, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await stuckTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.sends, [env.cfg.keepaliveText]);
    assert.deepEqual(env.transport.calls.enqueued, []);
    assert.equal(logged(env, /^wait-keepalive #1/).length, 1);
    assert.equal(env.st().keepalives, 0);
});

test("AC-5: /save is not queued while a task runs, and is queued once the task has ended", async () => {
    const env = setup({ ladder: { keepalives: 0 } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, []);
    await answerInjected(env, from);
    env.transport.tasks = [];
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
    assert.equal(env.k.stats.actions, 1);
});

test("B1: with wait mode off a running task skips command actions and logs why", async () => {
    const env = setup({ wait: { enabled: false }, ladder: { keepalives: 0 } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, []);
    assert.equal(env.transport.calls.sends.length, 0);
    assert.equal(logged(env, /^action save skipped: 1 background task\(s\) running/).length, 1);
});

test("B1 AC-1: /save is skipped without a user message since the last save; /compact still runs", async () => {
    const env = setup(FIRST_ACTION);
    await userTurn(env, "/save");
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
    assert.equal(env.transport.calls.sends.length, 0);
    assert.equal(logged(env, /^action save skipped: unchanged since last run/).length, 1);
});

test("B1 AC-1: /compact is skipped below 150,000 context tokens", async () => {
    const env = setup({ ladder: { keepalives: 0, actions: [COMPACT_ACTION] } });
    await userTurn(env, "hello", { ctx: 149_999 });
    await env.clock.advance(300_000);
    assert.equal(sentCount(env), 0);
    assert.equal(logged(env, /^action compact skipped: context 149999 < 150000/).length, 1);
});

test("B1 AC-2: actions run in JSON order: compact before save when listed first", async () => {
    const env = setup({ ladder: { keepalives: 1, actions: [COMPACT_ACTION, SAVE_ACTION] } });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    await env.clock.advance(300_000);
    assert.equal(env.transport.calls.sends.length, 1);
    assert.deepEqual(env.transport.calls.enqueued, []);
    await answerInjected(env, from);
    await env.clock.advance(300_000);
    await answerInjected(env, from);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/compact", "/save"]);
});

test("B1 AC-2: a failing condition skips to the next action at the same deadline", async () => {
    const big = { id: "big", command: "/compact", when: { minContextTokens: 10_000_000 } };
    const env = setup({ ladder: { keepalives: 0, actions: [big, SAVE_ACTION] } });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
    assert.equal(logged(env, /^action big skipped:/).length, 1);
});

test("B1 AC-2: an empty action list sends keep-alives only, then nothing", async () => {
    const env = setup({ ladder: { keepalives: 2, actions: [] } });
    await userTurn(env);
    await runIdleLadder(env);
    assert.equal(env.transport.calls.sends.length, 2);
    assert.deepEqual(env.transport.calls.enqueued, []);
    assert.equal(env.st().ladderDone, true);
});

test("B1 AC-2: a text action is sent as a prompt and its echo is the keeper's own", async () => {
    const text = "Summarise open work in one line.";
    const env = setup({ ladder: { keepalives: 0, actions: [{ id: "note", text }] } });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.sends, [text]);
    assert.deepEqual(env.transport.calls.enqueued, []);
    env.k.onEvent({ type: "user.message", data: { content: text } });
    await request(env); idle(env);
    assert.equal(env.st().lastRefreshKind, "action");
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.sends, [text]);
});

// A save queued by the keeper that the CLI does not run (stuck behind background work).
async function stuckSave(tOver = {}) {
    const env = setup(FIRST_ACTION, { stuckCommands: true, ...tOver });
    await userTurn(env);
    await env.clock.advance(268_000); // deadline at start + 270 s: /save is queued and the CLI holds it back
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
    return env;
}

test("AC-6: an own pending /save is removed, the first foreign message is steered with sendNow, foreign items stay", async () => {
    const env = await stuckSave();
    env.transport.items.push({ id: "c9", kind: "command", displayText: "/other" }, { id: "m1", kind: "message", displayText: "do this" }, { id: "m2", kind: "message", displayText: "and that" });
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
    assert.deepEqual(env.transport.calls.sentNow, ["m1"]);
    assert.deepEqual(env.transport.calls.sends, []);
    assert.deepEqual(env.transport.items.map((i) => i.id), ["c9", "m2"]);
    assert.equal(logged(env, /^unblock removed=q1 then=sendNow:m1$/).length, 1);
});

test("AC-6: without a foreign message the own /save is removed and a keep-alive is sent", async () => {
    const env = await stuckSave();
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
    assert.deepEqual(env.transport.calls.sentNow, []);
    assert.deepEqual(env.transport.calls.sends, [env.cfg.keepaliveText]);
    assert.equal(logged(env, /^unblock removed=q1 then=keepalive$/).length, 1);
    // the keep-alive runs: its request is labelled "unblock"
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    await request(env);
    assert.equal(env.st().lastRefreshKind, "unblock");
});

test("B1 AC-3: a removed /save (retry) runs again at the next deadline; a second removal counts as done", async () => {
    const env = setup({ ladder: { keepalives: 0, actions: [SAVE_ACTION] } }, { stuckCommands: true });
    await userTurn(env);
    for (let round = 0; round < 2; round++) {
        await env.clock.advance(300_000); // /save is queued and held back; 10 s later the unblock removes it and sends a keep-alive
        env.k.onEvent({ type: "user.message", data: { content: env.transport.calls.sends.at(-1) } });
        await request(env); idle(env);
    }
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/save"]);
    assert.deepEqual(env.transport.calls.removed, ["q1", "q2"]);
    assert.equal(env.transport.calls.sends.length, 2);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/save"]);
    assert.equal(env.transport.calls.sends.length, 2);
    assert.equal(env.st().ladderDone, true);
});

test("AC-6: a steered message is a real user message: it is labelled unblock and restarts the ladder", async () => {
    const env = await stuckSave();
    env.transport.items.push({ id: "m1", kind: "message", displayText: "do this" });
    await env.clock.advance(10_000);
    env.k.onEvent({ type: "user.message", data: { content: "do this" } });
    await request(env); idle(env);
    assert.equal(env.st().lastRefreshKind, "unblock");
    assert.equal(env.st().keepalives, 0);
    assert.equal(env.st().nextLabel, "/save");
});

test("B1 AC-3: foreign queue items are never removed", async () => {
    const env = setup();
    await userTurn(env);
    env.transport.items.push({ id: "c9", kind: "command", displayText: "/other" });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.removed, []);
    assert.deepEqual(env.transport.calls.sentNow, []);
    assert.equal(sentCount(env), 0);
    assert.equal(logged(env, /^skip: input already queued$/).length, 1);
});

test("AC-6 / W3: an own command that has left the queue is not unblocked and the normal deadline is armed again", async () => {
    const env = await stuckSave();
    env.transport.items = []; // the CLI started it after all, but no event arrived
    await env.clock.advance(10_000); // re-check finds nothing held back
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(sentCount(env), 1);
    assert.equal(env.clock.timerCount(), 1);
    await env.clock.advance(2_000);
    assert.deepEqual(env.transport.calls.removed, []);
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/compact"]); // the ladder goes on with its next action
});

test("S5 / W-C: a pending item of another kind or name is not removed; the item stays tracked and a keep-alive refreshes the cache", async () => {
    for (const item of [{ id: "q1", kind: "command", displayText: "/something-else" }, { id: "q1", kind: "message", displayText: "/save" }]) {
        const env = await stuckSave();
        env.transport.items = [item]; // the id was reused by something else
        await env.clock.advance(10_000);
        assert.deepEqual(env.transport.calls.removed, [], JSON.stringify(item));
        assert.equal(logged(env, /^unblock skipped: pending item q1 is not our \/save/).length, 1);
        assert.deepEqual(env.transport.calls.sends, [env.cfg.keepaliveText]);
        assert.equal(logged(env, /^unblock skipped=q1 then=keepalive$/).length, 1);
    }
});

test("W-C: a matching command item with arguments in displayText is removed", async () => {
    const env = await stuckSave();
    env.transport.items = [{ id: "q1", kind: "command", displayText: "/save with some arguments", agentMode: "interactive" }];
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
    assert.equal(logged(env, /^unblock removed=q1 then=keepalive$/).length, 1);
});

test("W-C: a non-matching item that the keeper tracked gets one keep-alive and is then left alone", async () => {
    const env = setup(FIRST_ACTION, { stuckCommands: true });
    await userTurn(env);
    await env.clock.advance(268_000); // /save queued as q1 (first action)
    env.transport.items = [{ id: "q1", kind: "command", displayText: "/other" }]; // q1 is not our command (any more)
    await env.clock.advance(10_000); // re-check: skipped, keep-alive, no longer tracked
    assert.equal(env.transport.calls.sends.length, 1);
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    await request(env); idle(env);
    await env.clock.advance(600_000); // later deadlines see a foreign item: input queued, nothing more
    assert.equal(env.transport.calls.sends.length, 1);
    assert.deepEqual(env.transport.calls.removed, []);
});

test("B1 AC-3: a removed /compact (skip) counts as done", async () => {
    const env = setup({ ladder: { keepalives: 2, actions: [COMPACT_ACTION] } }, { stuckCommands: true });
    await userTurn(env);
    let seen = 0;
    for (let i = 0; i < 12; i++) {
        await env.clock.advance(300_000);
        const fresh = env.transport.calls.sends.slice(seen);
        seen = env.transport.calls.sends.length;
        if (!fresh.length) break;
        for (const text of fresh) { env.k.onEvent({ type: "user.message", data: { content: text } }); await request(env); idle(env); }
    }
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
    assert.equal(env.st().ladderDone, true);
});

test("S-a: retries stop marginSec/3 before the cache expires", async () => {
    const env = setup();
    await userTurn(env);
    let attempts = 0;
    env.transport.sendPrompt = async () => { attempts++; return false; };
    await env.clock.advance(299_000); // cache (start + 300 s) is about to expire
    assert.equal(attempts, 3); // at +270 s, +280 s and +290 s (= expiry - 10 s); no retry at +300 s
    assert.equal(env.clock.timerCount(), 0);
});

test("AC-6: when the own command cannot be removed nothing else is sent", async () => {
    const env = await stuckSave();
    env.transport.removeQueued = async () => false;
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.sends, []);
    assert.deepEqual(env.transport.calls.sentNow, []);
    assert.equal(logged(env, /^unblock failed/).length, 1);
    assert.equal(env.k.stats.actions, 1);
});

test("AC-6: the echo of an own command ends its tracking (a later deadline does not unblock it)", async () => {
    const env = setup(FIRST_ACTION, { stuckCommands: true });
    await userTurn(env);
    await env.clock.advance(268_000); // /save queued as q1, still in the (fake) queue
    env.k.onEvent({ type: "user.message", data: { content: "/save" } }); // ... but it ran: echo arrives
    await request(env); idle(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.removed, []);
});

test("AC-7: model busy without a root tool: no action and exactly one log line", async () => {
    const env = setup({}, { processing: true });
    await stuckTurn(env);
    await env.clock.advance(300_000);
    assert.equal(sentCount(env), 0);
    assert.equal(logged(env, /busy-model/).length, 1);
});

test("AC-8: with a root tool in flight the deadline is rescue.marginSec before expiry", async () => {
    const env = setup({ rescue: { marginSec: 60 } }, { promotable: { type: "shell", id: "12", status: "running", executionMode: "sync" } });
    await stuckTurn(env, "run the build");
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    assert.equal(env.st().rescueAt, env.st().expiresAt - 60_000);
    assert.equal(env.st().nextAt, null);
    await env.clock.advance(236_000);
    assert.deepEqual(env.transport.calls.promoted, []);
    await env.clock.advance(4_000);
    assert.deepEqual(env.transport.calls.promoted, ["12"]);
});

test("AC-8: rescue disabled -> a root tool in flight is left alone", async () => {
    const env = setup({ rescue: { enabled: false } });
    await stuckTurn(env);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.promoted, []);
    assert.equal(sentCount(env), 0);
});

test("AC-9: isProcessing unknown and no assistant.idle since the last request: no action, reason logged", async () => {
    const env = setup({}, { processing: null });
    await stuckTurn(env);
    await env.clock.advance(300_000);
    assert.equal(sentCount(env), 0);
    assert.equal(logged(env, /processing state unknown/).length, 1);
});

test("AC-9: isProcessing unknown but assistant.idle was seen after the last request: acts as before", async () => {
    const env = setup(FIRST_ACTION, { processing: null });
    await userTurn(env);
    await env.clock.advance(300_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
});

test("AC-9: a failing isProcessing RPC is logged by the transport; the keeper acts only if assistant.idle was seen", async () => {
    const failing = () => realEnv({ fail: ["metadata.isProcessing"] });
    const withoutIdle = failing();
    await stuckTurn(withoutIdle);
    await withoutIdle.clock.advance(300_000);
    assert.equal(withoutIdle.session.calls.sends.length, 0);
    assert.ok(withoutIdle.logs.some((l) => l.startsWith("is-processing-error")));
    assert.ok(withoutIdle.logs.some((l) => /processing state unknown/.test(l)));

    const withIdle = failing();
    await stuckTurn(withIdle);
    idle(withIdle);
    await withIdle.clock.advance(300_000);
    assert.equal(withIdle.session.calls.sends.length, 1);
    assert.ok(withIdle.logs.some((l) => l.startsWith("is-processing-error")));
});

test("exactly one deadline timer is armed while the expiry is known and in the future", async () => {
    const env = setup();
    assert.equal(env.clock.timerCount(), 0);
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    assert.equal(env.clock.timerCount(), 1);
    await request(env);
    assert.equal(env.clock.timerCount(), 1);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "view" } });
    env.k.onEvent({ type: "tool.execution_complete", data: { toolCallId: "tc1" } });
    idle(env);
    assert.equal(env.clock.timerCount(), 1);
    await env.clock.advance(1_000_000); // save (nobody answers), recheck, then the cache is gone
    assert.equal(env.clock.timerCount(), 0);
});

test("B1 AC-5: published state: step counter over keep-alives plus actions and the next label", async () => {
    const env = setup();
    await userTurn(env);
    assert.deepEqual([env.st().step, env.st().steps, env.st().nextAction, env.st().nextLabel], [1, 12, "keepalive", "keepalive"]);
    const from = { s: 0, c: 0 };
    for (let i = 0; i < 10; i++) { await env.clock.advance(300_000); await answerInjected(env, from); }
    assert.deepEqual([env.st().step, env.st().steps, env.st().nextAction, env.st().nextLabel, env.st().keepalives], [11, 12, "action", "/save", 10]);
});

test("B1 AC-5: shipped config: after the last action and with no running task the published state is ladder done with no next step", async () => {
    const env = setup();
    await userTurn(env);
    const from = { s: 0, c: 0 };
    for (let i = 0; i < 12; i++) { await env.clock.advance(300_000); await answerInjected(env, from); } // 10 keep-alives, /save, /compact
    assert.deepEqual(env.transport.calls.enqueued, ["/save", "/compact"]);
    assert.equal(env.transport.calls.sends.length, 10);
    assert.deepEqual([env.st().ladderDone, env.st().nextAction, env.st().nextAt], [true, null, null]);
    assert.match(render(env.st(), env.clock.now()), /^main cache until \d\d:\d\d:\d\d \| ladder done, waiting for you$/);
});

test("B1 AC-5: with a running background task the forecast after the ladder is a wait keep-alive", async () => {
    const env = setup();
    await userTurn(env);
    const from = { s: 0, c: 0 };
    for (let i = 0; i < 12; i++) { await env.clock.advance(300_000); await answerInjected(env, from); } // the ladder is done, no task ran
    env.transport.tasks = [{ type: "agent", id: "w1", status: "running" }];
    await env.clock.advance(300_000); // the next deadline sees the running task
    await answerInjected(env, from);
    assert.equal(env.k.stats.waitKeepalives, 1);
    assert.deepEqual([env.st().nextAction, env.st().ladderDone], ["wait", false]);
});

test("B1 AC-5: a running background task is never reported as ladder done", async () => {
    const env = setup({ ladder: { keepalives: 0, actions: [] }, wait: { maxRefreshes: 0 } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    await env.clock.advance(270_000); // the deadline: the snapshot sees the running task and the wait cap (0) is reached
    assert.equal(env.k.stats.waitKeepalives, 0);
    assert.deepEqual([env.st().nextAction, env.st().ladderDone], [null, false]);
    assert.equal(render(env.st(), env.clock.now()).includes("ladder done"), false);
});

test("B1 AC-16: a running task with the wait cap reached publishes waitEnd cap and no next step", async () => {
    const env = setup({ wait: { maxRefreshes: 1 } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    await env.clock.advance(270_000); // the deadline: a running task, the wait budget (1) is still unused
    assert.equal(await answerInjected(env, from), 1);
    await env.clock.advance(270_000); // the next deadline: the budget is used up
    assert.equal(env.k.stats.waitKeepalives, 1);
    assert.deepEqual([env.st().waitEnd, env.st().nextAction], ["cap", null]);
});

test("B1 AC-16: a running task with wait disabled publishes waitEnd off once the ladder is done", async () => {
    const env = setup({ wait: { enabled: false }, ladder: { keepalives: 0, actions: [] } }, { tasks: [{ type: "agent", id: "w1", status: "running" }] });
    await userTurn(env);
    await env.clock.advance(270_000); // the deadline: the snapshot sees the running task; the ladder has nothing left
    assert.deepEqual([env.st().waitEnd, env.st().nextAction], ["off", null]);
});

test("B1 AC-16: without a running task waitEnd is null", async () => {
    const env = setup({ wait: { maxRefreshes: 0 }, ladder: { keepalives: 0, actions: [] } });
    await userTurn(env);
    await env.clock.advance(270_000); // the deadline: no task runs, the ladder is done
    assert.deepEqual([env.st().waitEnd, env.st().nextAction], [null, null]);
});

test("published state: rescue time while a tool runs", async () => {
    const env = setup();
    await userTurn(env);
    assert.deepEqual([env.st().nextAction, env.st().nextAt, env.st().rescueAt], ["keepalive", T0 + 270_000, null]);
    env.k.onEvent({ type: "user.message", data: { content: "again" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } });
    assert.deepEqual([env.st().nextAction, env.st().nextAt, env.st().busyTools], [null, null, ["powershell"]]);
    assert.equal(env.st().rescueAt, env.st().expiresAt - 45_000);
});

test("race: an event that arrives while the snapshot is being taken cancels the decision", async () => {
    const env = setup();
    await userTurn(env);
    let release;
    env.transport.isProcessing = () => new Promise((resolve) => { release = resolve; });
    await env.clock.advance(300_000); // deadline fires, snapshot waits for isProcessing
    env.k.onEvent({ type: "assistant.turn_start", data: {} }); // the model starts a new request in the meantime
    release(false);
    await flush(); await flush();
    assert.equal(sentCount(env), 0);
});

// ---------- review follow-ups: W1..W5, S4 ----------
function realEnv(sessionOpts, cfgOver = {}) {
    const clock = fakeClock(), session = fakeSession(sessionOpts), logs = [];
    const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now };
    const k = createKeeper({ transport: createTransport(session, (m) => logs.push(m), timers), cfg: mergeConfig(cfgOver), clock, log: (m) => logs.push(m), writeState: () => {} });
    return { clock, session, logs, k, cfg: mergeConfig(cfgOver) };
}

test("W-B: a hung RPC does not wedge the keeper: the timeout yields the fallback and later decisions still run", async () => {
    const env = realEnv({}, FIRST_ACTION);
    env.session.rpc.metadata.isProcessing = () => new Promise(() => {}); // never answers
    env.k.onEvent({ type: "user.message", data: { content: "hello" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(T0 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(268_000); // deadline fires; the snapshot waits for isProcessing
    assert.deepEqual(env.session.calls.enqueued, []);
    await env.clock.advance(6_000); // 5 s timeout: processing unknown, assistant.idle was seen -> acts as before
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
    assert.ok(env.logs.some((l) => l.startsWith("is-processing-timeout")));
    // the echo, a new request and the next deadline: the chain is not stuck behind the hung call
    env.k.onEvent({ type: "user.message", data: { content: "/save" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(env.clock.now() - 2_000 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(300_000);
    assert.deepEqual(env.session.calls.enqueued, ["/save", "/compact"]);
});

test("W2: tasks.list fails while a task runs -> no /save, no keep-alive, the unknown state is logged once", async () => {
    const env = realEnv({ fail: ["tasks.list"], tasks: [{ type: "agent", id: "w1", status: "running" }] }, FIRST_ACTION);
    env.k.onEvent({ type: "user.message", data: { content: "hello" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(T0 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(300_000);
    assert.deepEqual([env.session.calls.enqueued, env.session.calls.sends], [[], []]);
    assert.equal(env.logs.filter((l) => /^skip: task state unknown/.test(l)).length, 1);
    assert.ok(env.logs.some((l) => l.startsWith("tasks-list-error")));
});

test("W2: queue.pendingItems fails while a foreign message is queued -> no /save, no keep-alive", async () => {
    const env = realEnv({ fail: ["queue.pendingItems"], items: [{ id: "m1", kind: "message", displayText: "do this" }] }, FIRST_ACTION);
    env.k.onEvent({ type: "user.message", data: { content: "hello" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(T0 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(300_000);
    assert.deepEqual([env.session.calls.enqueued, env.session.calls.sends], [[], []]);
    assert.equal(env.logs.filter((l) => /^skip: queue state unknown/.test(l)).length, 1);
});

test("W2: own command ids are kept while the queue is unknown and unblocked once it is known again", async () => {
    const env = await stuckSave();
    const knownQueue = env.transport.pendingItems;
    env.transport.pendingItems = async () => null;
    await env.clock.advance(10_000); // re-check: queue unknown -> nothing happens, retry armed
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(env.clock.timerCount(), 1);
    env.transport.pendingItems = knownQueue;
    await env.clock.advance(10_000); // retry
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
});

test("W3: a failed keep-alive (sendPrompt false) arms the timer again, not more often than every few seconds", async () => {
    const env = setup();
    await userTurn(env);
    let attempts = 0;
    env.transport.sendPrompt = async () => { attempts++; return false; };
    await env.clock.advance(268_000); // deadline at start + 270 s
    assert.equal(attempts, 1);
    assert.equal(env.clock.timerCount(), 1);
    assert.equal(env.st().keepalives, 0); // the failed keep-alive did not use up a step
    await env.clock.advance(5_000);
    assert.equal(attempts, 1);
    await env.clock.advance(5_000);
    assert.equal(attempts, 2);
    assert.equal(env.clock.timerCount(), 1);
});

test("W3 / W5: a rejected /save (queued: false) is refunded, stays due and is retried", async () => {
    const env = setup(FIRST_ACTION);
    await userTurn(env);
    const enqueue = env.transport.enqueueCommand;
    env.transport.enqueueCommand = async () => ({ queued: false, queueId: null });
    await env.clock.advance(268_000);
    assert.equal(env.st().step, 1); // the save is the next step again
    assert.equal(env.st().nextLabel, "/save");
    assert.equal(env.clock.timerCount(), 1);
    env.transport.enqueueCommand = enqueue;
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]);
    assert.equal(env.k.stats.actions, 2);
});

test("W5: an enqueue RPC error is handled like a rejected command", async () => {
    const env = realEnv({ fail: ["commands.enqueue"] }, FIRST_ACTION);
    env.k.onEvent({ type: "user.message", data: { content: "hello" } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(T0 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(268_000);
    assert.ok(env.logs.some((l) => l.startsWith("enqueue-command-error")));
    assert.equal(env.clock.timerCount(), 1);
    env.session.fail.delete("commands.enqueue");
    await env.clock.advance(10_000);
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
});

test("W5: a rejected /compact does not count as done and is retried", async () => {
    const env = setup({ ladder: { keepalives: 1, actions: [COMPACT_ACTION] } });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    await env.clock.advance(300_000); // keep-alive
    await answerInjected(env, from);
    const enqueue = env.transport.enqueueCommand;
    env.transport.enqueueCommand = async () => ({ queued: false, queueId: null });
    await env.clock.advance(268_000);
    assert.equal(env.st().ladderDone, false);
    assert.equal(env.st().keepalives, 1);
    assert.equal(env.clock.timerCount(), 1);
    env.transport.enqueueCommand = enqueue;
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
});

test("S4: a fire that comes while the previous decision is still executing waits for it", async () => {
    const env = setup();
    await userTurn(env);
    let probes = 0, finishSend;
    const isProcessing = env.transport.isProcessing;
    env.transport.isProcessing = async () => { probes++; return isProcessing(); };
    env.transport.sendPrompt = (text) => new Promise((resolve) => { env.transport.calls.sends.push(text); finishSend = () => resolve(true); });
    await env.clock.advance(268_000); // first fire: keep-alive is in flight
    assert.equal(probes, 1);
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "view" } }); // re-arms the timer for one second from now
    await env.clock.advance(5_000); // the second fire is due while the send is still pending
    assert.equal(probes, 1);
    finishSend();
    await flush(); await flush();
    assert.equal(probes, 2);
});

// ---------- review 3: timed-out calls may still have taken effect ----------
async function realUserTurn(env, text = "hello") {
    env.k.onEvent({ type: "user.message", data: { content: text } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(env.clock.now() - 2_000 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
}
/** Make an rpc answer only `afterMs` later (fake clock) while it takes effect at once. */
const late = (env, afterMs, result) => new Promise((resolve) => { env.clock.setTimeout(() => resolve(result), afterMs); });

test("L (C-1): an enqueue whose reply comes late is adopted from the queue and unblocked; only one /save is queued", async () => {
    const env = realEnv({}, FIRST_ACTION);
    await realUserTurn(env);
    env.session.rpc.commands.enqueue = ({ command }) => { // queued at once, answered after 6 s (> the 5 s timeout)
        env.session.calls.enqueued.push(command);
        env.session.items.push({ id: "q1", kind: "command", displayText: command });
        return late(env, 6_000, { queued: true, queueId: "q1" });
    };
    await env.clock.advance(268_000); // deadline: /save is queued, the call hangs
    await env.clock.advance(6_000); // timeout at +5 s: the queue shows /save, it is adopted (not refunded, not queued again)
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
    assert.ok(env.logs.some((l) => l.startsWith("enqueue-command-timeout")));
    assert.ok(env.logs.some((l) => /^reconcile: adopted pending q1 as our \/save/.test(l)));
    assert.deepEqual(env.session.calls.removed, []);
    await env.clock.advance(10_000); // re-check: it is still held back -> unblocked
    assert.deepEqual(env.session.calls.removed, ["q1"]);
    assert.equal(env.session.calls.sends.length, 1);
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
});

test("L: an unanswered enqueue whose item does not show up yet gets one more look, then it is refunded and retried", async () => {
    const env = realEnv({}, FIRST_ACTION);
    await realUserTurn(env);
    env.session.rpc.commands.enqueue = () => new Promise(() => {}); // never queued, never answered
    await env.clock.advance(268_000);
    await env.clock.advance(6_000); // timeout: nothing in the queue yet -> look again
    assert.equal(env.clock.timerCount(), 1);
    const attempts = [];
    env.session.rpc.commands.enqueue = ({ command }) => { attempts.push(command); return Promise.resolve({ queued: true, queueId: "q2" }); };
    await env.clock.advance(5_000); // second look at +10 s: nothing -> refund, the normal deadline follows
    assert.deepEqual(attempts, []);
    await env.clock.advance(5_000);
    assert.deepEqual(attempts, ["/save"]); // the save is due again
});

test("L: while the queue is unknown an unconfirmed enqueue is not refunded and nothing else is done", async () => {
    const env = realEnv({}, FIRST_ACTION);
    await realUserTurn(env);
    env.session.rpc.commands.enqueue = ({ command }) => { env.session.calls.enqueued.push(command); env.session.items.push({ id: "q1", kind: "command", displayText: command }); return late(env, 6_000, { queued: true, queueId: "q1" }); };
    env.session.fail.add("queue.pendingItems");
    await env.clock.advance(274_000); // enqueue timed out, queue unknown
    assert.deepEqual(env.session.calls.sends, []);
    env.session.fail.delete("queue.pendingItems");
    await env.clock.advance(10_000); // queue known again: adopted
    assert.ok(env.logs.some((l) => /^reconcile: adopted pending q1/.test(l)));
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
});

test("a definite enqueue failure still refunds the save and retries it", async () => {
    const env = realEnv({ fail: ["commands.enqueue"] }, FIRST_ACTION);
    await realUserTurn(env);
    await env.clock.advance(268_000);
    assert.equal(env.clock.timerCount(), 1);
    assert.ok(!env.logs.some((l) => /^reconcile: adopted/.test(l)));
    env.session.fail.delete("commands.enqueue");
    await env.clock.advance(10_000);
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
});

test("R (W-1): a removal whose reply comes late but took effect refunds the save: it is due again", async () => {
    const env = realEnv({ stuckCommands: true }, FIRST_ACTION);
    await realUserTurn(env);
    await env.clock.advance(268_000); // /save queued as q1, held back
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
    env.session.rpc.queue.removeAt = ({ id }) => { // removed at once, answered after 6 s
        env.session.calls.removed.push(id);
        env.session.items = env.session.items.filter((i) => i.id !== id);
        return late(env, 6_000, { removed: true });
    };
    await env.clock.advance(10_000); // re-check at +10 s: unblock starts, removeAt hangs
    await env.clock.advance(6_000); // timeout: the queue no longer holds q1 -> withdrawn, keep-alive instead
    assert.deepEqual(env.session.calls.removed, ["q1"]);
    assert.equal(env.session.calls.sends.length, 1);
    assert.ok(!env.logs.some((l) => l.startsWith("unblock failed")));
    // the save is due again
    env.session.stuckCommands = false;
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } });
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(env.clock.now() - 2_000 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(300_000);
    assert.deepEqual(env.session.calls.enqueued, ["/save", "/save"]);
});

test("R: a failed removal that left the item in the queue keeps it tracked and is re-checked; an unknown queue is re-checked too", async () => {
    const env = realEnv({ stuckCommands: true }, FIRST_ACTION);
    await realUserTurn(env);
    await env.clock.advance(268_000);
    env.session.fail.add("queue.removeAt");
    await env.clock.advance(10_000);
    assert.equal(env.logs.filter((l) => /^unblock failed: could not remove q1/.test(l)).length, 1);
    assert.equal(env.session.calls.sends.length, 0);
    env.session.fail.delete("queue.removeAt");
    await env.clock.advance(10_000);
    assert.deepEqual(env.session.calls.removed, ["q1"]);
});

test("SP (C-1 / W-2): a keep-alive whose send times out is not resent and not refunded, but a re-decision is scheduled", async () => {
    const env = realEnv({});
    await realUserTurn(env);
    env.session.send = ({ prompt }) => { env.session.calls.sends.push(prompt); return new Promise(() => {}); }; // never answered
    await env.clock.advance(268_000); // keep-alive sent, the call hangs
    await env.clock.advance(8_000); // the 5 s timeout has passed
    assert.equal(env.session.calls.sends.length, 1); // not resent right away
    assert.equal(env.clock.timerCount(), 1); // ... but a re-decision is armed
    assert.ok(env.logs.some((l) => l.startsWith("send-prompt-timeout")));
    assert.ok(env.logs.some((l) => /send timed out; assuming it was delivered/.test(l)));
});

test("W-2: a prompt that never arrived: the re-decision sends one more keep-alive, bounded by the retry cutoff", async () => {
    const env = realEnv({});
    await realUserTurn(env);
    env.session.send = ({ prompt }) => { env.session.calls.sends.push(prompt); return new Promise(() => {}); };
    await env.clock.advance(268_000);
    await env.clock.advance(18_000); // timeout at +5 s, re-decision at +10 s: the policy says keep-alive again
    assert.equal(env.session.calls.sends.length, 2);
    await env.clock.advance(60_000); // the second timeout falls past the retry cutoff (expiry - marginSec / 3): nothing more
    assert.equal(env.session.calls.sends.length, 2);
    assert.equal(env.clock.timerCount(), 0);
});

test("W-2: a prompt that did arrive after the timeout: its turn re-arms the timer and supersedes the re-decision", async () => {
    const env = realEnv({});
    await realUserTurn(env);
    env.session.send = ({ prompt }) => { env.session.calls.sends.push(prompt); return new Promise(() => {}); };
    await env.clock.advance(268_000);
    await env.clock.advance(8_000); // timed out, re-decision armed
    env.k.onEvent({ type: "user.message", data: { content: env.cfg.keepaliveText } }); // ... the prompt arrives after all
    env.k.onEvent({ type: "assistant.turn_start", data: {} });
    await env.clock.advance(2_000);
    env.k.onEvent({ type: "assistant.usage", data: { interactionType: "conversation-agent", inputTokens: 200_000, cacheReadTokens: 199_000, cacheWriteTokens: 1_000, cacheExpiresAt: new Date(env.clock.now() - 2_000 + 300_000).toISOString() } });
    env.k.onEvent({ type: "assistant.idle", data: {} });
    await env.clock.advance(20_000);
    assert.equal(env.session.calls.sends.length, 1);
    assert.equal(env.clock.timerCount(), 1); // the normal deadline of the new expiry
});

test("SP: a definite send failure is still retried", async () => {
    const env = realEnv({ fail: ["send"] });
    await realUserTurn(env);
    await env.clock.advance(268_000);
    assert.equal(env.clock.timerCount(), 1);
    env.session.fail.delete("send");
    await env.clock.advance(10_000);
    assert.equal(env.session.calls.sends.length, 1);
});

// ---------- final review fixes (T2-fix1) ----------
test("W1 (a): a held own command is unblocked even after the cache expired; the re-check never gives up", async () => {
    const env = await stuckSave(); // /save queued at +270 s and held back
    const knownQueue = env.transport.pendingItems;
    env.transport.pendingItems = async () => null; // the queue cannot be read for a while
    await env.clock.advance(60_000); // far past the expiry at +300 s
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(env.clock.timerCount(), 1); // still being re-checked, not abandoned
    env.transport.pendingItems = knownQueue;
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]); // unblocked although the cache is gone
    assert.equal(env.transport.calls.sends.length, 1); // the keep-alive re-warms it
});

test("W1 (b): model busy during a held own command: no timer is dropped, the command is unblocked once the model is not busy", async () => {
    const env = await stuckSave();
    env.transport.processing = true;
    await env.clock.advance(10_000); // re-check: busy-model
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(env.clock.timerCount(), 1);
    await env.clock.advance(40_000);
    assert.equal(env.clock.timerCount(), 1); // keeps checking
    env.transport.processing = false;
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
});

test("W-2: a removal that keeps failing is never given up: after 5 failures the re-check backs off to every 60 s, until it succeeds", async () => {
    const env = await stuckSave(); // /save held back as q1 at +270 s
    const removeQueued = env.transport.removeQueued;
    env.transport.removeQueued = async () => false;
    await env.clock.advance(50_000); // re-checks at +280 ... +320 s: 5 failures, 10 s apart
    assert.equal(logged(env, /^unblock failed: could not remove q1/).length, 5);
    assert.equal(logged(env, /backing off/).length, 1); // the fifth failure announces it
    assert.equal(env.clock.timerCount(), 1); // still held, still armed
    await env.clock.advance(55_000); // +375 s: the next attempt is only at +380 s
    assert.equal(logged(env, /^unblock failed/).length, 5);
    await env.clock.advance(10_000); // +385 s: one attempt per minute, one log line per attempt
    assert.equal(logged(env, /^unblock failed/).length, 6);
    assert.equal(logged(env, /gave up/).length, 0);
    env.transport.removeQueued = removeQueued; // removal works again
    await env.clock.advance(60_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]); // eventually removed
    assert.equal(env.transport.calls.sends.length, 1); // and the keep-alive follows
});

test("W-1: a held item that is not ours gets one keep-alive and is not tracked further (no pile-up while nothing answers)", async () => {
    const env = await stuckSave();
    env.transport.items = [{ id: "q1", kind: "command", displayText: "/other" }]; // q1 is not our command (any more)
    await env.clock.advance(600_000); // ten minutes without a single turn
    assert.equal(env.transport.calls.sends.length, 1);
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(logged(env, /^unblock skipped=q1 then=keepalive$/).length, 1);
    assert.equal(env.clock.timerCount(), 0);
});

test("E3: a root tool that finishes after the cache expired does not drop the watch on a held own command", async () => {
    const env = await stuckSave(); // /save held back as q1 at +270 s, cache expires at +300 s
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } }); // +271 s deadline: RESCUE, no held re-check
    await env.clock.advance(300_000); // the tool runs on, far past the expiry
    assert.deepEqual(env.transport.calls.removed, []);
    assert.equal(env.clock.timerCount(), 0); // (W-3: no re-check while the tool runs)
    env.k.onEvent({ type: "tool.execution_complete", data: { toolCallId: "tc1" } }); // finished, and no request follows (abort path)
    assert.equal(env.clock.timerCount(), 1); // the held command is watched again
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, ["q1"]);
    assert.equal(env.transport.calls.sends.length, 1); // keep-alive after the unblock
});

test("U: an unconfirmed enqueue is watched after the expiry too: adopted and removed once the queue is readable again", async () => {
    const env = realEnv({}, FIRST_ACTION);
    await realUserTurn(env);
    env.session.rpc.commands.enqueue = ({ command }) => { // queued at once as q1, answered after 6 s (> the 5 s timeout)
        env.session.calls.enqueued.push(command);
        env.session.items.push({ id: "q1", kind: "command", displayText: command });
        env.session.fail.add("queue.pendingItems"); // from now on the queue cannot be read ...
        return late(env, 6_000, { queued: true, queueId: "q1" });
    };
    await env.clock.advance(306_000); // ... until after the cache expired at +300 s (the fire was at +270 s)
    assert.deepEqual(env.session.calls.removed, []);
    assert.equal(env.clock.timerCount(), 1); // still being watched
    env.session.fail.delete("queue.pendingItems");
    await env.clock.advance(10_000); // one re-check: adopted, then unblocked
    assert.ok(env.logs.some((l) => /^reconcile: adopted pending q1 as our \/save/.test(l)));
    assert.deepEqual(env.session.calls.removed, ["q1"]);
    assert.equal(env.session.calls.sends.length, 1); // keep-alive after the unblock
    assert.deepEqual(env.session.calls.enqueued, ["/save"]);
});

test("R: an unconfirmed enqueue on an unreadable queue does not block the rescue: one attempt at the rescue deadline, not one per re-check", async () => {
    const env = realEnv({}, FIRST_ACTION);
    await realUserTurn(env);
    env.session.rpc.commands.enqueue = ({ command }) => { // queued at once, answered after 6 s (> the 5 s timeout)
        env.session.calls.enqueued.push(command);
        env.session.items.push({ id: "q1", kind: "command", displayText: command });
        env.session.fail.add("queue.pendingItems"); // the queue cannot be read from now on
        return late(env, 6_000, { queued: true, queueId: "q1" });
    };
    await env.clock.advance(268_000); // +270 s: /save queued
    await env.clock.advance(6_000); // +276 s: the enqueue timed out, its fate is unknown
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } }); // the root blocks in a tool
    await env.clock.advance(600_000);
    assert.equal(env.logs.filter((l) => /^rescue impossible/.test(l)).length, 1); // same as without the unconfirmed command
    assert.equal(env.k.stats.unrescued, 1);
    assert.equal(env.clock.timerCount(), 1); // the unconfirmed command is still being watched
    assert.deepEqual(env.session.calls.removed, []);
});

test("E3: while a root tool runs after the expiry nothing is armed; a tool event with no held command arms nothing either", async () => {
    const env = setup();
    await userTurn(env);
    await env.clock.advance(400_000); // expired, nothing held
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "view" } });
    env.k.onEvent({ type: "tool.execution_complete", data: { toolCallId: "tc1" } });
    assert.equal(env.clock.timerCount(), 0);
});

test("W-3: a held own command and a running root tool: rescue is attempted once per deadline, not every 10 s", async () => {
    const env = await stuckSave(); // /save held back as q1 at +270 s
    env.k.onEvent({ type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "powershell" } }); // re-arms the deadline: RESCUE
    await env.clock.advance(600_000);
    assert.equal(logged(env, /^rescue impossible/).length, 1);
    assert.equal(env.k.stats.unrescued, 1);
    assert.deepEqual(env.transport.calls.removed, []); // the turn is in a tool, not stuck behind the command
});

test("W2: a definite enqueue rejection never adopts a queue item: the user's /save is not removed, the save is refunded and retried", async () => {
    const env = setup(FIRST_ACTION);
    await userTurn(env);
    const enqueue = env.transport.enqueueCommand;
    let calls = 0;
    env.transport.enqueueCommand = async (command) => {
        if (calls++ > 0) return enqueue(command);
        env.transport.items.push({ id: "u1", kind: "command", displayText: "/save" }); // the user typed /save meanwhile
        return { queued: false, queueId: null }; // ... and ours was rejected
    };
    await env.clock.advance(268_000);
    assert.equal(env.st().nextLabel, "/save"); // refunded at once: the save is the next step again
    assert.equal(env.clock.timerCount(), 1); // retry armed
    assert.ok(!env.logs.some((l) => l.startsWith("reconcile: adopted")));
    env.transport.items = []; // the user's /save has run
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.enqueued, ["/save"]); // retried (the first attempt was rejected before recording)
    assert.deepEqual(env.transport.calls.removed, []);
});

test("S2: a skill.invoked that the tracker ignores still ends the wait of the matching own command", async () => {
    const env = setup({ ladder: { keepalives: 1, actions: [COMPACT_ACTION] } }, { stuckCommands: true });
    await userTurn(env);
    const from = { s: 0, c: 0 };
    await env.clock.advance(300_000); // keep-alive (the only keep-alive of the ladder)
    await answerInjected(env, from);
    await env.clock.advance(268_000); // keep-alives done: /compact queued and held back
    assert.deepEqual(env.transport.calls.enqueued, ["/compact"]);
    env.k.onEvent({ type: "skill.invoked", data: { name: "compact" } }); // it runs after all
    await env.clock.advance(10_000);
    assert.deepEqual(env.transport.calls.removed, []);
});

test("S3: an unexpected error in a fire is logged and a fallback retry is armed", async () => {
    const env = setup();
    await userTurn(env);
    const isProcessing = env.transport.isProcessing;
    env.transport.isProcessing = async () => { throw new Error("boom"); };
    await env.clock.advance(268_000);
    assert.equal(logged(env, /^fire-error .*boom/).length, 1);
    assert.equal(env.clock.timerCount(), 1);
    env.transport.isProcessing = isProcessing;
    await env.clock.advance(10_000);
    assert.equal(env.transport.calls.sends.length, 1);
});

test("B1 AC-15: at ladder-done each skip reason is logged once", async () => {
    const env = setup({ ladder: { keepalives: 0, actions: [SAVE_ACTION] } });
    await userTurn(env, "/save");
    await env.clock.advance(268_000); // deadline at start + 270 s: /save is unchanged, nothing else is left
    assert.equal(logged(env, /^action save skipped: unchanged since last run$/).length, 1);
    assert.equal(logged(env, /^ladder done$/).length, 1);
});

test("B1 AC-15: a text action whose send times out is logged with its id", async () => {
    const env = setup({ ladder: { keepalives: 0, actions: [{ id: "note", text: "Summarise open work in one line." }] } });
    env.transport.sendPrompt = async (text) => { env.transport.calls.sends.push(text); return TRANSPORT_TIMEOUT; };
    await userTurn(env);
    await env.clock.advance(268_000); // deadline at start + 270 s: the text is sent and no answer comes
    assert.equal(env.transport.calls.sends.length, 1);
    assert.equal(logged(env, /^note send timed out; assuming it was delivered/).length, 1);
});

test("B1 AC-15: a failed text-action send is given back and retried at the next deadline", async () => {
    const text = "Summarise open work in one line.";
    const env = setup({ ladder: { keepalives: 0, actions: [{ id: "note", text }] } });
    let attempts = 0;
    env.transport.sendPrompt = async (sent) => {
        attempts++;
        if (attempts === 1) return false;
        env.transport.calls.sends.push(sent);
        return true;
    };
    await userTurn(env);
    await env.clock.advance(268_000); // deadline at start + 270 s: the first send fails
    assert.equal(env.st().nextLabel, "note");
    assert.equal(env.st().step, 1);
    assert.ok(env.clock.timerCount() > 0);
    await env.clock.advance(10_000); // the retry fires at start + 280 s
    assert.deepEqual(env.transport.calls.sends, [text]);
});
