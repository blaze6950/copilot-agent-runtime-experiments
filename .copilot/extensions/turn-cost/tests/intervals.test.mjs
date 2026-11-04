// Tests for the time-window arithmetic used by the per-agent split (AC-2): union of windows, no double counting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unionMs, exclusiveMs } from "../lib/intervals.mjs";

test("unionMs merges overlaps and ignores empty or reversed windows", () => {
    const windows = [
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 20, end: 20 },
        { start: 30, end: 25 },
    ];
    assert.equal(unionMs(windows), 15);
});

test("exclusiveMs subtracts the union of excluded windows", () => {
    const tool = [{ start: 0, end: 12900 }];
    const excluded = [{ start: 100, end: 11900 }];
    assert.equal(exclusiveMs(tool, excluded), 1100);
});

test("exclusiveMs with no excluded windows equals unionMs", () => {
    const windows = [
        { start: 0, end: 10 },
        { start: 5, end: 15 },
    ];
    assert.equal(exclusiveMs(windows, []), unionMs(windows));
});
