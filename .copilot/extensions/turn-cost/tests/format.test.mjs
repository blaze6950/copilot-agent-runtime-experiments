// Table tests for the humanizing formatter (AC-5): counts, durations, costs, percentages and token pairs at their boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCount, formatDuration, formatCost, formatPercent, formatTokens } from "../lib/format.mjs";

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const COUNT_CASES = [
    [0, "0"],
    [842, "842"],
    [999, "999"],
    [1000, "1k"],
    [1234, "1.2k"],
    [9950, "10k"],
    [210000, "210k"],
    [999499, "999k"],
    [999500, "1M"],
    [46600000, "46.6M"],
    [1.2e9, "1.2B"],
];

const DURATION_CASES = [
    [0, "0s"],
    [400, "0s"],
    [500, "1s"],
    [9000, "9s"],
    [59000, "59s"],
    [59500, "1m00s"],
    [60000, "1m00s"],
    [134000, "2m14s"],
    [3599000, "59m59s"],
    [3600000, "1h00m"],
    [3780000, "1h03m"],
    [-5000, "0s"],
];

const COST_CASES = [
    [0, "$0.00"],
    [0.004, "<$0.01"],
    [0.005, "$0.01"],
    [0.12, "$0.12"],
    [999.994, "$999.99"],
    [1234, "$1.2k"],
];

const PERCENT_CASES = [
    [0, "0%"],
    [0.004, "0%"],
    [0.925, "93%"],
    [1, "100%"],
    [null, "-"],
];

for (const [input, expected] of COUNT_CASES) {
    test(`formatCount: ${input} renders as ${expected}`, () => {
        assert.equal(formatCount(input), expected);
    });
}

for (const [input, expected] of DURATION_CASES) {
    test(`formatDuration: ${input} ms renders as ${expected}`, () => {
        assert.equal(formatDuration(input), expected);
    });
}

for (const [input, expected] of COST_CASES) {
    test(`formatCost: ${input} renders as ${expected}`, () => {
        assert.equal(formatCost(input), expected);
    });
}

for (const [input, expected] of PERCENT_CASES) {
    test(`formatPercent: ${input} renders as ${expected}`, () => {
        assert.equal(formatPercent(input), expected);
    });
}

test("formatTokens: 46600000 in and 210000 out render as 46.6M/210k", () => {
    assert.equal(formatTokens(46600000, 210000), "46.6M/210k");
});

test("formatCount, formatDuration and formatCost render non-finite input as -", () => {
    for (const value of NON_FINITE) {
        assert.equal(formatCount(value), "-");
        assert.equal(formatDuration(value), "-");
        assert.equal(formatCost(value), "-");
    }
});
