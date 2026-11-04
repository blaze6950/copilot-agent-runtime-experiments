// Test doubles of the turn-cost extension: a fake session with `log` (session.log), a fake log transport and fake timers for the transport timeout.

/**
 * Fake CLI session with `log(message, options)` and `on(handler)`. `fail` makes every log call reject with that message, `hang` makes it never answer.
 * Every log call is recorded in `calls` as {message, options}; every subscription in `handlers`.
 */
export function fakeLogSession({ fail = null, hang = false, sessionId = "fake-session" } = {}) {
    const calls = [];
    const handlers = [];
    return {
        sessionId,
        calls,
        handlers,
        on(handler) {
            handlers.push(handler);
        },
        log(message, options) {
            calls.push({ message, options });
            if (fail !== null) return Promise.reject(new Error(fail));
            if (hang) return new Promise(() => {});
            return Promise.resolve();
        },
    };
}

/**
 * Fake of the transport (the same two methods): records every line with its level, and the value of `marker()` at the time it was
 * written. The reporter tests use the marker to tell which event caused a line.
 * `outcome(level, text)` gives the answer of one write: true (written), false (not written) or a throw (write error). Default: true.
 */
export function fakeLogTransport({ marker = () => null, outcome = () => true } = {}) {
    const lines = [];
    const record = (level) => async (text) => {
        lines.push({ level, text, marker: marker() });
        return outcome(level, text);
    };
    return { lines, logInfo: record("info"), logWarning: record("warning") };
}

/** Fake timers: `setTimeout` stores the callback, `fire()` runs every pending one, `clearTimeout` removes it. `delays()` lists the delays asked for. */
export function fakeTimers() {
    const pending = new Map();
    const requested = [];
    let seq = 0;
    return {
        delays: () => [...requested],
        pendingCount: () => pending.size,
        setTimeout(callback, ms) {
            const id = ++seq;
            requested.push(ms);
            pending.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        fire() {
            for (const [id, callback] of [...pending]) {
                pending.delete(id);
                callback();
            }
        },
    };
}
