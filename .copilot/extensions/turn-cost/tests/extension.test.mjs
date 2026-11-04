// Behaviour of the turn-cost start logic (wiring.mjs) with fakes: the kill switch joins the session but subscribes to nothing and never calls session.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../wiring.mjs";
import { DEFAULT_METRICS } from "../lib/contracts.mjs";
import { fakeLogSession } from "./helpers/fakes.mjs";

const SESSION_ID = "turn-cost-test-session";
const READ_METRICS = () => ({ metrics: DEFAULT_METRICS, problems: [] });

/** Runs start() with a fake join that counts its calls and returns the given session; `log` lines are collected. */
async function runStart(env, session = fakeLogSession({ sessionId: SESSION_ID })) {
    const joins = [];
    const joinSession = async (options) => {
        joins.push(options);
        return session;
    };
    const logLines = [];
    const ids = [];
    await start({ env, joinSession, log: (msg) => logLines.push(msg), setSessionId: (id) => ids.push(id), readMetrics: READ_METRICS });
    return { session, joins, logLines, ids };
}

test("AC-12 switch on: joins the session once, subscribes to nothing, never calls session.log", async () => {
    const { session, joins, logLines } = await runStart({ COPILOT_TURN_COST: "off" });
    assert.equal(joins.length, 1);
    assert.deepEqual(session.handlers, []);
    assert.deepEqual(session.calls, []);
    assert.deepEqual(logLines, ["disabled by COPILOT_TURN_COST=off"]);
});

test("AC-12 switch on with a padded, upper-case value: the same off behaviour", async () => {
    const { session, joins, logLines } = await runStart({ COPILOT_TURN_COST: " OFF " });
    assert.equal(joins.length, 1);
    assert.deepEqual(session.handlers, []);
    assert.deepEqual(session.calls, []);
    assert.equal(logLines.length, 1);
});

test("AC-12 switch unset: joins the session once and subscribes one event handler", async () => {
    const { session, joins, logLines } = await runStart({});
    assert.equal(joins.length, 1);
    assert.equal(session.handlers.length, 1);
    assert.deepEqual(session.calls, []);
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /^start pid=\d+$/);
});

test("the log prefix id is set from the joined session in both modes", async () => {
    const on = await runStart({ COPILOT_TURN_COST: "off" });
    const unset = await runStart({});
    assert.deepEqual(on.ids, [SESSION_ID]);
    assert.deepEqual(unset.ids, [SESSION_ID]);
});

test("a session without an id is logged as unknown", async () => {
    const { ids } = await runStart({ COPILOT_TURN_COST: "off" }, { ...fakeLogSession(), sessionId: undefined });
    assert.deepEqual(ids, ["unknown"]);
});
