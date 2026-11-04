// Time-window arithmetic for the per-agent split. A window is {start, end} in ms. Pure: never mutates its inputs.

/**
 * Windows with end > start, copied, sorted by start and with overlapping or touching windows merged.
 * @param {{start: number, end: number}[]} windows
 * @returns {{start: number, end: number}[]}
 */
function mergedWindows(windows) {
    const sorted = windows
        .filter((window) => window.end > window.start)
        .map((window) => ({ start: window.start, end: window.end }))
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const window of sorted) {
        const last = merged[merged.length - 1];
        if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
        else merged.push(window);
    }
    return merged;
}

/**
 * Total length of the union of the windows; overlaps are counted once.
 * @param {{start: number, end: number}[]} windows
 * @returns {number} ms
 */
export function unionMs(windows) {
    return mergedWindows(windows).reduce((total, window) => total + (window.end - window.start), 0);
}

/**
 * Length of the union of `windows` that is not covered by the union of `excluded`.
 * Uses |U \ X| = |U ∪ X| − |X|.
 * @param {{start: number, end: number}[]} windows
 * @param {{start: number, end: number}[]} excluded
 * @returns {number} ms
 */
export function exclusiveMs(windows, excluded) {
    return unionMs([...windows, ...excluded]) - unionMs(excluded);
}
