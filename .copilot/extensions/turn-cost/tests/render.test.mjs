// Rendering of the turn-cost timeline (AC-1, AC-4, AC-6, AC-7): cyan lines and tables, humanized cells, hidden zero columns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTurn, renderAgent, visibleColumns } from "../lib/render.mjs";
import { DEFAULT_METRICS, STATUS, TURN_TRIGGER } from "../lib/contracts.mjs";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const ANSI = /\x1b\[[0-9;]*m/g;
const SEPARATOR = /^\|(---\|)+$/;

const ON = { ...DEFAULT_METRICS };

const plain = (text) => text.replace(ANSI, "");
const cellsOf = (line) => plain(line).slice(1, -1).split("|").map((cell) => cell.trim());
const tableLines = (text) => text.split("\n").filter((line) => plain(line).startsWith("|"));

function row(overrides = {}) {
    return {
        agent: "main", task: null, model: "claude-opus-5.5", status: STATUS.DONE,
        req: 3, costUsd: 0.12, tokensIn: 46600000, tokensOut: 210000, cacheRead: 40000000,
        wallMs: 134000, llmMs: 90000, ttftSumMs: 0, ttftCount: 0, toolsMs: 20000, govMs: 0, waitMs: 0, otherMs: 4000,
        ...overrides,
    };
}

function turn(overrides = {}, rows = [row()]) {
    return {
        kind: "turn", number: 3, trigger: TURN_TRIGGER.USER, wallMs: 134000, agentTimeMs: 98000,
        costUsd: 0.12, sessionUsd: 0.84, keepalive: { count: 0, usd: 0 }, rows,
        ...overrides,
    };
}

const SUB_AGENT_ROW = row({
    agent: "worker-main", task: "T4 render", model: "gpt-5", req: 2, costUsd: 0.41,
    tokensIn: 1200000, tokensOut: 30000, cacheRead: 600000, wallMs: 62000, llmMs: 50000, toolsMs: 9000, otherMs: 1000,
});
const TWO_ROWS = [row(), SUB_AGENT_ROW];

test("simple turn (main only, cost <= $0.50) is one cyan line", () => {
    const out = renderTurn(turn({ costUsd: 0.12 }), { metrics: ON, color: true });
    assert.equal(out.split("\n").length, 1, out);
    assert.ok(out.startsWith(CYAN) && out.endsWith(RESET), out);
    assert.equal(out.split(CYAN).length, 2, "one colour span only");
    const text = plain(out);
    assert.ok(text.includes("turn 3"), text);
    assert.ok(text.includes("$0.12"), text);
    assert.ok(text.includes("session $0.84"), text);
    assert.equal(text.includes("|"), false, text);
    assert.equal(text.includes("agent time"), false, "agent time is shown only in the table header");
});

test("turn with a sub-agent is a header line, a blank line and a Markdown table with a total row", () => {
    const out = renderTurn(turn({ costUsd: 0.53 }, TWO_ROWS), { metrics: ON, color: true });
    const lines = out.split("\n");
    assert.equal(lines.length, 7, out);
    assert.ok(plain(lines[0]).includes("turn 3") && plain(lines[0]).includes("agent time 1m38s"), plain(lines[0]));
    assert.equal(plain(lines[1]), "");
    assert.equal(cellsOf(lines[2])[0], "agent");
    assert.ok(SEPARATOR.test(plain(lines[3])), plain(lines[3]));
    assert.equal(cellsOf(lines[4])[0], "main");
    assert.equal(cellsOf(lines[5])[0], "worker-main");
    assert.equal(cellsOf(lines[6])[0], "total");
});

test("turn with cost above $0.50 and no sub-agents is a table", () => {
    const out = renderTurn(turn({ costUsd: 0.8 }, [row({ costUsd: 0.8 })]), { metrics: ON, color: true });
    const table = tableLines(out);
    assert.equal(table.length, 4, out);
    assert.equal(cellsOf(table[0])[0], "agent");
    assert.equal(cellsOf(table[3])[0], "total");
});

test("every non-empty table cell is wrapped in cyan on its own and no line starts with an escape code", () => {
    const out = renderTurn(turn({ costUsd: 0.53 }, TWO_ROWS), { metrics: ON, color: true });
    const [header, blank, ...table] = out.split("\n");
    assert.ok(header.startsWith(CYAN) && header.endsWith(RESET), "the header line is one cyan span");
    assert.equal(plain(blank), "");
    assert.equal(table.length, 5);
    for (const line of table) {
        assert.equal(line.startsWith("\x1b"), false, `table line starts with an escape code: ${line}`);
        if (SEPARATOR.test(line)) continue;
        for (const cell of line.slice(1, -1).split("|")) {
            const trimmed = cell.trim();
            if (plain(trimmed) === "") continue;
            assert.match(trimmed, /^\x1b\[36m[^\x1b]+\x1b\[0m$/, `cell not wrapped on its own: ${trimmed}`);
        }
    }
});

test("NO_COLOR: no escape codes anywhere", () => {
    const outputs = [
        renderTurn(turn({ costUsd: 0.12 }), { metrics: ON, color: false }),
        renderTurn(turn({ costUsd: 0.53 }, TWO_ROWS), { metrics: ON, color: false }),
        renderAgent({ kind: "agent", sessionUsd: 0.84, row: SUB_AGENT_ROW }, { metrics: ON, color: false }),
    ];
    for (const out of outputs) {
        assert.notEqual(out, "", "output must exist, so that the check is not vacuous");
        assert.equal(out.includes("\x1b"), false, out);
    }
});

test("a column whose values are all 0 is hidden", () => {
    const out = renderTurn(turn({ costUsd: 0.53 }, TWO_ROWS), { metrics: ON, color: true });
    const [headerRow] = tableLines(out);
    assert.equal(cellsOf(headerRow).includes("gov"), false);
    assert.equal(visibleColumns(TWO_ROWS, ON).includes("gov"), false);
    assert.equal(cellsOf(headerRow).includes("tools"), true);
    assert.equal(visibleColumns([row({ govMs: 1200 })], ON).includes("gov"), true);
});

test("a metric switched off is hidden and agent is always shown", () => {
    const metrics = { ...ON, req: false, model: false };
    const out = renderTurn(turn({ costUsd: 0.53 }, TWO_ROWS), { metrics, color: true });
    const [headerRow] = tableLines(out);
    assert.deepEqual(cellsOf(headerRow), ["agent", ...visibleColumns(TWO_ROWS, metrics)]);
    assert.equal(cellsOf(headerRow).includes("req"), false);
    assert.equal(cellsOf(headerRow).includes("model"), false);
    assert.equal(cellsOf(headerRow)[0], "agent");
});

test("header shows keep-alive N× $x since last turn only when N > 0", () => {
    const none = renderTurn(turn({ costUsd: 0.12 }), { metrics: ON, color: false });
    assert.equal(none.includes("keep-alive"), false, none);
    const some = renderTurn(turn({ costUsd: 0.12, keepalive: { count: 3, usd: 0.36 } }), { metrics: ON, color: false });
    assert.ok(some.includes("keep-alive 3× $0.36 since last turn"), some);
});

test("notice turn header says (agent notice)", () => {
    const out = renderTurn(turn({ costUsd: 0.12, trigger: TURN_TRIGGER.NOTICE }), { metrics: ON, color: false });
    assert.ok(out.includes("turn 3 (agent notice)"), out);
});

test("total row: req, cost, tokens summed, wall = turn wall, cache from the summed tokens", () => {
    const first = row({ req: 3, costUsd: 0.12, tokensIn: 1000, tokensOut: 100, cacheRead: 500, wallMs: 60000 });
    const second = row({ agent: "worker-main", task: "T4 render", req: 2, costUsd: 0.3, tokensIn: 3000, tokensOut: 300, cacheRead: 1500, wallMs: 30000 });
    const out = renderTurn(turn({ wallMs: 90000, costUsd: 0.42 }, [first, second]), { metrics: ON, color: false });
    const table = tableLines(out);
    const headers = cellsOf(table[0]);
    const total = cellsOf(table[table.length - 1]);
    const cell = (key) => total[headers.indexOf(key)];
    assert.equal(total[0], "total");
    assert.equal(cell("req"), "5");
    assert.equal(cell("cost"), "$0.42");
    assert.equal(cell("tokens"), "4k/400");
    assert.equal(cell("cache"), "50%");
    assert.equal(cell("wall"), "1m30s");
});

test("cell text with | is escaped", () => {
    const out = renderTurn(turn({ costUsd: 0.53 }, [row({ agent: "a|b" }), SUB_AGENT_ROW]), { metrics: ON, color: false });
    assert.ok(out.includes("| a\\|b |"), out);
});

test("agent line starts with the agent name and the task in quotes when there is one", () => {
    const out = renderAgent(
        { kind: "agent", sessionUsd: 0.84, row: row({ agent: "worker-main", task: "T4 render", status: STATUS.RUNNING, costUsd: 0.41, wallMs: 62000 }) },
        { metrics: ON, color: true },
    );
    assert.equal(out.split("\n").length, 1, out);
    assert.ok(out.startsWith(CYAN) && out.endsWith(RESET), out);
    const text = plain(out);
    assert.ok(text.startsWith('worker-main "T4 render" · '), text);
    assert.ok(text.includes("running"), text);
    assert.ok(text.includes("$0.41"), text);
    assert.ok(text.includes("session $0.84"), text);
});

test("agent line without a task starts with the agent name only, also when the task metric is off", () => {
    const withoutTask = renderAgent(
        { kind: "agent", sessionUsd: 0.84, row: row({ agent: "worker-main", task: null, costUsd: 0.41 }) },
        { metrics: ON, color: false },
    );
    assert.ok(withoutTask.startsWith("worker-main · "), withoutTask);
    assert.equal(withoutTask.includes('""'), false, withoutTask);

    const taskOff = renderAgent(
        { kind: "agent", sessionUsd: 0.84, row: row({ agent: "worker-main", task: "T4 render", costUsd: 0.41 }) },
        { metrics: { ...ON, task: false }, color: false },
    );
    assert.ok(taskOff.startsWith("worker-main · "), taskOff);
    assert.equal(taskOff.includes("T4 render"), false, taskOff);
});

