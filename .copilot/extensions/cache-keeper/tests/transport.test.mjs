import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../lib/transport.mjs";
import { fakeClock, fakeSession } from "./helpers/fakes.mjs";

function setup(o) {
    const session = fakeSession(o), logs = [];
    return { session, logs, transport: createTransport(session, (m) => logs.push(m)) };
}

const running = (id, extra = {}) => ({ type: "agent", id, status: "running", ...extra });

test("sendPrompt sends the prompt through session.send", async () => {
    const { session, transport } = setup();
    assert.equal(await transport.sendPrompt("ping"), true);
    assert.deepEqual(session.calls.sends, ["ping"]);
});

test("enqueueCommand maps to commands.enqueue and returns queued + queueId", async () => {
    const { session, transport } = setup();
    assert.deepEqual(await transport.enqueueCommand("/save"), { queued: true, queueId: "q1" });
    assert.deepEqual(session.calls.enqueued, ["/save"]);
});

test("pendingItems maps to queue.pendingItems and counts steering messages", async () => {
    const { session, transport } = setup({ pending: true });
    session.rpc.queue.pendingItems = async () => ({ items: [{ id: "a" }], steeringMessages: ["x", "y"] });
    assert.deepEqual(await transport.pendingItems(), { items: [{ id: "a" }], steeringCount: 2 });
});

test("pendingItems and enqueueCommand expose the ids needed to tell own items from foreign ones", async () => {
    const { transport } = setup({ stuckCommands: true, items: [{ id: "m1", kind: "message", displayText: "hi" }] });
    const { queueId } = await transport.enqueueCommand("/save");
    const { items } = await transport.pendingItems();
    assert.deepEqual(items.map((i) => [i.id, i.kind]), [["m1", "message"], [queueId, "command"]]);
});

test("removeQueued maps to queue.removeAt", async () => {
    const { session, transport } = setup();
    assert.equal(await transport.removeQueued("q7"), true);
    assert.deepEqual(session.calls.removed, ["q7"]);
});

test("sendNow maps to queue.sendNow", async () => {
    const { session, transport } = setup();
    assert.equal(await transport.sendNow("q7"), true);
    assert.deepEqual(session.calls.sentNow, ["q7"]);
});

test("listTasks returns only running tasks", async () => {
    const { transport } = setup({ tasks: [running("a"), { type: "shell", id: "b", status: "completed" }] });
    assert.deepEqual((await transport.listTasks()).map((t) => t.id), ["a"]);
});

test("promotableCandidates returns running sync tasks that can be promoted", async () => {
    const { transport } = setup({ tasks: [
        running("a", { executionMode: "sync" }), running("b", { executionMode: "background" }),
        running("c", { executionMode: "sync", canPromoteToBackground: false }), { type: "shell", id: "d", status: "completed", executionMode: "sync" },
    ] });
    assert.deepEqual((await transport.promotableCandidates()).map((t) => t.id), ["a"]);
});

test("promotableCandidates falls back to the current promotable task", async () => {
    const { transport } = setup({ promotable: { type: "shell", id: "12" } });
    assert.deepEqual((await transport.promotableCandidates()).map((t) => t.id), ["12"]);
});

test("promotableCandidates is empty when nothing is promotable", async () => {
    const { transport } = setup();
    assert.deepEqual(await transport.promotableCandidates(), []);
});

test("promote maps to tasks.promoteToBackground", async () => {
    const { session, transport } = setup();
    assert.equal(await transport.promote("12"), true);
    assert.deepEqual(session.calls.promoted, ["12"]);
});

test("isProcessing maps to metadata.isProcessing", async () => {
    assert.equal(await setup({ processing: true }).transport.isProcessing(), true);
    assert.equal(await setup({ processing: false }).transport.isProcessing(), false);
});

test("currentAgentName maps to agent.getCurrent", async () => {
    assert.equal(await setup({ agent: "util-x" }).transport.currentAgentName(), "util-x");
});

const SAFE_DEFAULTS = [
    { method: "sendPrompt", args: ["ping"], fail: "send", expect: false, log: "send-prompt-error" },
    { method: "enqueueCommand", args: ["/save"], fail: "commands.enqueue", expect: { queued: false, queueId: null }, log: "enqueue-command-error" },
    { method: "pendingItems", args: [], fail: "queue.pendingItems", expect: null, log: "pending-items-error" },
    { method: "removeQueued", args: ["q1"], fail: "queue.removeAt", expect: false, log: "remove-queued-error" },
    { method: "sendNow", args: ["q1"], fail: "queue.sendNow", expect: false, log: "send-now-error" },
    { method: "listTasks", args: [], fail: "tasks.list", expect: null, log: "tasks-list-error" },
    { method: "promotableCandidates", args: [], fail: "tasks.list", expect: [], log: "tasks-list-error" },
    { method: "promotableCandidates", args: [], fail: "tasks.getCurrentPromotable", expect: [], log: "promotable-error" },
    { method: "promote", args: ["12"], fail: "tasks.promoteToBackground", expect: false, log: "promote-error" },
    { method: "isProcessing", args: [], fail: "metadata.isProcessing", expect: null, log: "is-processing-error" },
    { method: "currentAgentName", args: [], fail: "agent.getCurrent", expect: null, log: "current-agent-error" },
];

for (const c of SAFE_DEFAULTS) {
    test(`${c.method} returns its safe default and logs ${c.log} when ${c.fail} fails`, async () => {
        const { logs, transport } = setup({ fail: [c.fail] });
        assert.deepEqual(await transport[c.method](...c.args), c.expect);
        assert.equal(logs.length, 1);
        assert.ok(logs[0].startsWith(c.log), logs[0]);
    });
}

// ---------- malformed replies are unknown, not empty ----------
test("malformed pendingItems / tasks.list replies are unknown (null), not empty", async () => {
    for (const reply of [{}, { items: "x" }, null]) {
        const { session, logs, transport } = timedSetup({});
        session.rpc.queue.pendingItems = async () => reply;
        assert.equal(await transport.pendingItems(), null, JSON.stringify(reply));
        assert.ok(logs[0].startsWith("pending-items-error malformed"), logs[0]);
    }
    for (const reply of [{}, { tasks: {} }, null]) {
        const { session, logs, transport } = timedSetup({});
        session.rpc.tasks.list = async () => reply;
        assert.equal(await transport.listTasks(), null, JSON.stringify(reply));
        assert.ok(logs[0].startsWith("tasks-list-error malformed"), logs[0]);
    }
});

test("well-formed empty replies are still empty", async () => {
    const { session, transport } = timedSetup({});
    session.rpc.queue.pendingItems = async () => ({ items: [], steeringMessages: [] });
    session.rpc.tasks.list = async () => ({ tasks: [] });
    assert.deepEqual(await transport.pendingItems(), { items: [], steeringCount: 0 });
    assert.deepEqual(await transport.listTasks(), []);
});

// ---------- timeouts and log throttling (fake clock) ----------
function timedSetup(o, options = {}) {
    const clock = fakeClock(), session = fakeSession(o), logs = [];
    const transport = createTransport(session, (m) => logs.push(m), { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, ...options });
    return { clock, session, logs, transport };
}

test("a hung RPC returns the safe default after the timeout and logs <tag>-timeout", async () => {
    const { clock, session, logs, transport } = timedSetup({}, { timeoutMs: 5000 });
    session.rpc.metadata.isProcessing = () => new Promise(() => {});
    let result = "pending";
    transport.isProcessing().then((r) => { result = r; });
    await clock.advance(4_999);
    assert.equal(result, "pending");
    await clock.advance(2);
    assert.equal(result, null);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].startsWith("is-processing-timeout"), logs[0]);
});

test("a hung sendPrompt resolves to \"timeout\" (it may still arrive); the default timeout is 5 s", async () => {
    const { clock, session, transport } = timedSetup({});
    session.send = () => new Promise(() => {});
    let result = "pending";
    transport.sendPrompt("ping").then((r) => { result = r; });
    await clock.advance(4_999);
    assert.equal(result, "pending");
    await clock.advance(2);
    assert.equal(result, "timeout");
});

test("a failing sendPrompt is a definite failure (false), not a timeout", async () => {
    const { transport } = timedSetup({ fail: ["send"] });
    assert.equal(await transport.sendPrompt("ping"), false);
});

test("a hung enqueueCommand reports timedOut so the caller can reconcile; a failing one does not", async () => {
    const { clock, session, transport } = timedSetup({});
    session.rpc.commands.enqueue = () => new Promise(() => {});
    let result = "pending";
    transport.enqueueCommand("/save").then((r) => { result = r; });
    await clock.advance(5_001);
    assert.deepEqual(result, { queued: false, queueId: null, timedOut: true });
    assert.deepEqual(await timedSetup({ fail: ["commands.enqueue"] }).transport.enqueueCommand("/save"), { queued: false, queueId: null });
});

test("the timeout timer is cleared when the call settles", async () => {
    const { clock, transport } = timedSetup({});
    assert.equal(await transport.isProcessing(), false);
    assert.equal(clock.timerCount(), 0);
});

test("the same error is logged at most once per minute, with a count of what was held back", async () => {
    const { clock, logs, transport } = timedSetup({ fail: ["send"] });
    for (let i = 0; i < 3; i++) await transport.sendPrompt("ping");
    assert.equal(logs.length, 1);
    await clock.advance(61_000);
    await transport.sendPrompt("ping");
    assert.equal(logs.length, 2);
    assert.match(logs[1], /^send-prompt-error .*\(\+2 suppressed\)$/);
});

test("different tags are throttled independently", async () => {
    const { logs, transport } = timedSetup({ fail: ["send", "queue.sendNow"] });
    await transport.sendPrompt("ping");
    await transport.sendNow("q1");
    assert.equal(logs.length, 2);
});
