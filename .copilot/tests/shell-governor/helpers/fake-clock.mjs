/**
 * Deterministic clock for tests: now() only moves when advance() is called.
 * @param {string} [startIso]
 * @returns {{ now: () => number, advance: (ms: number) => number }}
 */
export function createFakeClock(startIso = '2026-10-19T00:00:00.000Z') {
    let t = Date.parse(startIso);
    return {
        now: () => t,
        advance(ms) {
            t += ms;
            return t;
        },
    };
}
