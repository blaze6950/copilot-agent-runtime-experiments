import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as config from "../lib/config.mjs";
import { COMPACT_ACTION, SAVE_ACTION, ladderCfg } from "./helpers/ladder-fixtures.mjs";

const { mergeConfig, DEFAULTS } = config;
// Called through the namespace so that a missing export fails only the tests that need it.
const normalizeLadder = (raw) => config.normalizeLadder(raw);

const DEFAULT_WHEN = { changedSinceLastRun: false, agents: null, minContextTokens: 0 };
const DEFAULT_SAVE = {
    id: "save", kind: "command", text: "/save",
    when: { changedSinceLastRun: true, agents: ["1main"], minContextTokens: 0 },
    ifRemoved: "retry",
};
const DEFAULT_COMPACT = {
    id: "compact", kind: "command", text: "/compact",
    when: { changedSinceLastRun: false, agents: null, minContextTokens: 150000 },
    ifRemoved: "skip",
};
const NEEDS_ONE_OF = (who) => `${who}: needs exactly one of "command" (starting with "/") or "text", ignored`;

test("B1 AC-8: the default ladder is 10 keep-alives, then save and compact", () => {
    const cfg = mergeConfig({});
    assert.deepEqual(cfg.ladder, { keepalives: 10, actions: [DEFAULT_SAVE, DEFAULT_COMPACT] });
    assert.deepEqual(cfg.problems, []);
});

test("B1 AC-8: a user ladder overrides keepalives and actions key by key", () => {
    const fewer = mergeConfig({ ladder: { keepalives: 3 } });
    assert.equal(fewer.ladder.keepalives, 3);
    assert.deepEqual(fewer.ladder.actions, [DEFAULT_SAVE, DEFAULT_COMPACT]);
    assert.deepEqual(fewer.problems, []);

    const none = mergeConfig({ ladder: { actions: [] } });
    assert.equal(none.ladder.keepalives, 10);
    assert.deepEqual(none.ladder.actions, []);
    assert.deepEqual(none.problems, []);

    const custom = ladderCfg(4, [SAVE_ACTION]);
    assert.deepEqual(custom.ladder, { keepalives: 4, actions: [DEFAULT_SAVE] });
    assert.deepEqual(custom.problems, []);
    assert.deepEqual(ladderCfg(10, [COMPACT_ACTION]).ladder.actions, [DEFAULT_COMPACT]);
});

test("B1 AC-8: command and text actions are normalized", () => {
    const cfg = mergeConfig({
        ladder: {
            actions: [
                { id: "note", text: "  Summarise.  " },
                { id: "c", command: " /compact keep plan " },
            ],
        },
    });
    assert.deepEqual(cfg.ladder.actions, [
        { id: "note", kind: "text", text: "Summarise.", when: DEFAULT_WHEN, ifRemoved: "skip" },
        { id: "c", kind: "command", text: "/compact keep plan", when: DEFAULT_WHEN, ifRemoved: "skip" },
    ]);
    assert.deepEqual(cfg.problems, []);
});

const INVALID_ACTIONS = [
    { name: "not an object", input: "save", problem: "ladder.actions[0]: not an object, ignored" },
    { name: "id with a space", input: { id: "a b", command: "/x" }, problem: 'ladder.actions[0]: "id" must match [A-Za-z0-9_-]+, ignored' },
    { name: "id missing", input: { command: "/x" }, problem: 'ladder.actions[0]: "id" must match [A-Za-z0-9_-]+, ignored' },
    { name: "neither command nor text", input: { id: "a" }, problem: NEEDS_ONE_OF("ladder.actions[0] (a)") },
    { name: "both command and text", input: { id: "a", command: "/x", text: "y" }, problem: NEEDS_ONE_OF("ladder.actions[0] (a)") },
    { name: "command without a slash", input: { id: "a", command: "save" }, problem: NEEDS_ONE_OF("ladder.actions[0] (a)") },
    { name: "command that is only a slash", input: { id: "a", command: "/" }, problem: NEEDS_ONE_OF("ladder.actions[0] (a)") },
    { name: "blank text", input: { id: "a", text: "   " }, problem: NEEDS_ONE_OF("ladder.actions[0] (a)") },
    { name: "when is not an object", input: { id: "a", command: "/x", when: "yes" }, problem: 'ladder.actions[0] (a): "when" must be an object, ignored' },
    { name: "changedSinceLastRun is not a boolean", input: { id: "a", command: "/x", when: { changedSinceLastRun: "yes" } }, problem: 'ladder.actions[0] (a): "when.changedSinceLastRun" must be true or false, ignored' },
    { name: "agents is an empty list", input: { id: "a", command: "/x", when: { agents: [] } }, problem: 'ladder.actions[0] (a): "when.agents" must be a non-empty list of names, ignored' },
    { name: "agents is not a list", input: { id: "a", command: "/x", when: { agents: "1main" } }, problem: 'ladder.actions[0] (a): "when.agents" must be a non-empty list of names, ignored' },
    { name: "agents holds a non-string", input: { id: "a", command: "/x", when: { agents: [1] } }, problem: 'ladder.actions[0] (a): "when.agents" must be a non-empty list of names, ignored' },
    { name: "minContextTokens is negative", input: { id: "a", command: "/x", when: { minContextTokens: -1 } }, problem: 'ladder.actions[0] (a): "when.minContextTokens" must be a number >= 0, ignored' },
    { name: "ifRemoved is unknown", input: { id: "a", command: "/x", ifRemoved: "maybe" }, problem: 'ladder.actions[0] (a): "ifRemoved" must be "retry" or "skip", ignored' },
];

for (const row of INVALID_ACTIONS) {
    test(`B1 AC-8: an invalid action is dropped with one problem: ${row.name}`, () => {
        const cfg = mergeConfig({ ladder: { actions: [row.input] } });
        assert.deepEqual(cfg.ladder.actions, []);
        assert.deepEqual(cfg.problems, [row.problem]);
    });
}

test("B1 AC-8: a duplicate id keeps the first action and reports the second", () => {
    const cfg = mergeConfig({
        ladder: { actions: [{ id: "s", command: "/save" }, { id: "s", command: "/compact" }] },
    });
    assert.deepEqual(cfg.ladder.actions, [{ id: "s", kind: "command", text: "/save", when: DEFAULT_WHEN, ifRemoved: "skip" }]);
    assert.deepEqual(cfg.problems, ["ladder.actions[1] (s): duplicate id, ignored"]);
});

test("B1 AC-13: an invalid action does not reserve its id: a later valid action with the same id is kept", () => {
    const cfg = normalizeLadder({ keepalives: 0, actions: [{ id: "s" }, { id: "s", command: "/save" }] });
    assert.deepEqual(cfg.ladder.actions, [{ id: "s", kind: "command", text: "/save", when: DEFAULT_WHEN, ifRemoved: "skip" }]);
    assert.deepEqual(cfg.problems, ['ladder.actions[0] (s): needs exactly one of "command" (starting with "/") or "text", ignored']);
});

test("B1 AC-13: an agent name that is empty after trimming is rejected with a problem", () => {
    const cfg = normalizeLadder({ keepalives: 0, actions: [{ id: "s", command: "/save", when: { agents: ["1main", "  "] } }] });
    assert.deepEqual(cfg.ladder.actions, []);
    assert.deepEqual(cfg.problems, ['ladder.actions[0] (s): "when.agents" must be a non-empty list of names, ignored']);
});

test("B1 AC-8: unknown keys are reported and the action is kept", () => {
    const misspelt = mergeConfig({ ladder: { actions: [{ id: "s", command: "/save", ifremoved: "retry" }] } });
    assert.equal(misspelt.ladder.actions.length, 1);
    assert.equal(misspelt.ladder.actions[0].ifRemoved, "skip");
    assert.deepEqual(misspelt.problems, ['ladder.actions[0] (s): unknown key "ifremoved" ignored']);

    const unknownWhen = mergeConfig({ ladder: { actions: [{ id: "w", command: "/x", when: { foo: 1 } }] } });
    assert.equal(unknownWhen.ladder.actions.length, 1);
    assert.deepEqual(unknownWhen.problems, ['ladder.actions[0] (w): unknown key "when.foo" ignored']);

    const unknownLadder = mergeConfig({ ladder: { foo: 1 } });
    assert.equal(unknownLadder.ladder.keepalives, 10);
    assert.deepEqual(unknownLadder.ladder.actions, [DEFAULT_SAVE, DEFAULT_COMPACT]);
    assert.deepEqual(unknownLadder.problems, ['ladder: unknown key "foo" ignored']);
});

test("B1 AC-8: invalid keepalives fall back to 10 with a problem", () => {
    for (const bad of [-1, 2.5, "3"]) {
        const cfg = mergeConfig({ ladder: { keepalives: bad } });
        assert.equal(cfg.ladder.keepalives, 10, `keepalives ${JSON.stringify(bad)}`);
        assert.deepEqual(cfg.problems, ["ladder.keepalives must be a whole number >= 0; using 10"], `keepalives ${JSON.stringify(bad)}`);
    }
});

test("B1 AC-8: actions that are not a list fall back to the default list with a problem", () => {
    const cfg = mergeConfig({ ladder: { actions: "save" } });
    assert.equal(cfg.ladder.keepalives, 10);
    assert.deepEqual(cfg.ladder.actions, [DEFAULT_SAVE, DEFAULT_COMPACT]);
    assert.deepEqual(cfg.problems, ["ladder.actions must be a list; using the default list"]);
});

test("B1 AC-8: a section that is not an object falls back to its defaults with a problem", () => {
    const ladderRows = [5, [], null];
    for (const bad of ladderRows) {
        const cfg = mergeConfig({ ladder: bad });
        assert.deepEqual(cfg.ladder, { keepalives: 10, actions: [DEFAULT_SAVE, DEFAULT_COMPACT] }, `ladder ${JSON.stringify(bad)}`);
        assert.deepEqual(cfg.problems, ["ladder must be an object; using the defaults"], `ladder ${JSON.stringify(bad)}`);
    }
    const rescue = mergeConfig({ rescue: "on" });
    assert.deepEqual(rescue.rescue, DEFAULTS.rescue);
    assert.deepEqual(rescue.problems, ["rescue must be an object; using the defaults"]);
});

test("B1 AC-8: old keys maxRefreshes, save and compact are ignored with one problem", () => {
    const cfg = mergeConfig({ maxRefreshes: 5, save: { enabled: false }, compact: {} });
    for (const key of ["maxRefreshes", "save", "compact"]) assert.ok(!Object.hasOwn(cfg, key), `${key} must be gone`);
    assert.deepEqual(cfg.ladder, { keepalives: 10, actions: [DEFAULT_SAVE, DEFAULT_COMPACT] });
    assert.deepEqual(cfg.problems, ["ignored old keys maxRefreshes, save, compact: use ladder.keepalives and ladder.actions"]);
});

test("B1 AC-8: the shipped config.json loads without problems and equals the default ladder", () => {
    const shipped = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
    const cfg = mergeConfig(shipped);
    assert.deepEqual(cfg.problems, []);
    assert.deepEqual(cfg.ladder, mergeConfig({}).ladder);
});

test("B1 AC-7: keepaliveText is unchanged", () => {
    assert.equal(mergeConfig({}).keepaliveText, "[keepalive] Automatic prompt-cache keep-alive from the cache-keeper extension. Reply with exactly: ok. Use no tools.");
});

test("B1 AC-8: normalizeLadder does not change its input", () => {
    const raw = {
        keepalives: 3,
        actions: [
            { id: "s", command: "/save", ifremoved: "retry", when: { agents: ["1main"], foo: 1 } },
            { id: "bad" },
        ],
    };
    const before = structuredClone(raw);
    normalizeLadder(raw);
    assert.deepEqual(raw, before);
});

const COUNTDOWN_PROBLEM = "statusLine.countdown must be true or false; using false";

test("B1 AC-12: statusLine.countdown defaults to false", () => {
    const cfg = mergeConfig({});
    assert.deepEqual(cfg.statusLine, { countdown: false });
    assert.deepEqual(cfg.problems, []);
});

test("B1 AC-12: statusLine.countdown true is kept", () => {
    const cfg = mergeConfig({ statusLine: { countdown: true } });
    assert.deepEqual(cfg.statusLine, { countdown: true });
    assert.deepEqual(cfg.problems, []);
});

for (const bad of ["yes", 1, null]) {
    test(`B1 AC-12: an invalid statusLine.countdown falls back to false with one problem: ${JSON.stringify(bad)}`, () => {
        const cfg = mergeConfig({ statusLine: { countdown: bad } });
        assert.deepEqual(cfg.statusLine, { countdown: false });
        assert.deepEqual(cfg.problems, [COUNTDOWN_PROBLEM]);
    });
}

test("B1 AC-12: a statusLine that is not an object falls back to the defaults with a problem", () => {
    const cfg = mergeConfig({ statusLine: true });
    assert.deepEqual(cfg.statusLine, { countdown: false });
    assert.deepEqual(cfg.problems, ["statusLine must be an object; using the defaults"]);
});

test("B1 AC-12: unknown statusLine keys are reported and the value is kept", () => {
    const cfg = mergeConfig({ statusLine: { countdown: true, refreshInterval: 1 } });
    assert.equal(cfg.statusLine.countdown, true);
    assert.deepEqual(cfg.problems, ['statusLine: unknown key "refreshInterval" ignored']);
});

test("B1 AC-12: the shipped config.json sets statusLine.countdown false", (t) => {
    // Reads the committed file, so an uncommitted local change to config.json does not affect the result.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const gitOptions = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    let inCheckout = false;
    try {
        inCheckout = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], gitOptions).trim() === "true";
    } catch {
        inCheckout = false;
    }
    if (!inCheckout) {
        t.skip("git is unavailable or this folder is not a git checkout; the committed config.json cannot be read");
        return;
    }
    const committed = execFileSync("git", ["show", "HEAD:./extensions/cache-keeper/config.json"], gitOptions);
    assert.deepEqual(JSON.parse(committed).statusLine, { countdown: false });
});

for (const value of ["off", "OFF", " off ", "\toff\n"]) {
    test(`AC-16: COPILOT_CACHE_KEEPER=${JSON.stringify(value)} disables the keeper`, () => {
        assert.equal(mergeConfig({}, { COPILOT_CACHE_KEEPER: value }).enabled, false);
    });
}

for (const env of [{}, { COPILOT_CACHE_KEEPER: undefined }, { COPILOT_CACHE_KEEPER: "" }, { COPILOT_CACHE_KEEPER: "on" }, { COPILOT_CACHE_KEEPER: "0" }, { COPILOT_CACHE_KEEPER: "offx" }, { COPILOT_CACHE_KEEPER: "of f" }]) {
    test(`AC-16: ${JSON.stringify(env)} keeps the keeper enabled`, () => {
        assert.equal(mergeConfig({}, env).enabled, true);
    });
}

test("B1: configPathFrom uses COPILOT_CACHE_KEEPER_CONFIG when set", () => {
    assert.equal(config.configPathFrom({ COPILOT_CACHE_KEEPER_CONFIG: "X" }, "D"), "X");
    assert.equal(config.configPathFrom({}, "D"), "D");
    assert.equal(config.configPathFrom({ COPILOT_CACHE_KEEPER_CONFIG: "" }, "D"), "D");
});

// Called through the namespace so that a missing export fails only the tests that need it.
const readUserConfig = (readText, path) => config.readUserConfig(readText, path);
const CONFIG_FILE = "C:/cache-keeper/config.json";

test("B1 AC-14: readUserConfig returns the parsed object and no error", () => {
    const result = readUserConfig(() => '{"statusLine":{"countdown":true}}', CONFIG_FILE);
    assert.deepEqual(result, { user: { statusLine: { countdown: true } }, error: null });
});

test("B1 AC-14: a missing config (ENOENT) gives an empty config and no error", () => {
    const readText = () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    assert.deepEqual(readUserConfig(readText, CONFIG_FILE), { user: {}, error: null });
});

test("B1 AC-14: a read error gives an empty config and its message", () => {
    const readText = () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const result = readUserConfig(readText, CONFIG_FILE);
    assert.deepEqual(result.user, {});
    assert.match(result.error, /denied/);
});

test("B1 AC-14: invalid JSON gives an empty config and the parse message", () => {
    const result = readUserConfig(() => "{not json", CONFIG_FILE);
    assert.deepEqual(result.user, {});
    assert.equal(typeof result.error, "string");
    assert.notEqual(result.error, "");
});

test("B1 AC-14: valid JSON that is not an object gives an empty config and no error", () => {
    for (const text of ["[1]", "5", "null", '"x"']) {
        assert.deepEqual(readUserConfig(() => text, CONFIG_FILE), { user: {}, error: null }, `text ${text}`);
    }
});
