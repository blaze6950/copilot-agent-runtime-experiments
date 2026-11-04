// Configuration of the cache-keeper: defaults, merging with config.json and the real clock.

/** Base name of the environment variables that control the keeper: <ENV_NAME>=off disables it, <ENV_NAME>_CONFIG=<path> names the config file. */
export const ENV_NAME = "COPILOT_CACHE_KEEPER";

/** Path of the user config: <ENV_NAME>_CONFIG when set and not empty, else the given default (rule shared by extension.mjs and statusline.mjs). */
export const configPathFrom = (env, defaultPath) => env[`${ENV_NAME}_CONFIG`] || defaultPath;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Read and parse the user config with the given reader; config.mjs does no file access itself. A missing file (ENOENT) is normal.
 * @param {(path: string) => string} readText
 * @param {string} path
 * @returns {{user: object, error: string|null}} `error` for a file that cannot be read or parsed, null otherwise
 */
export function readUserConfig(readText, path) {
    let text;
    try {
        text = readText(path);
    } catch (e) {
        return { user: {}, error: e?.code === "ENOENT" ? null : String(e?.message ?? e) };
    }
    try {
        const parsed = JSON.parse(text);
        return { user: isPlainObject(parsed) ? parsed : {}, error: null };
    } catch (e) {
        return { user: {}, error: String(e?.message ?? e) };
    }
}

/** Defaults; config.json overrides them key by key (sections are merged one level deep). */
export const DEFAULTS = {
    enabled: true,
    marginSec: 30,
    fallbackTtlSec: 300,
    keepaliveText: "[keepalive] Automatic prompt-cache keep-alive from the cache-keeper extension. Reply with exactly: ok. Use no tools.",
    // Raw ladder as written in config.json; normalizeLadder turns it into the shape the keeper reads.
    ladder: {
        keepalives: 10,
        actions: [
            { id: "save", command: "/save", when: { changedSinceLastRun: true, agents: ["1main"] }, ifRemoved: "retry" },
            { id: "compact", command: "/compact", when: { minContextTokens: 150000 }, ifRemoved: "skip" },
        ],
    },
    // Status-line options; read by statusline.mjs on every refresh, not by the keeper.
    statusLine: { countdown: false },
    rescue: { enabled: true, marginSec: 45 },
    wait: { enabled: true, maxRefreshes: 50 },
    miss: { writeRatio: 0.5, minContextTokens: 20000 },
};
const SECTIONS = ["ladder", "statusLine", "rescue", "wait", "miss"];
/** Keys of the config before B1 (hard-coded save and compact); ignored and reported once. */
const LEGACY_KEYS = ["maxRefreshes", "save", "compact"];
const LADDER_KEYS = ["keepalives", "actions"];
const STATUS_LINE_KEYS = ["countdown"];
const ACTION_KEYS = ["id", "command", "text", "when", "ifRemoved"];
const WHEN_KEYS = ["changedSinceLastRun", "agents", "minContextTokens"];
const ACTION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Merge user settings over DEFAULTS; the environment variable `<envName>=off` disables the keeper (trimmed and case-insensitive: `OFF` and ` off ` count).
 * `cfg.problems` lists every config line that was ignored or replaced by a default (empty when all is valid).
 * @param {object} [user] parsed config.json
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [envName]
 * @returns {import("./contracts.mjs").KeeperConfig}
 */
export function mergeConfig(user = {}, env = {}, envName = ENV_NAME) {
    const cfg = { ...DEFAULTS, ...user };
    const legacy = LEGACY_KEYS.filter((k) => user != null && Object.hasOwn(user, k));
    for (const k of LEGACY_KEYS) delete cfg[k];
    const sectionProblems = [];
    for (const k of SECTIONS) {
        const section = user?.[k];
        if (section !== undefined && !isPlainObject(section)) {
            sectionProblems.push(`${k} must be an object; using the defaults`);
            cfg[k] = { ...DEFAULTS[k] };
        } else {
            cfg[k] = { ...DEFAULTS[k], ...section };
        }
    }
    const { ladder, problems } = normalizeLadder(cfg.ladder);
    cfg.ladder = ladder;
    const { statusLine, problems: statusLineProblems } = normalizeStatusLine(cfg.statusLine);
    cfg.statusLine = statusLine;
    const legacyProblems = legacy.length ? [`ignored old keys ${legacy.join(", ")}: use ladder.keepalives and ladder.actions`] : [];
    cfg.problems = [...legacyProblems, ...sectionProblems, ...problems, ...statusLineProblems];
    if (String(env[envName] ?? "").trim().toLowerCase() === "off") cfg.enabled = false;
    return cfg;
}

/**
 * Validate the merged ladder section. A bad value falls back to its default or is dropped, with one problem line each.
 * Pure: the input is not changed.
 * @param {object} raw merged ladder section
 * @returns {{ladder: {keepalives: number, actions: import("./contracts.mjs").LadderAction[]}, problems: string[]}}
 */
export function normalizeLadder(raw) {
    const problems = [];
    for (const key of Object.keys(raw)) {
        if (!LADDER_KEYS.includes(key)) problems.push(`ladder: unknown key "${key}" ignored`);
    }
    let keepalives = raw.keepalives;
    if (!(Number.isInteger(keepalives) && keepalives >= 0)) {
        problems.push(`ladder.keepalives must be a whole number >= 0; using ${DEFAULTS.ladder.keepalives}`);
        keepalives = DEFAULTS.ladder.keepalives;
    }
    let rawActions = raw.actions;
    if (!Array.isArray(rawActions)) {
        problems.push("ladder.actions must be a list; using the default list");
        rawActions = DEFAULTS.ladder.actions;
    }
    const actions = [];
    const seenIds = new Set();
    rawActions.forEach((rawAction, index) => {
        const result = normalizeAction(rawAction, index, seenIds);
        if (result.action) actions.push(result.action);
        problems.push(...result.problems);
    });
    return { ladder: { keepalives, actions }, problems };
}

/**
 * Validate the merged statusLine section. A bad countdown falls back to false, with one problem line; unknown keys are reported and ignored.
 * Pure: the input is not changed.
 * @param {object} raw merged statusLine section
 * @returns {{statusLine: {countdown: boolean}, problems: string[]}}
 */
export function normalizeStatusLine(raw) {
    const problems = [];
    for (const key of Object.keys(raw)) {
        if (!STATUS_LINE_KEYS.includes(key)) problems.push(`statusLine: unknown key "${key}" ignored`);
    }
    let countdown = raw.countdown;
    if (typeof countdown !== "boolean") {
        problems.push("statusLine.countdown must be true or false; using false");
        countdown = DEFAULTS.statusLine.countdown;
    }
    return { statusLine: { countdown }, problems };
}

/**
 * Validate one action. The first failing rule drops the action; a kept action may still carry unknown-key problems.
 * @param {unknown} raw one entry of ladder.actions
 * @param {number} index position in ladder.actions, used in problem lines
 * @param {Set<string>} seenIds ids of the valid actions read so far (added only when the action is kept)
 * @returns {{action: object|null, problems: string[]}}
 */
function normalizeAction(raw, index, seenIds) {
    const where = `ladder.actions[${index}]`;
    const rejected = (problem) => ({ action: null, problems: [problem] });
    if (!isPlainObject(raw)) return rejected(`${where}: not an object, ignored`);
    if (typeof raw.id !== "string" || !ACTION_ID.test(raw.id)) return rejected(`${where}: "id" must match [A-Za-z0-9_-]+, ignored`);
    const who = `${where} (${raw.id})`;
    if (seenIds.has(raw.id)) return rejected(`${who}: duplicate id, ignored`);
    const hasCommand = raw.command !== undefined;
    const hasText = raw.text !== undefined;
    const commandOk = typeof raw.command === "string" && raw.command.trim().startsWith("/") && raw.command.trim().length > 1;
    const textOk = typeof raw.text === "string" && raw.text.trim() !== "";
    if (hasCommand === hasText || (hasCommand ? !commandOk : !textOk)) {
        return rejected(`${who}: needs exactly one of "command" (starting with "/") or "text", ignored`);
    }
    if (raw.when !== undefined && !isPlainObject(raw.when)) return rejected(`${who}: "when" must be an object, ignored`);
    const when = raw.when ?? {};
    if (when.changedSinceLastRun !== undefined && typeof when.changedSinceLastRun !== "boolean") {
        return rejected(`${who}: "when.changedSinceLastRun" must be true or false, ignored`);
    }
    const agentsOk = Array.isArray(when.agents) && when.agents.length > 0 && when.agents.every((a) => typeof a === "string" && a.trim() !== "");
    if (when.agents !== undefined && !agentsOk) return rejected(`${who}: "when.agents" must be a non-empty list of names, ignored`);
    if (when.minContextTokens !== undefined && !(Number.isFinite(when.minContextTokens) && when.minContextTokens >= 0)) {
        return rejected(`${who}: "when.minContextTokens" must be a number >= 0, ignored`);
    }
    if (raw.ifRemoved !== undefined && raw.ifRemoved !== "retry" && raw.ifRemoved !== "skip") {
        return rejected(`${who}: "ifRemoved" must be "retry" or "skip", ignored`);
    }
    const problems = [
        ...Object.keys(raw).filter((k) => !ACTION_KEYS.includes(k)).map((k) => `${who}: unknown key "${k}" ignored`),
        ...Object.keys(when).filter((k) => !WHEN_KEYS.includes(k)).map((k) => `${who}: unknown key "when.${k}" ignored`),
    ];
    seenIds.add(raw.id);
    const action = {
        id: raw.id,
        kind: hasCommand ? "command" : "text",
        text: (hasCommand ? raw.command : raw.text).trim(),
        when: {
            changedSinceLastRun: when.changedSinceLastRun ?? false,
            agents: when.agents !== undefined ? [...when.agents] : null,
            minContextTokens: when.minContextTokens ?? 0,
        },
        ifRemoved: raw.ifRemoved ?? "skip",
    };
    return { action, problems };
}

/** Real clock; tests inject a fake with the same shape. */
export const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
