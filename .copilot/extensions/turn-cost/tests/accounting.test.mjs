// Tests for the turn-cost accounting (AC-1..AC-4): which blocks become ready when, with which figures.
// Real event sequences come from tests/fixtures; short inline sequences cover the edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccounting } from "../lib/accounting.mjs";
import { NANO_AIU_PER_USD, ROOT_AGENT, STATUS, TURN_TRIGGER } from "../lib/contracts.mjs";
import { readFixture, replay } from "./helpers/replay.mjs";

const USD_TOLERANCE = 0.00001;
const BASE_MS = Date.parse("2026-10-23T12:00:00.000Z");

/** Event at `seconds` after the base time. */
function ev(type, seconds, data = {}, agentId = undefined) {
    const event = { type, timestamp: new Date(BASE_MS + seconds * 1000).toISOString(), data };
    if (agentId !== undefined) event.agentId = agentId;
    return event;
}

function usage(seconds, nano, agentId = undefined, extra = {}) {
    return ev("assistant.usage", seconds, {
        model: "m1", inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, duration: 500,
        copilotUsage: { totalNanoAiu: nano }, ...extra,
    }, agentId);
}

const turns = (blocks) => blocks.filter((block) => block.kind === "turn");
const agentBlocks = (blocks) => blocks.filter((block) => block.kind === "agent");
const allRows = (blocks) => blocks.flatMap((block) => (block.kind === "turn" ? block.rows : [block.row]));

// ---------------------------------------------------------------- fixture A (real data)

const FIXTURE_A = "dispatch-turns";
const AGENTS_BY_TASK = new Map([
    ["b1-setup", { agent: "sub-worker-main", req: 8, usd: 0.01834 }],
    ["b1-t2-price", { agent: "sub-worker-main", req: 15, usd: 0.07216 }],
    ["b1-t4-statusline", { agent: "sub-worker-wt", req: 18, usd: 0.14773 }],
    ["b1-t1-config", { agent: "sub-worker-wt", req: 22, usd: 0.07788 }],
    ["b1-integrate-w1", { agent: "sub-worker-main", req: 12, usd: 0.01505 }],
]);

function replayFixtureA() {
    const accounting = createAccounting();
    const events = readFixture(FIXTURE_A);
    return { accounting, events, blocks: replay(accounting, events) };
}

test("fixture A: blocks come in the order turn, agent, turn, agent, agent, agent, turn, turn, agent, turn", () => {
    const { blocks } = replayFixtureA();
    assert.deepEqual(
        blocks.map((block) => block.kind),
        ["turn", "agent", "turn", "agent", "agent", "agent", "turn", "turn", "agent", "turn"],
    );
});

test("fixture A: agent blocks carry the lifetime req and cost of each sub-agent", () => {
    const { blocks } = replayFixtureA();
    const finished = agentBlocks(blocks);
    assert.equal(finished.length, AGENTS_BY_TASK.size);
    for (const { row } of finished) {
        const expected = AGENTS_BY_TASK.get(row.task);
        assert.ok(expected, `unexpected task ${row.task}`);
        assert.equal(row.agent, expected.agent, row.task);
        assert.equal(row.req, expected.req, row.task);
        assert.ok(Math.abs(row.costUsd - expected.usd) <= USD_TOLERANCE, `${row.task} cost ${row.costUsd}`);
        assert.equal(row.status, STATUS.DONE, row.task);
    }
    const config = finished.find((block) => block.row.task === "b1-t1-config");
    assert.ok(Math.abs(config.row.wallMs - 217253) <= 50, `wall ${config.row.wallMs}`);
});

test("fixture A: turn 1 lists the setup agent as running", () => {
    const { blocks } = replayFixtureA();
    const turn = turns(blocks)[0];
    assert.equal(turn.number, 1);
    assert.equal(turn.trigger, TURN_TRIGGER.USER);
    assert.equal(turn.rows[0].agent, ROOT_AGENT);
    assert.equal(turn.rows.length, 2);
    assert.equal(turn.rows[1].task, "b1-setup");
    assert.equal(turn.rows[1].status, STATUS.RUNNING);
});

test("fixture A: the keep-alive turn writes no block and turn 2 (agent notice) carries keep-alive count 1 and its cost", () => {
    const { blocks } = replayFixtureA();
    const all = turns(blocks);
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((turn) => turn.number), [1, 2, 3, 4, 5]);
    const turn = all[1];
    assert.equal(turn.trigger, TURN_TRIGGER.NOTICE);
    assert.equal(turn.keepalive.count, 1);
    assert.ok(Math.abs(turn.keepalive.usd - 0.0411) <= 0.0001, `keep-alive usd ${turn.keepalive.usd}`);
    assert.equal(turn.rows.length, 4);
    assert.deepEqual(turn.rows.slice(1).map((row) => row.status), [STATUS.RUNNING, STATUS.RUNNING, STATUS.RUNNING]);
    assert.equal(all[0].keepalive.count, 0);
    assert.equal(all[2].keepalive.count, 0);
});

test("fixture A: turn 4 has only the main row", () => {
    const { blocks } = replayFixtureA();
    const turn = turns(blocks)[3];
    assert.equal(turn.number, 4);
    assert.equal(turn.rows.length, 1);
    assert.equal(turn.rows[0].agent, ROOT_AGENT);
});

test("fixture A: main-row costs of all turn blocks plus keep-alive cost equal all root usage in the fixture", () => {
    const { blocks, events } = replayFixtureA();
    const rootNano = events
        .filter((event) => event.type === "assistant.usage" && event.agentId === undefined)
        .reduce((sum, event) => sum + event.data.copilotUsage.totalNanoAiu, 0);
    const mainUsd = turns(blocks).reduce((sum, turn) => sum + turn.rows[0].costUsd + turn.keepalive.usd, 0);
    assert.ok(Math.abs(mainUsd - rootNano / NANO_AIU_PER_USD) <= USD_TOLERANCE, `${mainUsd} vs ${rootNano / NANO_AIU_PER_USD}`);
});

test("fixture A: every row has otherMs = max(0, wall - llm - tools - gov - wait)", () => {
    const { blocks } = replayFixtureA();
    const rows = allRows(blocks);
    assert.ok(rows.length > 10);
    for (const row of rows) {
        const expected = Math.max(0, row.wallMs - row.llmMs - row.toolsMs - row.govMs - row.waitMs);
        assert.equal(row.otherMs, expected, `${row.agent} ${row.task}`);
        assert.ok(row.otherMs >= 0);
    }
});

test("fixture A: sessionUsd after replay equals all usage in the fixture", () => {
    const { accounting, events } = replayFixtureA();
    const allNano = events
        .filter((event) => event.type === "assistant.usage")
        .reduce((sum, event) => sum + event.data.copilotUsage.totalNanoAiu, 0);
    assert.ok(Math.abs(accounting.sessionUsd() - allNano / NANO_AIU_PER_USD) <= USD_TOLERANCE);
});

// ---------------------------------------------------------------- synthetic fixture

test("dialog inside the preToolUse window counts once", () => {
    const blocks = replay(createAccounting(), readFixture("dialog-in-gov"));
    assert.equal(blocks.length, 1);
    const main = blocks[0].rows[0];
    assert.equal(main.wallMs, 16000);
    assert.equal(main.llmMs, 1900);
    assert.equal(main.waitMs, 10000);
    assert.equal(main.govMs, 1800);
    assert.equal(main.toolsMs, 1100);
    assert.equal(main.otherMs, 1200);
    assert.ok(Math.abs(main.costUsd - 0.01) <= USD_TOLERANCE);
    assert.equal(main.cacheRead / main.tokensIn, 0.8);
    assert.equal(main.ttftSumMs, 500);
    assert.equal(main.ttftCount, 1);
    assert.equal(main.model, "m1");
});

// ---------------------------------------------------------------- inline sequences

test("parallel sub-agents keep their own gov windows", () => {
    const events = [
        ev("user.message", 0, { content: "user prompt" }),
        ev("subagent.started", 0.5, { toolCallId: "tA", agentName: "agent-a" }, "A"),
        ev("subagent.started", 0.6, { toolCallId: "tB", agentName: "agent-b" }, "B"),
        ev("hook.start", 1, { hookInvocationId: "hA", hookType: "preToolUse", input: { toolCalls: [{ id: "ta" }] } }, "A"),
        ev("hook.start", 2, { hookInvocationId: "hB", hookType: "preToolUse", input: { toolCalls: [{ id: "tb" }] } }, "B"),
        ev("hook.end", 3, { hookInvocationId: "hA", hookType: "preToolUse", success: true }, "A"),
        ev("hook.end", 5, { hookInvocationId: "hB", hookType: "preToolUse", success: true }, "B"),
        ev("session.idle", 10),
    ];
    const [turn] = replay(createAccounting(), events);
    const byAgent = new Map(turn.rows.map((row) => [row.agent, row]));
    assert.equal(byAgent.get("agent-a").govMs, 2000);
    assert.equal(byAgent.get("agent-b").govMs, 3000);
    assert.equal(byAgent.get(ROOT_AGENT).govMs, 0);
});

function waitOfRowsAfterDialog(dialogEvents) {
    const events = [
        ev("user.message", 0, { content: "user prompt" }),
        ev("subagent.started", 1, { toolCallId: "tA", agentName: "agent-a" }, "A"),
        ev("tool.execution_start", 2, { toolCallId: "ta1", toolName: "powershell" }, "A"),
        ...dialogEvents,
        ev("session.idle", 10),
    ];
    const [turn] = replay(createAccounting(), events);
    return new Map(turn.rows.map((row) => [row.agent, row.waitMs]));
}

test("a dialog without agentId goes to the agent of its toolCallId, else the only open preToolUse window, else main", () => {
    const byToolCall = waitOfRowsAfterDialog([
        ev("elicitation.requested", 3, { requestId: "r1", toolCallId: "ta1" }),
        ev("elicitation.completed", 8, { requestId: "r1" }),
    ]);
    assert.equal(byToolCall.get("agent-a"), 5000);
    assert.equal(byToolCall.get(ROOT_AGENT), 0);

    const byOpenWindow = waitOfRowsAfterDialog([
        ev("hook.start", 2.5, { hookInvocationId: "hA", hookType: "preToolUse", input: { toolCalls: [{ id: "ta1" }] } }, "A"),
        ev("permission.requested", 3, { requestId: "r2" }),
        ev("permission.completed", 8, { requestId: "r2" }),
        ev("hook.end", 9, { hookInvocationId: "hA", hookType: "preToolUse", success: true }, "A"),
    ]);
    assert.equal(byOpenWindow.get("agent-a"), 5000);
    assert.equal(byOpenWindow.get(ROOT_AGENT), 0);

    const toMain = waitOfRowsAfterDialog([
        ev("user_input.requested", 3, { requestId: "r3" }),
        ev("user_input.completed", 8, { requestId: "r3" }),
    ]);
    assert.equal(toMain.get(ROOT_AGENT), 5000);
    assert.equal(toMain.get("agent-a"), 0);
});

test("subagent.failed gives status failed and one agent block when the root is idle", () => {
    const accounting = createAccounting();
    const turnEvents = [
        ev("user.message", 0, { content: "user prompt" }),
        ev("tool.execution_start", 0.5, { toolCallId: "t1", toolName: "task", arguments: { name: "job-1", description: "d" } }),
        ev("subagent.started", 1, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        usage(2, 2e9, "X"),
        ev("session.idle", 5),
    ];
    const first = replay(accounting, turnEvents);
    assert.deepEqual(first.map((block) => block.kind), ["turn"]);
    assert.equal(first[0].rows[1].status, STATUS.RUNNING);
    const failed = accounting.apply(ev("subagent.failed", 20, { toolCallId: "t1", agentName: "agent-x" }, "X"), 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].kind, "agent");
    assert.equal(failed[0].row.status, STATUS.FAILED);
    assert.equal(failed[0].row.task, "job-1");
    assert.equal(failed[0].row.agent, "agent-x");
    assert.equal(failed[0].row.wallMs, 19000);
    assert.ok(Math.abs(failed[0].row.costUsd - 0.02) <= USD_TOLERANCE);
});

test("cancelled completion gives status failed", () => {
    const accounting = createAccounting();
    replay(accounting, [
        ev("subagent.started", 1, { toolCallId: "t1", agentName: "agent-x" }, "X"),
    ]);
    const blocks = accounting.apply(ev("subagent.completed", 4, { toolCallId: "t1", agentName: "agent-x", cancelled: true }, "X"), 0);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].row.status, STATUS.FAILED);
});

test("a sub-agent that finishes while a turn is open is written after that turn's block", () => {
    const accounting = createAccounting();
    const first = replay(accounting, [
        ev("user.message", 0, { content: "user prompt" }),
        ev("subagent.started", 1, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        ev("session.idle", 5),
    ]);
    assert.deepEqual(first.map((block) => block.kind), ["turn"]);

    const second = replay(accounting, [
        ev("user.message", 10, { content: "user prompt" }),
        ev("subagent.completed", 12, { toolCallId: "t1", agentName: "agent-x" }, "X"),
    ]);
    assert.deepEqual(second, []);

    const third = accounting.apply(ev("session.idle", 15), 0);
    assert.deepEqual(third.map((block) => block.kind), ["turn", "agent"]);
    assert.equal(third[0].number, 2);
    assert.equal(third[0].rows.length, 1);
    assert.equal(third[1].row.status, STATUS.DONE);
    assert.equal(third[1].row.agent, "agent-x");
});

test("a repeated subagent.completed for a deferred sub-agent writes no second block", () => {
    const blocks = replay(createAccounting(), [
        ev("subagent.started", 0, { agentName: "agent-x" }, "X"),
        ev("user.message", 1, { content: "user prompt" }),
        ev("subagent.completed", 2, { agentName: "agent-x" }, "X"),
        ev("subagent.completed", 3, { agentName: "agent-x" }, "X"),
        ev("session.idle", 4),
        ev("subagent.completed", 5, { agentName: "agent-x" }, "X"),
        ev("session.idle", 6),
    ]);
    assert.deepEqual(blocks.map((block) => block.kind), ["turn", "agent"]);
});

test("a sub-agent that starts and finishes inside one turn is only a row of that turn", () => {
    const blocks = replay(createAccounting(), [
        ev("user.message", 0, { content: "user prompt" }),
        ev("subagent.started", 1, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        ev("subagent.completed", 4, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        ev("session.idle", 5),
    ]);
    assert.deepEqual(blocks.map((block) => block.kind), ["turn"]);
    assert.equal(blocks[0].rows[1].status, STATUS.DONE);
    assert.equal(blocks[0].rows[1].wallMs, 3000);
});

test("keep-alive turns write no block; their requests are carried to the next real turn and the session total", () => {
    const accounting = createAccounting();
    const keepalive = (start) => [
        ev("user.message", start, { content: "[keepalive] ping" }),
        usage(start + 1, 1e9),
        usage(start + 2, 2e9),
        ev("session.idle", start + 3),
    ];
    assert.deepEqual(replay(accounting, keepalive(0)), []);
    assert.deepEqual(replay(accounting, keepalive(10)), []);
    const [turn] = replay(accounting, [
        ev("user.message", 20, { content: "user prompt" }),
        usage(21, 5e9),
        ev("session.idle", 22),
    ]);
    assert.equal(turn.keepalive.count, 2);
    assert.ok(Math.abs(turn.keepalive.usd - 0.06) <= USD_TOLERANCE);
    assert.ok(Math.abs(turn.costUsd - 0.05) <= USD_TOLERANCE);
    assert.ok(Math.abs(turn.sessionUsd - 0.11) <= USD_TOLERANCE);
    assert.ok(Math.abs(accounting.sessionUsd() - 0.11) <= USD_TOLERANCE);

    const [next] = replay(accounting, [ev("user.message", 30, { content: "user prompt" }), ev("session.idle", 31)]);
    assert.equal(next.keepalive.count, 0);
});

test("a keep-alive turn that starts a sub-agent is a real turn", () => {
    const blocks = replay(createAccounting(), [
        ev("user.message", 0, { content: "[keepalive]" }),
        ev("subagent.started", 1, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        ev("session.idle", 3),
    ]);
    assert.deepEqual(blocks.map((block) => block.kind), ["turn"]);
    assert.equal(blocks[0].rows.length, 2);
});

test("session.idle without an open turn returns no block", () => {
    const accounting = createAccounting();
    assert.deepEqual(accounting.apply(ev("session.idle", 1), 0), []);
});

test("malformed events (null, missing data, missing timestamp) return [] and do not throw", () => {
    const accounting = createAccounting();
    const malformed = [
        null,
        undefined,
        "text",
        42,
        {},
        { type: "assistant.usage", timestamp: "2026-10-23T12:00:00.000Z" },
        { type: "subagent.started", timestamp: "2026-10-23T12:00:00.000Z" },
        { type: "tool.execution_start", timestamp: "2026-10-23T12:00:00.000Z", data: null },
        { type: "hook.start", data: {} },
        { type: "user.message", data: { content: "user prompt" } },
        { type: "assistant.usage", data: { copilotUsage: { totalNanoAiu: "x" } } },
    ];
    for (const event of malformed) {
        assert.deepEqual(accounting.apply(event, BASE_MS), [], JSON.stringify(event));
    }
});

test("usage without a finite cost counts as zero", () => {
    const accounting = createAccounting();
    const [turn] = replay(accounting, [
        ev("user.message", 0, { content: "user prompt" }),
        ev("assistant.usage", 1, { model: "m1", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, duration: 100 }),
        ev("session.idle", 2),
    ]);
    assert.equal(turn.rows[0].req, 1);
    assert.equal(turn.rows[0].costUsd, 0);
    assert.equal(accounting.sessionUsd(), 0);
});

test("several models of one agent are shown as the last model plus the count of the others", () => {
    const [turn] = replay(createAccounting(), [
        ev("user.message", 0, { content: "user prompt" }),
        usage(1, 1e9, undefined, { model: "m1" }),
        usage(2, 1e9, undefined, { model: "m2" }),
        usage(3, 1e9, undefined, { model: "m1" }),
        ev("session.idle", 4),
    ]);
    assert.equal(turn.rows[0].model, "m2 +1");
});

// ---------------------------------------------------------------- ended sub-agents (AC-16)

/** One short sub-agent in its own turn: start, end, close the turn. */
function shortSubAgentTurn(accounting, index) {
    return replay(accounting, [
        ev("user.message", index * 10, { content: "user prompt" }),
        ev("subagent.started", index * 10 + 1, { toolCallId: `t${index}`, agentName: "agent-x" }, `A${index}`),
        ev("subagent.completed", index * 10 + 2, { toolCallId: `t${index}`, agentName: "agent-x" }, `A${index}`),
        ev("session.idle", index * 10 + 3),
    ]);
}

test("1,000 ended sub-agents keep no agent record and the retained key count stops growing", () => {
    const accounting = createAccounting();
    for (let index = 0; index < 200; index += 1) shortSubAgentTurn(accounting, index);
    const afterTwoHundred = accounting.memory();
    for (let index = 200; index < 1000; index += 1) shortSubAgentTurn(accounting, index);
    const afterThousand = accounting.memory();

    assert.equal(afterThousand.agentRecords, 0);
    assert.deepEqual(afterThousand, afterTwoHundred);
});

test("a usage after its sub-agent ended (block written) creates no unknown record and no block", () => {
    const accounting = createAccounting();
    const [firstTurn] = shortSubAgentTurn(accounting, 0);
    assert.equal(firstTurn.rows.length, 2);

    assert.deepEqual(accounting.apply(usage(40, 2e9, "A0"), 0), []);
    assert.equal(accounting.memory().agentRecords, 0);

    const [secondTurn] = replay(accounting, [
        ev("user.message", 50, { content: "user prompt" }),
        ev("session.idle", 51),
    ]);
    assert.deepEqual(secondTurn.rows.map((row) => row.agent), [ROOT_AGENT]);
    assert.ok(Math.abs(accounting.sessionUsd() - 0.02) <= USD_TOLERANCE, `session ${accounting.sessionUsd()}`);
});

test("a usage after a deferred sub-agent ended is not counted in its row", () => {
    const accounting = createAccounting();
    const blocks = replay(accounting, [
        ev("subagent.started", 0, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        ev("user.message", 1, { content: "user prompt" }),
        ev("subagent.completed", 2, { toolCallId: "t1", agentName: "agent-x" }, "X"),
        usage(3, 1e9, "X"),
        ev("session.idle", 4),
    ]);
    const [agentBlock] = agentBlocks(blocks);
    assert.equal(agentBlock.row.req, 0);
    assert.ok(Math.abs(agentBlock.row.costUsd) <= USD_TOLERANCE, `row cost ${agentBlock.row.costUsd}`);
});
