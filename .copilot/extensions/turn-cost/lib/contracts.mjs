// Shared contracts of the turn-cost extension: frozen enums, constants and JSDoc typedefs. No imports, no runtime dependencies.

/** Metric keys in fixed column order after `agent`. */
export const METRICS = Object.freeze(["task", "model", "status", "req", "cost", "tokens", "cache", "wall", "llm", "ttft", "tools", "gov", "wait", "other"]);

/** Default on/off state per metric key (`ttft` is off by default). */
export const DEFAULT_METRICS = Object.freeze({
    task: true, model: true, status: true, req: true, cost: true, tokens: true, cache: true,
    wall: true, llm: true, ttft: false, tools: true, gov: true, wait: true, other: true,
});

/** Status of an agent row. */
export const STATUS = Object.freeze({ RUNNING: "running", DONE: "done", FAILED: "failed" });

/** What started a turn. */
export const TURN_TRIGGER = Object.freeze({ USER: "user", NOTICE: "notice" });

/** Name of the root agent; rows[0] of a turn block is this agent. */
export const ROOT_AGENT = "main";

/** Nano AIU per USD (checked to the cent, analysis-c4a2ba2a.md:38). */
export const NANO_AIU_PER_USD = 1e11;

/** A turn whose cost is at most this many USD is a simple turn. */
export const SIMPLE_TURN_MAX_USD = 0.5;

/** Prefix of the keep-alive prompts sent by the cache-keeper. */
export const KEEPALIVE_PREFIX = "[keepalive]";

/**
 * One agent's figures inside a turn.
 * @typedef {object} AgentRow
 * @property {string} agent
 * @property {string|null} task
 * @property {string} model
 * @property {string} status
 * @property {number} req
 * @property {number} costUsd
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} cacheRead
 * @property {number} wallMs
 * @property {number} llmMs
 * @property {number} ttftSumMs
 * @property {number} ttftCount
 * @property {number} toolsMs
 * @property {number} govMs
 * @property {number} waitMs
 * @property {number} otherMs
 */

/**
 * A finished or running turn in the timeline. `rows[0]` is the root agent (`ROOT_AGENT`).
 * @typedef {object} TurnBlock
 * @property {"turn"} kind
 * @property {number} number
 * @property {string} trigger  one of TURN_TRIGGER
 * @property {number} wallMs
 * @property {number} agentTimeMs
 * @property {number} costUsd
 * @property {number} sessionUsd
 * @property {{count: number, usd: number}} keepalive
 * @property {AgentRow[]} rows
 */

/**
 * A line for one agent event, outside a turn table.
 * @typedef {object} AgentBlock
 * @property {"agent"} kind
 * @property {number} sessionUsd
 * @property {AgentRow} row
 */

/**
 * Enabled state per metric key.
 * @typedef {Record<string, boolean>} MetricConfig
 */
