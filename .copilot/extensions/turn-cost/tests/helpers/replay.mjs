// Test helper: reads event fixtures and replays them through the accounting.
import { readFileSync } from "node:fs";

/**
 * Reads `../fixtures/<name>.jsonl`: one JSON event per non-empty line.
 * @param {string} name fixture name without extension
 * @returns {object[]}
 */
export function readFixture(name) {
    const text = readFileSync(new URL(`../fixtures/${name}.jsonl`, import.meta.url), "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/**
 * Feeds every event to the accounting at its own timestamp and returns all blocks in the order they were produced.
 * @param {{apply: (event: object, nowMs: number) => object[]}} accounting
 * @param {object[]} events
 * @returns {object[]}
 */
export function replay(accounting, events) {
    return events.flatMap((event) => accounting.apply(event, Date.parse(event.timestamp)));
}
