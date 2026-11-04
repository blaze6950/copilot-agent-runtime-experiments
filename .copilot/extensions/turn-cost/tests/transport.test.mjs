// Tests of the turn-cost log transport (AC-8): the only module that calls session.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogTransport } from "../lib/transport.mjs";
import { fakeLogSession, fakeTimers } from "./helpers/fakes.mjs";

const LINE = "turn 1 · 4s · $0.01";
const TIMEOUT_MS = 5000;

test("logInfo calls session.log with {level:\"info\"} and never ephemeral", async () => {
    const session = fakeLogSession();
    const transport = createLogTransport(session);
    assert.equal(await transport.logInfo(LINE), true);
    assert.deepEqual(session.calls, [{ message: LINE, options: { level: "info" } }]);
    assert.equal(Object.hasOwn(session.calls[0].options, "ephemeral"), false);
});

test("logWarning uses {level:\"warning\"}", async () => {
    const session = fakeLogSession();
    const transport = createLogTransport(session);
    assert.equal(await transport.logWarning("turn-cost config: x"), true);
    assert.deepEqual(session.calls, [{ message: "turn-cost config: x", options: { level: "warning" } }]);
});

test("a throwing session.log returns false and logs log-error", async () => {
    const logs = [];
    const transport = createLogTransport(fakeLogSession({ fail: "boom" }), (msg) => logs.push(msg));
    assert.equal(await transport.logInfo(LINE), false);
    assert.deepEqual(logs, ["log-error boom"]);
});

test("a hanging session.log returns false after the timeout and logs log-timeout", async () => {
    const timers = fakeTimers();
    const logs = [];
    const transport = createLogTransport(fakeLogSession({ hang: true }), (msg) => logs.push(msg), {
        timeoutMs: TIMEOUT_MS, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    const answer = transport.logInfo(LINE);
    assert.deepEqual(timers.delays(), [TIMEOUT_MS]);
    timers.fire();
    assert.equal(await answer, false);
    assert.deepEqual(logs, [`log-timeout no answer after ${TIMEOUT_MS}ms`]);
});

test("the timer is cleared once session.log answers", async () => {
    const timers = fakeTimers();
    const transport = createLogTransport(fakeLogSession(), () => {}, {
        timeoutMs: TIMEOUT_MS, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.equal(await transport.logInfo(LINE), true);
    assert.equal(timers.pendingCount(), 0);
});
