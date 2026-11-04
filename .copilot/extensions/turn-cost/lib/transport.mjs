// Log transport of the turn-cost extension: the only module that calls session.log (one line per call, no ephemeral lines).
// Every call is bounded by a timeout and never throws; a failure or a hang is logged to the extension's own log and reported as false.

/** A single session.log call that does not answer within this time counts as failed. */
export const DEFAULT_TIMEOUT_MS = 5000;

const TIMED_OUT = Symbol("timed-out");

/**
 * @param {{log: (message: string, options: {level: string}) => Promise<unknown>}} session Copilot CLI session
 * @param {(msg: string) => void} [log] the extension's own log file
 * @param {{timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function}} [options] timer source (tests inject fake timers)
 * @returns {{logInfo: (text: string) => Promise<boolean>, logWarning: (text: string) => Promise<boolean>}}
 */
export function createLogTransport(session, log = () => {}, options = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS, setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout,
    } = options;

    /** Writes one line at `level`. Resolves true when the CLI answered, false on a failure or a timeout. */
    async function write(text, level) {
        let handle;
        const timeout = new Promise((resolve) => {
            handle = startTimer(() => resolve(TIMED_OUT), timeoutMs);
            handle?.unref?.();
        });
        try {
            const answer = await Promise.race([session.log(text, { level }), timeout]);
            if (answer === TIMED_OUT) {
                log(`log-timeout no answer after ${timeoutMs}ms`);
                return false;
            }
            return true;
        } catch (e) {
            log(`log-error ${e?.message ?? e}`);
            return false;
        } finally {
            stopTimer(handle);
        }
    }

    return {
        logInfo: (text) => write(text, "info"),
        logWarning: (text) => write(text, "warning"),
    };
}
