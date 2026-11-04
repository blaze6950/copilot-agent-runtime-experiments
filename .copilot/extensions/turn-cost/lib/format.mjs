// Humanized figures for the turn-cost timeline: counts, durations, costs, percentages and token pairs. Pure.
// Non-finite input renders as "-".

const DASH = "-";

/** Count units from 1000 up. A count whose rounded value reaches 1000 moves to the next unit. */
const COUNT_UNITS = Object.freeze([
    { divisor: 1e3, suffix: "k" },
    { divisor: 1e6, suffix: "M" },
    { divisor: 1e9, suffix: "B" },
]);

/** Renders tenths (for example 12 → "1.2", 10 → "1"). */
function formatTenths(tenths) {
    const whole = Math.floor(tenths / 10);
    const fraction = tenths % 10;
    return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}

/**
 * Counts: 842, 1.2k, 46.6M. One decimal below 100 units, whole units from 100 up.
 * @param {number} count
 * @returns {string}
 */
export function formatCount(count) {
    if (!Number.isFinite(count)) return DASH;
    if (Math.round(count) < 1000) return String(Math.round(count));
    for (const [index, unit] of COUNT_UNITS.entries()) {
        const tenths = Math.round((count * 10) / unit.divisor);
        if (tenths < 1000) return `${formatTenths(tenths)}${unit.suffix}`;
        const whole = Math.round(count / unit.divisor);
        if (whole < 1000 || index === COUNT_UNITS.length - 1) return `${whole}${unit.suffix}`;
    }
    return DASH;
}

/** Two-digit minutes or seconds. */
function pad2(value) {
    return String(value).padStart(2, "0");
}

/**
 * Durations: 9s, 2m14s, 1h03m. Negative values render as 0s.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms)) return DASH;
    const seconds = Math.round(Math.max(0, ms) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad2(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h${pad2(Math.floor((seconds % 3600) / 60))}m`;
}

/**
 * Costs: $0.00, <$0.01, $0.12, $1.2k.
 * @param {number} usd
 * @returns {string}
 */
export function formatCost(usd) {
    if (!Number.isFinite(usd)) return DASH;
    if (usd === 0) return "$0.00";
    const cents = Math.round(usd * 100);
    if (usd > 0 && cents === 0) return "<$0.01";
    if (cents < 100000) return `$${(cents / 100).toFixed(2)}`;
    return `$${formatCount(usd)}`;
}

/**
 * Whole-number percentage: 0%, 93%. Null or non-finite renders as "-".
 * @param {number|null} ratio
 * @returns {string}
 */
export function formatPercent(ratio) {
    if (!Number.isFinite(ratio)) return DASH;
    return `${Math.round(ratio * 100)}%`;
}

/**
 * Tokens in and out as one pair: 46.6M/210k.
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @returns {string}
 */
export function formatTokens(tokensIn, tokensOut) {
    return `${formatCount(tokensIn)}/${formatCount(tokensOut)}`;
}
