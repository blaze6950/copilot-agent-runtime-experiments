// Metric configuration of the turn-cost extension: strict validation of config.json `metrics` (AC-7).
// Pure except metricConfigFrom, which takes an injected reader; the runtime read is wired in T5.
import { DEFAULT_METRICS, METRICS } from "./contracts.mjs";

/** Prefix of every config warning line; the reporter adds it when it logs the problems. */
export const CONFIG_WARNING_PREFIX = "turn-cost config: ";

/** Environment variable of the kill switch: `<ENV_NAME>=off` switches the extension off (same pattern as COPILOT_CACHE_KEEPER). */
export const ENV_NAME = "COPILOT_TURN_COST";
const DISABLED_VALUE = "off";

/**
 * True when the environment switches the extension off: the value, trimmed and lower-cased, is `off` (so `OFF` and ` off ` count).
 * Any other value, or no variable, keeps it on. Lower-casing follows cache-keeper's rule; the trim goes beyond it.
 * @param {Record<string, string | undefined>} [env] process environment
 * @returns {boolean}
 */
export function disabledBy(env = {}) {
    return String(env[ENV_NAME] ?? "").trim().toLowerCase() === DISABLED_VALUE;
}

const TOP_LEVEL_KEYS = ["metrics"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Read and parse the user config with the given reader; config.mjs does no file access itself. A missing file (ENOENT) is normal.
 * Copied from extensions/cache-keeper/lib/config.mjs (readUserConfig), same behaviour.
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

/**
 * Validate the parsed config. A bad value falls back to its default, or is dropped, with one problem line each; missing keys keep their default silently.
 * Pure: the input is not changed.
 * @param {object} [user] parsed config.json
 * @returns {{metrics: import("./contracts.mjs").MetricConfig, problems: string[]}}
 */
export function normalizeMetrics(user = {}) {
    const problems = [];
    for (const key of Object.keys(user)) {
        if (!TOP_LEVEL_KEYS.includes(key)) problems.push(`unknown key "${key}" ignored`);
    }
    const metrics = { ...DEFAULT_METRICS };
    const raw = user.metrics;
    if (raw === undefined) return { metrics, problems };
    if (!isPlainObject(raw)) {
        problems.push("metrics must be an object; using the defaults");
        return { metrics, problems };
    }
    for (const [key, value] of Object.entries(raw)) {
        if (key === "agent") {
            problems.push("metrics.agent is always on; ignored");
        } else if (!METRICS.includes(key)) {
            problems.push(`metrics: unknown key "${key}" ignored`);
        } else if (typeof value !== "boolean") {
            problems.push(`metrics.${key} must be true or false; using ${DEFAULT_METRICS[key]}`);
        } else {
            metrics[key] = value;
        }
    }
    return { metrics, problems };
}

/**
 * Metric config read at runtime: the file is read on every call. A missing file gives the defaults silently; a file that
 * cannot be read or parsed gives the defaults and one problem line before the validation problems.
 * @param {(path: string) => string} readText
 * @param {string} path
 * @returns {{metrics: import("./contracts.mjs").MetricConfig, problems: string[]}}
 */
export function metricConfigFrom(readText, path) {
    const { user, error } = readUserConfig(readText, path);
    const { metrics, problems } = normalizeMetrics(user);
    const readProblems = error ? [`${path} cannot be read: ${error}; using the defaults`] : [];
    return { metrics, problems: [...readProblems, ...problems] };
}
