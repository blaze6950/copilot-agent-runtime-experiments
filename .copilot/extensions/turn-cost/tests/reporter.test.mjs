// Tests of the turn-cost reporter: real accounting, rendering and metric config; the transport and the config file read are fakes (I/O only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccounting } from "../lib/accounting.mjs";
import { createReporter } from "../lib/reporter.mjs";
import { renderAgent, renderTurn } from "../lib/render.mjs";
import { CONFIG_WARNING_PREFIX, metricConfigFrom } from "../lib/config.mjs";
import { DEFAULT_METRICS, NANO_AIU_PER_USD } from "../lib/contracts.mjs";
import { readFixture, replay } from "./helpers/replay.mjs";
import { fakeLogTransport } from "./helpers/fakes.mjs";

const FIXTURE_A = "dispatch-turns";
const CONFIG_PATH = "C:/cfg/turn-cost/config.json";
const BASE_MS = Date.parse("2026-10-23T12:00:00.000Z");
const WRITE_EVENT_TYPES = ["session.idle", "subagent.completed", "subagent.failed"];
const CYAN_OPEN = "\x1b[36m";
const TURN_REQ_TOKEN = /\d+ req\b/;
const BROKEN_COST = '{"metrics":{"cost":"no"}}';
const BROKEN_COST_AND_TTFT = '{"metrics":{"cost":"no","ttft":1}}';

/** Event at `seconds` after the base time. */
function ev(type, seconds, data = {}, agentId = undefined) {
    const event = { type, timestamp: new Date(BASE_MS + seconds * 1000).toISOString(), data };
    if (agentId !== undefined) event.agentId = agentId;
    return event;
}

/** One real root turn of one request: user prompt, usage, session.idle. Starts `offset` seconds after the base time. */
function turnEvents(offset) {
    return [
        ev("user.message", offset, { content: "user prompt" }),
        ev("assistant.usage", offset + 1, { model: "m1", inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, duration: 500, copilotUsage: { totalNanoAiu: 0.01 * NANO_AIU_PER_USD } }),
        ev("session.idle", offset + 2),
    ];
}

/** Metric config as a file: `state.text` is what the file holds at the time of the read. The real metricConfigFrom runs on it. */
function configFile(initialText) {
    const state = { text: initialText };
    const readMetrics = () => metricConfigFrom(() => state.text, CONFIG_PATH);
    return { state, readMetrics };
}

/** Same rendering as the reporter, for the expected text. */
function renderBlock(block, options) {
    return block.kind === "turn" ? renderTurn(block, options) : renderAgent(block, options);
}

/**
 * Feeds the events one by one, waits for the writes of each, and returns what was written with the index of the event that caused it.
 * `beforeEvent(index, configState)` may change the config file before an event. `outcome(level, text)` is the transport answer.
 * `accounting` replaces the real accounting (only the formatting-failure test uses it). `trace` holds the log lines and the transport
 * calls in the order they happened.
 */
async function feed(events, { configText = "{}", env = {}, beforeEvent = () => {}, outcome = () => true, accounting } = {}) {
    const logs = [];
    const trace = [];
    let current = -1;
    const transport = fakeLogTransport({
        marker: () => current,
        outcome: (level, text) => {
            trace.push(`transport ${level}`);
            return outcome(level, text);
        },
    });
    const config = configFile(configText);
    const reporter = createReporter({
        transport,
        readMetrics: config.readMetrics,
        env,
        log: (msg) => {
            logs.push(msg);
            trace.push(msg);
        },
        now: () => BASE_MS,
        accounting,
    });
    for (const [index, event] of events.entries()) {
        current = index;
        beforeEvent(index, config.state);
        reporter.onEvent(event);
        await reporter.flushed();
    }
    return { lines: transport.lines, logs, trace, events };
}

test("fixture A: ten info writes in block order, none for the keep-alive idle", async () => {
    const { lines, events } = await feed(readFixture(FIXTURE_A));
    const blocks = replay(createAccounting(), readFixture(FIXTURE_A));
    const expected = blocks.map((block) => renderBlock(block, { metrics: DEFAULT_METRICS, color: true }));
    const rootIdles = events.filter((event) => event.type === "session.idle" && event.agentId === undefined).length;
    const turnBlocks = blocks.filter((block) => block.kind === "turn").length;

    assert.equal(blocks.length, 10);
    assert.ok(rootIdles > turnBlocks, "the fixture has a keep-alive idle that writes nothing");
    assert.deepEqual(lines.map((line) => line.level), Array(10).fill("info"));
    assert.deepEqual(lines.map((line) => line.text), expected);
});

test("writes happen only on session.idle or subagent.completed/failed events", async () => {
    const { lines, events } = await feed(readFixture(FIXTURE_A));
    assert.ok(lines.length > 0);
    for (const line of lines) {
        assert.ok(WRITE_EVENT_TYPES.includes(events[line.marker].type), `write caused by ${events[line.marker].type}`);
    }
});

test("first write is cyan without NO_COLOR and has no escape code with NO_COLOR=1", async () => {
    const coloured = await feed(turnEvents(0));
    assert.equal(coloured.lines.length, 1);
    assert.ok(coloured.lines[0].text.startsWith(CYAN_OPEN), coloured.lines[0].text);

    const plain = await feed(turnEvents(0), { env: { NO_COLOR: "1" } });
    assert.equal(plain.lines.length, 1);
    assert.equal(plain.lines[0].text.includes("\x1b"), false);
});

test("config is read per block: switching req off between blocks removes it from the next block", async () => {
    const events = [...turnEvents(0), ...turnEvents(10)];
    const { lines } = await feed(events, {
        beforeEvent: (index, config) => {
            if (index === 3) config.text = '{"metrics":{"req":false}}';
        },
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0].text, TURN_REQ_TOKEN);
    assert.doesNotMatch(lines[1].text, TURN_REQ_TOKEN);
});

test("the same config problems give one warning per distinct problem text", async () => {
    const events = [...turnEvents(0), ...turnEvents(10), ...turnEvents(20)];
    const { lines } = await feed(events, {
        configText: BROKEN_COST,
        beforeEvent: (index, config) => {
            if (index === 3) config.text = BROKEN_COST_AND_TTFT;
            if (index === 6) config.text = BROKEN_COST;
        },
    });
    const warnings = lines.filter((line) => line.level === "warning");
    assert.equal(lines.filter((line) => line.level === "info").length, 3);
    assert.equal(warnings.length, 2, JSON.stringify(warnings));
    assert.ok(warnings[0].text.startsWith(CONFIG_WARNING_PREFIX), warnings[0].text);
    assert.match(warnings[0].text, /metrics\.cost must be true or false; using true/);
    assert.match(warnings[1].text, /metrics\.ttft must be true or false; using false/);
});

test("an event that throws inside accounting is logged as event-error and does not throw", async () => {
    const throwing = new Proxy({ type: "user.message", data: { content: "hi" } }, {
        get(target, key) {
            if (key === "timestamp") throw new Error("boom");
            return target[key];
        },
    });
    const { lines, logs } = await feed([throwing, ...turnEvents(0)]);
    assert.equal(logs.filter((msg) => /^event-error user\.message: Error: boom/.test(msg)).length, 1, JSON.stringify(logs));
    assert.equal(lines.length, 1, "the next turn is still written");
});

test("each block is logged as writing before the transport call and as written after it", async () => {
    const { lines, trace } = await feed(turnEvents(0));
    assert.equal(lines.length, 1);
    assert.deepEqual(trace, ["block turn 1 writing", "transport info", "block turn 1 $0.01000 written"]);
});

test("a transport that returns false logs not-written, and the next block is still written", async () => {
    const answers = [false, true];
    const { lines, trace } = await feed([...turnEvents(0), ...turnEvents(10)], { outcome: () => answers.shift() });
    assert.equal(lines.length, 2);
    assert.deepEqual(trace, [
        "block turn 1 writing", "transport info", "block turn 1 $0.01000 not-written",
        "block turn 2 writing", "transport info", "block turn 2 $0.01000 written",
    ]);
});

test("a transport that throws logs write-error, and the next block is still written", async () => {
    const answers = [() => { throw new Error("write failed"); }, () => true];
    const { lines, trace } = await feed([...turnEvents(0), ...turnEvents(10)], { outcome: () => answers.shift()() });
    assert.equal(lines.length, 2);
    assert.deepEqual(trace.slice(0, 2), ["block turn 1 writing", "transport info"]);
    assert.match(trace[2], /^write-error Error: write failed/);
    assert.deepEqual(trace.slice(3), ["block turn 2 writing", "transport info", "block turn 2 $0.01000 written"]);
});

test("a formatting failure is logged before the write, so no write-error follows a written line", async () => {
    const [turnBlock] = replay(createAccounting(), turnEvents(0)).filter((block) => block.kind === "turn");
    turnBlock.costUsd = Object.assign(new Number(0.01), { toFixed() { throw new Error("toFixed failed"); } });
    const accounting = { apply: (event) => (event.type === "session.idle" ? [turnBlock] : []), sessionUsd: () => 0 };
    const { lines, trace } = await feed(turnEvents(0), { accounting });
    assert.equal(lines.length, 0, "nothing was written");
    assert.equal(trace.length, 1, JSON.stringify(trace));
    assert.match(trace[0], /^write-error Error: toFixed failed/);
});

test("a config warning that the transport does not send is retried at the next block", async () => {
    const warningAnswers = [false, true];
    const { lines } = await feed([...turnEvents(0), ...turnEvents(10), ...turnEvents(20)], {
        configText: BROKEN_COST,
        outcome: (level) => (level === "warning" ? warningAnswers.shift() : true),
    });
    assert.deepEqual(lines.map((line) => line.level), ["warning", "info", "warning", "info", "info"]);
    assert.ok(lines[2].text.startsWith(CONFIG_WARNING_PREFIX), lines[2].text);
});

test("a config warning whose send throws is logged, the block is still written, and the warning is retried", async () => {
    const warningAnswers = [() => { throw new Error("warning failed"); }, () => true];
    const { lines, logs } = await feed([...turnEvents(0), ...turnEvents(10)], {
        configText: BROKEN_COST,
        outcome: (level) => (level === "warning" ? warningAnswers.shift()() : true),
    });
    assert.deepEqual(lines.map((line) => line.level), ["warning", "info", "warning", "info"]);
    assert.ok(logs.some((msg) => /^warning-error Error: warning failed/.test(msg)), JSON.stringify(logs));
});

