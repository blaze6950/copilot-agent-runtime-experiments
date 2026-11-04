// Reporter of the turn-cost extension: session events -> accounting -> rendered blocks -> one info line per block through the transport.
// Each block is written after the previous one (queue), so the lines keep the order of the blocks. The metric config is read before every block.
// The reporter never throws: a failing event or write is logged to the extension's own log and the next event goes on.
import { createAccounting } from "./accounting.mjs";
import { colorEnabled } from "./color.mjs";
import { CONFIG_WARNING_PREFIX } from "./config.mjs";
import { renderAgent, renderTurn } from "./render.mjs";

/** The event type for a log line; a getter that throws must not stop the logging. */
function typeOf(event) {
    try {
        return String(event?.type);
    } catch {
        return "unreadable";
    }
}

/**
 * @param {object} options
 * @param {{logInfo: (text: string) => Promise<boolean>, logWarning: (text: string) => Promise<boolean>}} options.transport
 * @param {() => {metrics: object, problems: string[]}} options.readMetrics read on every block
 * @param {object} [options.env] process environment (NO_COLOR)
 * @param {(msg: string) => void} [options.log] the extension's own log file
 * @param {() => number} [options.now] clock in ms, used for events without a valid timestamp
 * @param {{apply: (event: object, nowMs: number) => object[]}} [options.accounting] events to blocks (tests replace it)
 * @returns {{onEvent: (event: object) => void, flushed: () => Promise<void>}}
 */
export function createReporter({ transport, readMetrics, env = {}, log = () => {}, now = () => Date.now(), accounting = createAccounting() }) {
    /** Distinct config problem texts already sent as a warning; a text is added only after its warning was sent. */
    const warnedProblemTexts = new Set();
    let queue = Promise.resolve();

    async function warnAboutProblems(problems) {
        if (problems.length === 0) return;
        const problemText = problems.join("; ");
        if (warnedProblemTexts.has(problemText)) return;
        log(`config-warning ${problemText}`);
        try {
            if (await transport.logWarning(CONFIG_WARNING_PREFIX + problemText)) warnedProblemTexts.add(problemText);
        } catch (e) {
            log(`warning-error ${e?.stack ?? e}`);
        }
    }

    /**
     * Writes one block. Everything that can fail while the block is prepared (metric config, text, label, cost) runs before the write,
     * so such a failure is a write-error for a block that was not written. The receipt is logged from values prepared before the write.
     */
    async function write(block) {
        let prepared;
        try {
            const { metrics, problems } = readMetrics();
            await warnAboutProblems(problems);
            const options = { metrics, color: colorEnabled(env) };
            const text = block.kind === "turn" ? renderTurn(block, options) : renderAgent(block, options);
            const label = block.kind === "turn" ? `turn ${block.number}` : `agent ${block.row.agent}`;
            const costUsd = block.kind === "turn" ? block.costUsd : block.row.costUsd;
            prepared = { text, label, cost: `$${costUsd.toFixed(5)}` };
        } catch (e) {
            log(`write-error ${e?.stack ?? e}`);
            return;
        }
        log(`block ${prepared.label} writing`);
        let written;
        try {
            written = await transport.logInfo(prepared.text);
        } catch (e) {
            log(`write-error ${e?.stack ?? e}`);
            return;
        }
        log(`block ${prepared.label} ${prepared.cost} ${written ? "written" : "not-written"}`);
    }

    function onEvent(event) {
        let blocks;
        try {
            blocks = accounting.apply(event, now());
        } catch (e) {
            log(`event-error ${typeOf(event)}: ${e?.stack ?? e}`);
            return;
        }
        for (const block of blocks) queue = queue.then(() => write(block));
    }

    return { onEvent, flushed: () => queue };
}
