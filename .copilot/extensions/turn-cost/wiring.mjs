// turn-cost start logic: the kill switch, the session join and the event subscription. No SDK import and no file access,
// so tests run it with fakes. extension.mjs passes the SDK's joinSession, the file log and the metric reader.
// Kill switch (COPILOT_TURN_COST=off): the session is still joined, so the CLI does not wait for the extension at start,
// but nothing is subscribed and session.log is never called. One line goes to the extension's own log.
import { ENV_NAME, disabledBy } from "./lib/config.mjs";
import { createReporter } from "./lib/reporter.mjs";
import { createLogTransport } from "./lib/transport.mjs";

/**
 * Joins the session, then either subscribes the reporter (switch unset) or only logs the switch (switch on).
 * @param {object} deps
 * @param {Record<string, string | undefined>} deps.env process environment
 * @param {(options: object) => Promise<{sessionId?: string, on: Function, log: Function}>} deps.joinSession the SDK join
 * @param {(message: string) => void} deps.log writes one line to the extension's own log
 * @param {(sessionId: string) => void} deps.setSessionId sets the id used as the log prefix
 * @param {() => {metrics: object, problems: string[]}} deps.readMetrics metric config, read on every block
 */
export async function start({ env, joinSession, log, setSessionId, readMetrics }) {
    const session = await joinSession({});
    setSessionId(session.sessionId ?? "unknown");
    if (disabledBy(env)) {
        log(`disabled by ${ENV_NAME}=off`);
        return;
    }
    const reporter = createReporter({ transport: createLogTransport(session, log), readMetrics, env, log });
    log(`start pid=${process.pid}`);
    session.on((event) => {
        try { reporter.onEvent(event); } catch (e) { log(`event-handler-error ${e?.stack ?? e}`); }
    });
}
