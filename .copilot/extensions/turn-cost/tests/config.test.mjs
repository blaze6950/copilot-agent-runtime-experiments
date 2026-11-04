// Strict metric config (AC-7): validation of config.json `metrics` and the runtime read, one warning line per problem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_METRICS } from "../lib/contracts.mjs";
import { disabledBy, metricConfigFrom, normalizeMetrics } from "../lib/config.mjs";

const CONFIG_PATH = "C:/cfg/config.json";

function missingFile() {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
}

test("normalizeMetrics: empty config gives the defaults and no problems", () => {
    const { metrics, problems } = normalizeMetrics({});
    assert.deepEqual(metrics, DEFAULT_METRICS);
    assert.deepEqual(problems, []);
});

test("unknown top-level key -> one problem, ignored", () => {
    const { metrics, problems } = normalizeMetrics({ colour: true, metrics: { cost: false } });
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /"colour"/);
    assert.equal(metrics.cost, false);
});

test("metrics not an object -> defaults and one problem", () => {
    for (const bad of [5, "all", [], null]) {
        const { metrics, problems } = normalizeMetrics({ metrics: bad });
        assert.deepEqual(metrics, DEFAULT_METRICS, String(bad));
        assert.equal(problems.length, 1, String(bad));
        assert.match(problems[0], /metrics must be an object; using the defaults/);
    }
});

test("unknown metric key -> problem, ignored", () => {
    const { metrics, problems } = normalizeMetrics({ metrics: { bogus: true, cost: false } });
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /metrics: unknown key "bogus" ignored/);
    assert.equal(metrics.cost, false);
    assert.equal(Object.hasOwn(metrics, "bogus"), false);
});

test("metrics.agent -> \"always on\" problem", () => {
    const { metrics, problems } = normalizeMetrics({ metrics: { agent: false } });
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /metrics\.agent is always on; ignored/);
    assert.equal(Object.hasOwn(metrics, "agent"), false);
});

test("wrong type -> default and a problem naming the default", () => {
    const { metrics, problems } = normalizeMetrics({ metrics: { cost: "no", ttft: 1 } });
    assert.equal(metrics.cost, true);
    assert.equal(metrics.ttft, false);
    assert.equal(problems.length, 2, JSON.stringify(problems));
    assert.ok(problems.some((line) => /metrics\.cost must be true or false; using true/.test(line)), JSON.stringify(problems));
    assert.ok(problems.some((line) => /metrics\.ttft must be true or false; using false/.test(line)), JSON.stringify(problems));
});

test("missing key -> default without a problem", () => {
    const { metrics, problems } = normalizeMetrics({ metrics: { cost: false } });
    assert.equal(metrics.cost, false);
    assert.equal(metrics.task, true);
    assert.equal(metrics.ttft, false);
    assert.deepEqual(problems, []);
});

test("metricConfigFrom: missing file (ENOENT) -> defaults, no problem", () => {
    const { metrics, problems } = metricConfigFrom(missingFile, CONFIG_PATH);
    assert.deepEqual(metrics, DEFAULT_METRICS);
    assert.deepEqual(problems, []);
});

test("metricConfigFrom: unreadable or invalid JSON -> defaults and one problem", () => {
    const customPath = "C:/cfg/custom-turn.json";
    const unreadable = () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const invalidJson = () => "{ not json";
    for (const reader of [unreadable, invalidJson]) {
        const { metrics, problems } = metricConfigFrom(reader, customPath);
        assert.deepEqual(metrics, DEFAULT_METRICS);
        assert.equal(problems.length, 1, JSON.stringify(problems));
        assert.match(problems[0], /^C:\/cfg\/custom-turn\.json cannot be read: .+; using the defaults$/);
    }
});

test("metricConfigFrom reads the file on every call", () => {
    const texts = ['{"metrics":{"cost":false}}', '{"metrics":{"cost":true,"ttft":true}}'];
    const pathsRead = [];
    const reader = (path) => {
        pathsRead.push(path);
        return texts[pathsRead.length - 1];
    };
    const first = metricConfigFrom(reader, CONFIG_PATH);
    const second = metricConfigFrom(reader, CONFIG_PATH);
    assert.equal(first.metrics.cost, false);
    assert.equal(second.metrics.cost, true);
    assert.equal(second.metrics.ttft, true);
    assert.deepEqual(pathsRead, [CONFIG_PATH, CONFIG_PATH]);
});

test("disabledBy is true for off in any letter case, with surrounding spaces", () => {
    for (const value of ["off", "OFF", "Off", " off ", "\toff\n"]) {
        assert.equal(disabledBy({ COPILOT_TURN_COST: value }), true, JSON.stringify(value));
    }
});

test("disabledBy is false for other values and for an unset variable", () => {
    for (const env of [{}, { COPILOT_TURN_COST: undefined }, { COPILOT_TURN_COST: "" }, { COPILOT_TURN_COST: "on" }, { COPILOT_TURN_COST: "0" }, { COPILOT_TURN_COST: "offx" }, { COPILOT_TURN_COST: "of f" }]) {
        assert.equal(disabledBy(env), false, JSON.stringify(env));
    }
});
