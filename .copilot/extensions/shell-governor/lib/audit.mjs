// Audit log of the shell governor: one JSON line per decision in logs/audit-<yyyy-mm-dd>.jsonl (UTC date).
// Only whitelisted fields and values are written. The script is stored as its SHA-256 hex digest only. session, agent
// and tool must match a safe identifier pattern of at most 32 characters, rule ids of at most 64; enums must be known
// values; ratings must be integers 0–3. Reasons, arguments and any other text are dropped. Writing never throws: a
// failure returns false and is reported through onError, so the audit can never change or break a decision. No SDK
// imports.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RATINGS, VERDICT } from './contracts.mjs';

/** Dialog outcomes that may appear in the audit (never the reason text). */
export const DIALOG_OUTCOMES = Object.freeze(['allow', 'deny', 'ask', 'hook-ask']);

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,32}$/;
const RULE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const VERDICTS = new Set(Object.values(VERDICT));
const OUTCOMES = new Set(DIALOG_OUTCOMES);

/**
 * SHA-256 hex digest of a script (UTF-8).
 * @param {string} script
 * @returns {string}
 */
export function hashScript(script) {
    return createHash('sha256').update(String(script), 'utf8').digest('hex');
}

const identifier = (value) => (typeof value === 'string' && IDENTIFIER.test(value) ? value : null);
const knownIn = (set) => (value) => (typeof value === 'string' && set.has(value) ? value : null);
const nonNegativeNumber = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** Keeps only the nine rating names with integer values 0–3; accepts a values record or a Ratings object. */
function pickRatings(input) {
    if (!input || typeof input !== 'object') return null;
    const values = input.values && typeof input.values === 'object' ? input.values : input;
    const out = {};
    for (const name of RATINGS) {
        const value = values[name];
        if (Number.isInteger(value) && value >= 0 && value <= 3) out[name] = value;
    }
    return out;
}

/** Rule ids that match the rule-id pattern; accepts plain ids or {id, explanation} objects (explanations are dropped). */
function pickRuleIds(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map((rule) => (typeof rule === 'string' ? rule : rule?.id))
        .filter((id) => typeof id === 'string' && RULE_ID.test(id));
}

/**
 * @param {object} options
 * @param {string} options.logsDir absolute folder of the audit files (created on first write)
 * @param {{ now: () => number }} options.clock
 * @param {(err: unknown) => void} [options.onError] receives write failures; errors thrown by it are ignored
 */
export function createAudit({ logsDir, clock, onError = () => {} } = {}) {
    if (!logsDir) throw new TypeError('createAudit: logsDir is required');
    if (!clock || typeof clock.now !== 'function') throw new TypeError('createAudit: clock is required');

    const report = (err) => {
        try {
            onError(err);
        } catch {
            // A failing error hook must not change the decision either.
        }
    };

    return Object.freeze({
        /**
         * Appends one decision to the audit file of its day. `time` comes from the clock, not from the entry.
         * Never throws.
         * @param {{ session?: string, agent?: string, tool?: string, script?: string, scriptHash?: string,
         *   verdict?: string, ruleIds?: Array<string | { id: string }>, ratings?: object, judgeLatencyMs?: number,
         *   dialogOutcome?: string }} entry
         * @returns {boolean} true when the line was appended, false when writing failed (reported via onError)
         */
        write(entry = {}) {
            try {
                const at = clock.now();
                const scriptHash = typeof entry.scriptHash === 'string' && HEX_SHA256.test(entry.scriptHash)
                    ? entry.scriptHash
                    : typeof entry.script === 'string' ? hashScript(entry.script) : null;
                const record = {
                    time: new Date(at).toISOString(),
                    session: identifier(entry.session),
                    agent: identifier(entry.agent),
                    tool: identifier(entry.tool),
                    scriptHash,
                    verdict: knownIn(VERDICTS)(entry.verdict),
                    ruleIds: pickRuleIds(entry.ruleIds),
                    ratings: pickRatings(entry.ratings),
                    judgeLatencyMs: nonNegativeNumber(entry.judgeLatencyMs),
                    dialogOutcome: knownIn(OUTCOMES)(entry.dialogOutcome),
                };
                const day = new Date(at).toISOString().slice(0, 10);
                mkdirSync(logsDir, { recursive: true });
                appendFileSync(join(logsDir, `audit-${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
                return true;
            } catch (err) {
                report(err);
                return false;
            }
        },
    });
}
