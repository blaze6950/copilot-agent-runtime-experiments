import { test } from "node:test";
import assert from "node:assert/strict";
import { render, colorEnabled, FLASH_MS, clockTime, remainingTime } from "../lib/statusline-render.mjs";
import * as statusline from "../statusline.mjs";
import { join } from "node:path";
import { T0 } from "./helpers/fakes.mjs";

const NOW = T0 + 600_000;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const stripSgr = (s) => s.replace(/\x1b\[\d+m/g, "");
// Live state: cache until CACHE, next keepalive at NEXT (2/12). Override fields per case.
const CACHE = clockTime(NOW + 252_000);
const NEXT = clockTime(NOW + 222_000);
const RESCUE = clockTime(NOW + 150_000);
const PRICE = 11_898_860_000;
const PING = 10_000_000_000; // $0.10
const SAVED = 498_717 * (500_000 - 20_000); // cache reads x rate gap (nano-AIU): $2.39
const live = (over = {}) => ({
    idle: true, updatedAt: NOW, expiresAt: NOW + 252_000, provisional: false, nextAt: NOW + 222_000, nextAction: "keepalive", nextLabel: "keepalive",
    step: 2, steps: 12, ladderDone: false, rescueAt: null, busyTools: [], keepalives: 1,
    waitRefreshes: 2, maxWaitRefreshes: 50, contextTokens: 90_000, lastRefreshAt: null, lastRefreshKind: null, lastRefreshNanoAiu: null, stats: {}, ...over,
});

const PLAIN = [
    ["keepalive clock time", live(), `main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`],
    ["provisional expiry shows (refreshing)", live({ provisional: true }), `main cache until ${CACHE} (refreshing) | next keepalive ${NEXT} (2/12)`],
    ["wait mode counts wait refreshes", live({ nextAction: "wait" }), `main cache until ${CACHE} | next keepalive ${NEXT} (wait 3/50)`],
    ["next action shows its label and step", live({ nextAction: "action", nextLabel: "/save", step: 11 }), `main cache until ${CACHE} | next /save ${NEXT} (11/12)`],
    ["ladder done while idle", live({ nextAction: null, nextAt: null, ladderDone: true }), `main cache until ${CACHE} | ladder done, waiting for you`],
    ["ladder done during wait mode shows only the wait step", live({ nextAction: "wait", ladderDone: true }), `main cache until ${CACHE} | next keepalive ${NEXT} (wait 3/50)`],
    ["busy turn shows the rescue time", live({ idle: false, nextAction: null, nextAt: null, rescueAt: NOW + 150_000, busyTools: ["powershell", "task"] }), `main cache until ${CACHE} | busy in powershell,task, rescue ${RESCUE}`],
    ["expired cache", live({ expiresAt: NOW - 1000 }), `!! main cache expired !! | next keepalive ${NEXT} (2/12)`],
    ["expired cache with nothing else", live({ expiresAt: NOW - 1, nextAt: null, nextAction: null }), "!! main cache expired !!"],
    ["no cache expiry still starts with main", live({ expiresAt: null }), `main next keepalive ${NEXT} (2/12)`],
    ["nothing to show", live({ expiresAt: null, nextAt: null, nextAction: null }), ""],
    ["old state file without B1 fields", { idle: true, updatedAt: NOW, expiresAt: NOW + 252_000, provisional: false, nextAt: NOW + 222_000, nextAction: "save", refreshes: 0, maxRefreshes: 10, compacted: false, busyTools: [] }, `main cache until ${CACHE} | next save ${NEXT}`],
    ["B1 AC-6: keep-alive price within FLASH_MS", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PRICE, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 $0.12`],
    ["B1 AC-6: wait keep-alive price", live({ nextAction: "wait", lastRefreshAt: NOW - 1_000, lastRefreshKind: "wait", lastRefreshNanoAiu: PRICE }), `main cache until ${CACHE} | next keepalive ${NEXT} (wait 3/50) | wait keepalive #2 $0.12`],
    ["B1 AC-6: no price without a cost field", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: null, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12)`],
    ["B1 AC-6: no price for an action refresh", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "action", lastRefreshNanoAiu: PRICE, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12)`],
    ["B1 AC-6: no price after FLASH_MS", live({ lastRefreshAt: NOW - 6_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PRICE, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12)`],
    ["B3 AC-13: keep-alive shows the saving and the ping cost", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PING, lastRefreshSavedNanoAiu: SAVED, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 saved $2.39 ($0.10)`],
    ["B3 AC-13: wait keep-alive shows the saving and the ping cost", live({ nextAction: "wait", lastRefreshAt: NOW - 1_000, lastRefreshKind: "wait", lastRefreshNanoAiu: PING, lastRefreshSavedNanoAiu: SAVED }), `main cache until ${CACHE} | next keepalive ${NEXT} (wait 3/50) | wait keepalive #2 saved $2.39 ($0.10)`],
    ["B3 AC-13: no saving shows the ping cost only", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PING, lastRefreshSavedNanoAiu: null, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 $0.10`],
    ["B3 AC-13: a cache miss shows the ping cost and no saving", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PING, lastRefreshSavedNanoAiu: null, lastRefreshMiss: true, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 $0.10`],
    ["B3 AC-13: a saving without a ping cost shows no price", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: null, lastRefreshSavedNanoAiu: SAVED, keepalives: 3, step: 4 }), `main cache until ${CACHE} | next keepalive ${NEXT} (4/12)`],
    ["B1 AC-16: wait cap reached", live({ nextAction: null, nextAt: null, waitEnd: "cap" }), `main cache until ${CACHE} | wait budget used, no more keep-alives`],
    ["B1 AC-16: wait disabled", live({ nextAction: null, nextAt: null, waitEnd: "off" }), `main cache until ${CACHE} | wait keep-alives off, no more keep-alives`],
    ["B1 AC-16: waitEnd is not shown while a next step is planned", live({ waitEnd: "cap" }), `main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`],
    ["B1 AC-16: an unknown waitEnd value shows nothing", live({ nextAction: null, nextAt: null, waitEnd: "x" }), `main cache until ${CACHE}`],
];

const COLOURED = [
    ["recent keepalive flashes the whole line green", live({ lastRefreshAt: NOW - 5_999, lastRefreshKind: "keepalive" }), GREEN(`main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`)],
    ["recent wait refresh flashes green", live({ nextAction: "wait", lastRefreshAt: NOW - 1, lastRefreshKind: "wait" }), GREEN(`main cache until ${CACHE} | next keepalive ${NEXT} (wait 3/50)`)],
    ["green phase includes the keep-alive price", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PRICE, keepalives: 3, step: 4 }), GREEN(`main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 $0.12`)],
    ["B3 AC-13: green phase includes the saving and the ping cost", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PING, lastRefreshSavedNanoAiu: SAVED, keepalives: 3, step: 4 }), GREEN(`main cache until ${CACHE} | next keepalive ${NEXT} (4/12) | keepalive #3 saved $2.39 ($0.10)`)],
    ["flash ends at exactly 6000 ms", live({ lastRefreshAt: NOW - 6_000, lastRefreshKind: "keepalive" }), `main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`],
    ["old refresh has no escapes", live({ lastRefreshAt: NOW - 60_000, lastRefreshKind: "keepalive" }), `main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`],
    ["provisional without a refresh has no escapes", live({ provisional: true }), `main cache until ${CACHE} (refreshing) | next keepalive ${NEXT} (2/12)`],
    ["expired is red", live({ expiresAt: NOW - 1000 }), RED(`!! main cache expired !! | next keepalive ${NEXT} (2/12)`)],
    ["expired is red even during a flash", live({ expiresAt: NOW - 1000, lastRefreshAt: NOW - 1000, lastRefreshKind: "keepalive" }), RED(`!! main cache expired !! | next keepalive ${NEXT} (2/12)`)],
];

test("B1 AC-5: a provisional expiry shows the clock time with (refreshing)", () => {
    const state = { updatedAt: T0, expiresAt: T0 + 300_000, provisional: true };
    assert.match(render(state, T0 + 60_000), /^main cache until \d\d:\d\d:\d\d \(refreshing\)/);
});

test("B1 AC-5: clockTime is local HH:MM:SS with leading zeros", () => {
    assert.equal(clockTime(new Date(2026, 9, 23, 7, 5, 9).getTime()), "07:05:09");
    assert.equal(clockTime(new Date(2026, 9, 23, 17, 31, 45, 999).getTime()), "17:31:45");
});

test("render: plain output for every case, with and without colour option off", () => {
    for (const [name, state, expected] of PLAIN) {
        assert.equal(render(state, NOW), expected, name);
        assert.equal(render(state, NOW, { color: false }), expected, `${name} (color: false)`);
    }
});

test("render: every non-empty line starts with 'main ' or '!! main '", () => {
    for (const [name, state] of PLAIN) {
        const line = render(state, NOW, { color: true });
        if (line) assert.match(stripSgr(line), /^(!! )?main /, name);
    }
});

test("render: colour rules (flash green, expired red, red wins)", () => {
    for (const [name, state, expected] of COLOURED) {
        assert.equal(render(state, NOW, { color: true }), expected, name);
    }
});

test("render: color: false prints no escape codes in any case", () => {
    for (const [name, state, expected] of COLOURED) {
        const out = render(state, NOW, { color: false });
        assert.equal(out, stripSgr(expected), name);
        assert.doesNotMatch(out, /\x1b/, name);
    }
});

test("render: no colour option means no escape codes", () => {
    const [, state] = COLOURED[0];
    assert.doesNotMatch(render(state, NOW), /\x1b/);
});

test("render: state older than 24 h renders nothing", () => {
    const day = 24 * 3600 * 1000;
    assert.notEqual(render(live({ updatedAt: NOW - day }), NOW, { color: true }), "", "exactly 24 h is still fresh");
    assert.equal(render(live({ updatedAt: NOW - day - 1 }), NOW, { color: true }), "");
    assert.equal(render(live({ updatedAt: NOW - day - 1, lastRefreshAt: NOW, lastRefreshKind: "keepalive" }), NOW, { color: true }), "");
});

test("render: FLASH_MS is 6000 ms", () => {
    assert.equal(FLASH_MS, 6000);
});

test("colorEnabled: NO_COLOR set to a non-empty value disables colour", () => {
    assert.equal(colorEnabled({ NO_COLOR: "1" }), false);
    assert.equal(colorEnabled({ NO_COLOR: "anything" }), false);
    assert.equal(colorEnabled({ NO_COLOR: "0" }), false);
});

test("colorEnabled: unset or empty NO_COLOR keeps colour on", () => {
    assert.equal(colorEnabled({}), true);
    assert.equal(colorEnabled({ NO_COLOR: "" }), true);
});

// B1 AC-12: optional countdown. Remaining time is shown in brackets after each clock time.
const COUNTDOWN = [
    ["keepalive clock time", live(), `main cache until ${CACHE} (4:12) | next keepalive ${NEXT} (3:42) (2/12)`],
    ["provisional expiry", live({ provisional: true }), `main cache until ${CACHE} (4:12) (refreshing) | next keepalive ${NEXT} (3:42) (2/12)`],
    ["wait mode", live({ nextAction: "wait" }), `main cache until ${CACHE} (4:12) | next keepalive ${NEXT} (3:42) (wait 3/50)`],
    ["busy turn shows the rescue countdown", live({ idle: false, nextAction: null, nextAt: null, rescueAt: NOW + 150_000, busyTools: ["powershell", "task"] }), `main cache until ${CACHE} (4:12) | busy in powershell,task, rescue ${RESCUE} (2:30)`],
    ["expired cache has no countdown", live({ expiresAt: NOW - 1000 }), `!! main cache expired !! | next keepalive ${NEXT} (3:42) (2/12)`],
    ["one hour or more uses h:mm:ss", live({ expiresAt: NOW + 3_661_000 }), `main cache until ${clockTime(NOW + 3_661_000)} (1:01:01) | next keepalive ${NEXT} (3:42) (2/12)`],
    ["B1 AC-6 price row", live({ lastRefreshAt: NOW - 1_000, lastRefreshKind: "keepalive", lastRefreshNanoAiu: PRICE, keepalives: 3, step: 4 }), `main cache until ${CACHE} (4:12) | next keepalive ${NEXT} (3:42) (4/12) | keepalive #3 $0.12`],
];
const COUNTDOWN_LINE = `main cache until ${CACHE} (4:12) | next keepalive ${NEXT} (3:42) (2/12)`;
const STATIC_LINE = `main cache until ${CACHE} | next keepalive ${NEXT} (2/12)`;
const SESSION_STDIN = JSON.stringify({ session_id: "sid1" });
const STATE_PATH = join("S", "sid1.json");
const CONFIG_PATH = "C/config.json";
const NO_COLOR_ENV = { NO_COLOR: "1" };

/** A fake disk: readText throws ENOENT for a path that is not in the map, like fs.readFileSync. */
function fakeDisk(entries) {
    const files = new Map(entries);
    const readText = (path) => {
        if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return files.get(path);
    };
    return { files, readText };
}
const runLineFor = (readText, env = NO_COLOR_ENV, stdin = SESSION_STDIN) =>
    statusline.lineFor(stdin, { readText, env, now: NOW, stateDir: "S", defaultConfigPath: CONFIG_PATH });

test("B1 AC-12: remainingTime is m:ss below one hour and h:mm:ss from one hour", () => {
    const rows = [[0, "0:00"], [999, "0:01"], [252_000, "4:12"], [3_599_000, "59:59"], [3_600_000, "1:00:00"], [3_661_000, "1:01:01"], [-5_000, "0:00"]];
    for (const [ms, expected] of rows) assert.equal(remainingTime(ms), expected, `${ms} ms`);
});

test("B1 AC-12: countdown adds the remaining time after every clock time", () => {
    for (const [name, state, expected] of COUNTDOWN) {
        assert.equal(render(state, NOW, { countdown: true }), expected, name);
    }
});

test("B1 AC-12: without countdown (absent or false) every PLAIN row renders exactly as before", () => {
    for (const [name, state, expected] of PLAIN) {
        assert.equal(render(state, NOW, { countdown: false }), expected, `${name} (countdown: false)`);
        assert.equal(render(state, NOW), expected, `${name} (countdown absent)`);
    }
});

test("B1 AC-12: colour rules are unchanged with countdown", () => {
    const opts = { color: true, countdown: true };
    assert.equal(
        render(live({ lastRefreshAt: NOW - 5_999, lastRefreshKind: "keepalive" }), NOW, opts),
        GREEN(COUNTDOWN_LINE),
    );
    assert.equal(
        render(live({ expiresAt: NOW - 1000 }), NOW, opts),
        RED(`!! main cache expired !! | next keepalive ${NEXT} (3:42) (2/12)`),
    );
});

test("B1 AC-12: lineFor reads the config on every run: switching countdown on applies at the next call", () => {
    const { files, readText } = fakeDisk([[STATE_PATH, JSON.stringify(live())], [CONFIG_PATH, "{}"]]);
    assert.equal(runLineFor(readText), STATIC_LINE);
    files.set(CONFIG_PATH, '{"statusLine":{"countdown":true}}');
    assert.equal(runLineFor(readText), COUNTDOWN_LINE);
});

test("B1 AC-12: a missing, unreadable or invalid config gives the static line", () => {
    const state = JSON.stringify(live());
    const cases = [
        ["missing config", undefined],
        ["unreadable JSON", "{not json"],
        ["countdown is not a boolean", '{"statusLine":{"countdown":"yes"}}'],
        ["countdown false", '{"statusLine":{"countdown":false}}'],
        ["config is a list", "[1]"],
    ];
    for (const [name, configText] of cases) {
        const entries = [[STATE_PATH, state]];
        if (configText !== undefined) entries.push([CONFIG_PATH, configText]);
        assert.equal(runLineFor(fakeDisk(entries).readText), STATIC_LINE, name);
    }
});

test("B1 AC-12: COPILOT_CACHE_KEEPER_CONFIG points the status line to another config file", () => {
    const { readText } = fakeDisk([
        [STATE_PATH, JSON.stringify(live())],
        [CONFIG_PATH, "{}"],
        ["X/alt.json", '{"statusLine":{"countdown":true}}'],
    ]);
    assert.equal(runLineFor(readText, { ...NO_COLOR_ENV, COPILOT_CACHE_KEEPER_CONFIG: "X/alt.json" }), COUNTDOWN_LINE);
});

test("statusline: no session id, a bad session id or no state file prints nothing", () => {
    const { readText } = fakeDisk([[STATE_PATH, JSON.stringify(live())]]);
    assert.equal(runLineFor(readText, NO_COLOR_ENV, ""), "");
    assert.equal(runLineFor(readText, NO_COLOR_ENV, '{"session_id":"../x"}'), "");
    assert.equal(runLineFor(fakeDisk([]).readText), "");
});

