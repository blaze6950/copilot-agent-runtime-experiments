// Rendering of the turn-cost timeline: one cyan line for a simple turn, otherwise a header line and a Markdown table.
// Pure: no I/O. Each table cell is wrapped in cyan on its own; the Markdown block itself is never wrapped (verified live, 6b breaks).
import { SIMPLE_TURN_MAX_USD, METRICS, TURN_TRIGGER } from "./contracts.mjs";
import { formatCount, formatCost, formatDuration, formatPercent, formatTokens } from "./format.mjs";
import { cyan } from "./color.mjs";

const PART_SEPARATOR = " · ";
/** Parts of the main row that the turn header already shows. */
const TURN_LINE_SKIPPED_KEYS = ["task", "status", "cost", "wall"];
/** Parts of an agent line that its prefix already shows (the task is shown in quotes after the name). */
const AGENT_LINE_SKIPPED_KEYS = ["task"];

const isText = (value) => typeof value === "string" && value !== "";
const cacheRatio = (row) => (row.tokensIn > 0 ? row.cacheRead / row.tokensIn : null);

/** A column of the table and of the line parts: `has` tells whether the row carries a value for it. */
const msColumn = (key, field) => ({
    has: (row) => row[field] > 0,
    cell: (row) => formatDuration(row[field]),
    part: (row) => `${key} ${formatDuration(row[field])}`,
});

/** Per metric key: `has` (value is set, so the column or part is shown), `cell` (table text) and `part` (line text). */
const COLUMNS = {
    task: { has: (row) => isText(row.task), cell: (row) => row.task ?? "" },
    model: { has: (row) => isText(row.model), cell: (row) => row.model, part: (row) => row.model },
    status: { has: (row) => isText(row.status), cell: (row) => row.status, part: (row) => row.status },
    req: { has: (row) => row.req > 0, cell: (row) => formatCount(row.req), part: (row) => `${formatCount(row.req)} req` },
    cost: { has: (row) => row.costUsd > 0, cell: (row) => formatCost(row.costUsd), part: (row) => formatCost(row.costUsd) },
    tokens: {
        has: (row) => row.tokensIn + row.tokensOut > 0,
        cell: (row) => formatTokens(row.tokensIn, row.tokensOut),
        part: (row) => `${formatTokens(row.tokensIn, row.tokensOut)} tok`,
    },
    cache: {
        has: (row) => row.cacheRead > 0,
        cell: (row) => formatPercent(cacheRatio(row)),
        part: (row) => `cache ${formatPercent(cacheRatio(row))}`,
    },
    wall: { has: (row) => row.wallMs > 0, cell: (row) => formatDuration(row.wallMs), part: (row) => formatDuration(row.wallMs) },
    llm: msColumn("llm", "llmMs"),
    ttft: {
        has: (row) => row.ttftCount > 0,
        cell: (row) => (row.ttftCount > 0 ? formatDuration(row.ttftSumMs / row.ttftCount) : ""),
        part: (row) => `ttft ${formatDuration(row.ttftSumMs / row.ttftCount)}`,
    },
    tools: msColumn("tools", "toolsMs"),
    gov: msColumn("gov", "govMs"),
    wait: msColumn("wait", "waitMs"),
    other: msColumn("other", "otherMs"),
};

/**
 * Columns of the table after `agent`: metrics that are on and have a value in at least one row, in METRICS order.
 * @param {import("./contracts.mjs").AgentRow[]} rows
 * @param {import("./contracts.mjs").MetricConfig} metrics
 * @returns {string[]}
 */
export function visibleColumns(rows, metrics) {
    return METRICS.filter((key) => metrics[key] && rows.some((row) => COLUMNS[key].has(row)));
}

/** Line parts of one row, in METRICS order; metrics that are off or have no value are left out. */
function rowParts(row, metrics, skippedKeys) {
    return METRICS.filter((key) => metrics[key] && !skippedKeys.includes(key) && COLUMNS[key].has(row) && COLUMNS[key].part)
        .map((key) => COLUMNS[key].part(row));
}

/** Header parts of a turn: `agent time` only in the table, `keep-alive` only when keep-alives happened since the last real turn. */
function turnHeaderParts(block, withAgentTime) {
    const parts = [
        `turn ${block.number}${block.trigger === TURN_TRIGGER.NOTICE ? " (agent notice)" : ""}`,
        formatDuration(block.wallMs),
        formatCost(block.costUsd),
        `session ${formatCost(block.sessionUsd)}`,
    ];
    if (withAgentTime) parts.push(`agent time ${formatDuration(block.agentTimeMs)}`);
    if (block.keepalive.count > 0) {
        parts.push(`keep-alive ${block.keepalive.count}× ${formatCost(block.keepalive.usd)} since last turn`);
    }
    return parts;
}

/** Markdown cell text: a pipe is escaped and a line break becomes a space. */
const escapeCell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The total row: sums of the agent rows; wall is the turn wall; cache and ttft are computed from the sums. */
function totalRowOf(block) {
    const sum = (field) => block.rows.reduce((total, row) => total + row[field], 0);
    return {
        agent: "total", task: "", model: "", status: "",
        req: sum("req"), costUsd: sum("costUsd"),
        tokensIn: sum("tokensIn"), tokensOut: sum("tokensOut"), cacheRead: sum("cacheRead"),
        wallMs: block.wallMs,
        llmMs: sum("llmMs"), ttftSumMs: sum("ttftSumMs"), ttftCount: sum("ttftCount"),
        toolsMs: sum("toolsMs"), govMs: sum("govMs"), waitMs: sum("waitMs"), otherMs: sum("otherMs"),
    };
}

/** Header line, blank line, Markdown table; every cell is wrapped in cyan on its own, the separator row is plain. */
function renderTable(block, metrics, color) {
    const columns = visibleColumns(block.rows, metrics);
    const headerCells = ["agent", ...columns];
    const cellLine = (cells) => `| ${cells.map((text) => cyan(escapeCell(text), color)).join(" | ")} |`;
    const rowLine = (row) => cellLine([row.agent, ...columns.map((key) => COLUMNS[key].cell(row))]);
    return [
        cyan(turnHeaderParts(block, true).join(PART_SEPARATOR), color),
        "",
        cellLine(headerCells),
        `|${headerCells.map(() => "---").join("|")}|`,
        ...block.rows.map(rowLine),
        rowLine(totalRowOf(block)),
    ].join("\n");
}

/**
 * One turn: a single cyan line when the turn ran no sub-agents and cost at most SIMPLE_TURN_MAX_USD, otherwise a header line and a table.
 * @param {import("./contracts.mjs").TurnBlock} block
 * @param {{metrics: import("./contracts.mjs").MetricConfig, color: boolean}} options
 * @returns {string}
 */
export function renderTurn(block, { metrics, color }) {
    if (block.rows.length === 1 && block.costUsd <= SIMPLE_TURN_MAX_USD) {
        const parts = [...turnHeaderParts(block, false), ...rowParts(block.rows[0], metrics, TURN_LINE_SKIPPED_KEYS)];
        return cyan(parts.join(PART_SEPARATOR), color);
    }
    return renderTable(block, metrics, color);
}

/**
 * One agent event: a single cyan line with the agent name, its task in quotes when there is one, its figures and the session total.
 * @param {import("./contracts.mjs").AgentBlock} block
 * @param {{metrics: import("./contracts.mjs").MetricConfig, color: boolean}} options
 * @returns {string}
 */
export function renderAgent(block, { metrics, color }) {
    const { row } = block;
    const prefix = metrics.task && isText(row.task) ? `${row.agent} "${row.task}"` : row.agent;
    const parts = [prefix, ...rowParts(row, metrics, AGENT_LINE_SKIPPED_KEYS), `session ${formatCost(block.sessionUsd)}`];
    return cyan(parts.join(PART_SEPARATOR), color);
}

