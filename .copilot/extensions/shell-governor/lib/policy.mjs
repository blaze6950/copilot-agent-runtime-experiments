// Stage-3 policy: maps AI judge ratings to ALLOW or ASK with thresholds from config, and combines the rule verdict with
// the judge outcome. A rule verdict of ASK is never lowered by the AI. Imports only contracts.mjs; no I/O.
//
// Two optional stage-3 keys relax the strict rules; both stay off unless the key is present (see Thresholds):
// - taskMismatchAloneAsksAt: task_mismatch alone asks only at that value (still at the soft threshold when another rating is 1+);
// - credentialAccessReadOnlyAllowed: credential_access = 1 alone is allowed when the engine facts show a read-only script and every engine rule id is in READ_ONLY_RULES.
// Low confidence, unreadable ratings and every other rating keep their strict behaviour.
import { INTENT, RATINGS, RATING_MAX } from './contracts.mjs';

/**
 * Stage-3 thresholds as read from config (governor.json `stage3`).
 * @typedef {object} Thresholds
 * @property {string[]} hardRatings ratings that ask at `hardThreshold`
 * @property {number} hardThreshold
 * @property {number} softThreshold threshold for every other rating
 * @property {number} minConfidence ASK when the judge confidence is below this
 * @property {number} [taskMismatchAloneAsksAt] task_mismatch asks only at this value when it is the only rating at or above its limit
 *   and every other rating is below 1; absent: no relaxation. Must be above softThreshold and at most RATING_MAX; otherwise the thresholds are invalid
 * @property {boolean} [credentialAccessReadOnlyAllowed] credential_access = 1 alone is allowed for a read-only script; absent or false: no relaxation
 */

/**
 * Engine evidence of the call a judge outcome belongs to.
 * @typedef {object} CallEvidence
 * @property {object} [facts] engine facts of the script (contracts.mjs Facts)
 * @property {string[]} [ruleIds] ids of the rules that matched the call
 */

/**
 * Operation classes that count as read-only for the credential relaxation: local reads and network reads (user decision (b),
 * narrowed: class cost starts billable resources, catalog aws.json:24, hcloud.json:12).
 */
export const READ_ONLY_CLASSES = Object.freeze(['read', 'read-remote']);

/** Notes that make a script not read-only: dynamic command or nested code, a download that is run, an unresolved SQL statement. */
export const RISKY_NOTES = Object.freeze(['dynamic-command', 'nested-dynamic', 'download-exec', 'sql-unresolved']);

/**
 * Note prefixes that make a script not read-only: `syntax:` (parse error) and `dynamic-path:` (a target the engine could not
 * resolve). With RISKY_NOTES these cover every note the engine emits (engine.mjs factsOf, lines 581-590). Notes are not the
 * complete evidence: dynamic invocation and recursive reads reach the policy only as rule ids, which READ_ONLY_RULES checks.
 */
export const RISKY_NOTE_PREFIXES = Object.freeze(['syntax:', 'dynamic-path:']);

/**
 * Engine rule ids that keep a script eligible for the credential relaxation. Each one means a local read (READ), a network
 * read (READ-REMOTE, D-OFFICIAL-READ) or a read target that the directory rules checked under its written and real name
 * without a secret match (READ-ANYWHERE, DIR-OK, DIR-PROTECTED-READ; DIR-OK can also be an allowed write, which the intent
 * check refuses). Allowlist on purpose: the relaxation relies on the path rules having caught secret files before the judge,
 * so every other id asks — recursive reads, dynamic invocation, unresolved or unchecked paths, write, delete, execute, cost,
 * auth, unknown classes, and any id the engine adds later.
 */
export const READ_ONLY_RULES = Object.freeze(['READ', 'READ-REMOTE', 'D-OFFICIAL-READ', 'READ-ANYWHERE', 'DIR-OK', 'DIR-PROTECTED-READ']);

/**
 * Result of a policy decision.
 * @typedef {object} PolicyResult
 * @property {'ALLOW'|'ASK'|'DENY'} decision
 * @property {string[]} reasons why the decision is not ALLOW (empty for ALLOW)
 */

const INVALID_CONFIG_REASON = 'stage3 thresholds or confidence invalid';

/** @param {any} t */
function thresholdsValid(t) {
    return !!t && typeof t === 'object' && Array.isArray(t.hardRatings) && t.hardRatings.length > 0
        && t.hardRatings.every((r) => RATINGS.includes(r))
        && Number.isFinite(t.hardThreshold) && Number.isFinite(t.softThreshold) && Number.isFinite(t.minConfidence)
        && (t.taskMismatchAloneAsksAt === undefined
            || (Number.isFinite(t.taskMismatchAloneAsksAt) && t.taskMismatchAloneAsksAt > t.softThreshold && t.taskMismatchAloneAsksAt <= RATING_MAX))
        && (t.credentialAccessReadOnlyAllowed === undefined || typeof t.credentialAccessReadOnlyAllowed === 'boolean');
}

/** @param {unknown} note */
function harmlessNote(note) {
    return typeof note === 'string' && !RISKY_NOTES.includes(note) && !RISKY_NOTE_PREFIXES.some((p) => note.startsWith(p));
}

/**
 * True when the engine facts show a read-only script: every operation class is in READ_ONLY_CLASSES, every intent is `read`,
 * no note is risky, and every matched engine rule id is in READ_ONLY_RULES. Missing, malformed or empty evidence (including an
 * empty rule-id list) is not read-only.
 * @param {CallEvidence | undefined} call
 * @returns {boolean}
 */
export function readOnlyCall(call) {
    const facts = call?.facts;
    if (!facts || typeof facts !== 'object') return false;
    const { classes, intents, notes } = facts;
    if (!Array.isArray(classes) || !Array.isArray(intents) || !Array.isArray(notes)) return false;
    if (classes.length === 0 || intents.length === 0) return false;
    if (!classes.every((c) => READ_ONLY_CLASSES.includes(c))) return false;
    if (!intents.every((i) => i === INTENT.READ)) return false;
    if (!notes.every(harmlessNote)) return false;
    const { ruleIds } = call;
    return Array.isArray(ruleIds) && ruleIds.length > 0 && ruleIds.every((id) => READ_ONLY_RULES.includes(id));
}

/**
 * Engine evidence of a rule verdict. Hook verdicts carry rules as `{ rule }` objects, replay verdicts as rule-id strings.
 * @param {unknown} ruleVerdict
 * @returns {CallEvidence}
 */
export function callEvidenceOf(ruleVerdict) {
    if (!ruleVerdict || typeof ruleVerdict !== 'object') return { facts: undefined, ruleIds: undefined };
    return {
        facts: ruleVerdict.facts,
        ruleIds: Array.isArray(ruleVerdict.rules) ? ruleVerdict.rules.map((r) => (typeof r === 'string' ? r : r?.rule)) : undefined,
    };
}

/** task_mismatch alone: it is the only trigger, below `taskMismatchAloneAsksAt`, and every other rating is below 1. */
function taskMismatchRelaxed(values, thresholds, ratingTriggers) {
    if (!Number.isFinite(thresholds.taskMismatchAloneAsksAt) || thresholds.hardRatings.includes('task_mismatch')) return false;
    const mismatch = ratingTriggers.find((t) => t.name === 'task_mismatch');
    if (!mismatch || mismatch.value >= thresholds.taskMismatchAloneAsksAt) return false;
    return RATINGS.every((k) => k === 'task_mismatch' || values[k] < 1);
}

/** credential_access = 1 alone: the only rating trigger, at 1, for a read-only script with engine evidence. */
function credentialRelaxed(thresholds, ratingTriggers, call) {
    if (thresholds.credentialAccessReadOnlyAllowed !== true) return false;
    return ratingTriggers.length === 1 && ratingTriggers[0].name === 'credential_access' && ratingTriggers[0].value === 1
        && readOnlyCall(call);
}

/**
 * One Stage-3 trigger: a rating at or above its limit, or the confidence below its minimum.
 * @typedef {object} Stage3Trigger
 * @property {string} name rating key, or `confidence`
 * @property {number} value the judged value
 * @property {number} limit the threshold it reached (rating) or fell below (confidence)
 */

/**
 * Stage-3 assessment of judge ratings: the triggers that ask, and the ratings whose trigger a relaxation removed. `valid` is false
 * when the ratings, the confidence or the thresholds are invalid (then there are no triggers).
 * @param {import('./contracts.mjs').Ratings | undefined} ratings
 * @param {Thresholds} thresholds
 * @param {CallEvidence} [call] engine evidence of the call (see callEvidenceOf); absent: no relaxation
 * @returns {{ valid: boolean, triggers: Stage3Trigger[], relaxed: string[] }}
 */
export function stage3Assessment(ratings, thresholds, call) {
    const values = ratings?.values;
    if (!values || RATINGS.some((k) => !Number.isFinite(values[k]))) return { valid: false, triggers: [], relaxed: [] };
    if (!thresholdsValid(thresholds) || !Number.isFinite(ratings.confidence)) return { valid: false, triggers: [], relaxed: [] };
    const ratingTriggers = [];
    for (const key of RATINGS) {
        const hard = thresholds.hardRatings.includes(key);
        const limit = hard ? thresholds.hardThreshold : thresholds.softThreshold;
        if (values[key] >= limit) ratingTriggers.push({ name: key, value: values[key], limit });
    }
    const triggers = [...ratingTriggers];
    if (ratings.confidence < thresholds.minConfidence) {
        triggers.push({ name: 'confidence', value: ratings.confidence, limit: thresholds.minConfidence });
    }
    const relaxed = [];
    if (taskMismatchRelaxed(values, thresholds, ratingTriggers)) relaxed.push('task_mismatch');
    if (credentialRelaxed(thresholds, ratingTriggers, call)) relaxed.push('credential_access');
    return { valid: true, triggers: triggers.filter((t) => !relaxed.includes(t.name)), relaxed };
}

/**
 * Stage-3 triggers of judge ratings, in RATINGS order with the confidence last, after the relaxations (see stage3Assessment).
 * Empty when the ratings, the confidence or the thresholds are invalid or when no trigger applies.
 * @param {import('./contracts.mjs').Ratings | undefined} ratings
 * @param {Thresholds} thresholds
 * @param {CallEvidence} [call] engine evidence of the call; absent: no relaxation
 * @returns {Stage3Trigger[]}
 */
export function stage3Triggers(ratings, thresholds, call) {
    return stage3Assessment(ratings, thresholds, call).triggers;
}


/**
 * Map judge ratings to ALLOW or ASK. Missing or malformed ratings, thresholds or confidence ask (fail closed).
 * @param {import('./contracts.mjs').Ratings | undefined} ratings
 * @param {Thresholds} thresholds
 * @param {CallEvidence} [call] engine evidence of the call (see callEvidenceOf); absent: no relaxation
 * @returns {PolicyResult}
 */
export function stage3(ratings, thresholds, call) {
    const values = ratings?.values;
    if (!values || RATINGS.some((k) => !Number.isFinite(values[k]))) {
        return { decision: 'ASK', reasons: ['judge ratings missing or malformed'] };
    }
    if (!thresholdsValid(thresholds) || !Number.isFinite(ratings.confidence)) {
        return { decision: 'ASK', reasons: [INVALID_CONFIG_REASON] };
    }
    const reasons = stage3Triggers(ratings, thresholds, call).map((t) => (t.name === 'confidence'
        ? `confidence ${t.value} below ${t.limit}`
        : `${t.name}=${t.value} (asks at >= ${t.limit})`));
    return { decision: reasons.length ? 'ASK' : 'ALLOW', reasons };
}

/**
 * Combine the rule verdict with the judge outcome. The AI can only decide when the rules said AI; it never lowers ASK.
 * @param {'SAFE'|'AI'|'ASK'|'SYNTAX'|import('./contracts.mjs').Verdict} ruleVerdict
 * @param {{ outcome: 'ratings', ratings: import('./contracts.mjs').Ratings } | { outcome: 'ask', reason: string } | undefined} judgeOutcome
 * @param {Thresholds} thresholds
 * @returns {PolicyResult}
 */
export function combine(ruleVerdict, judgeOutcome, thresholds) {
    const verdict = typeof ruleVerdict === 'string' ? ruleVerdict : ruleVerdict?.verdict;
    const ruleReason = typeof ruleVerdict === 'object' && ruleVerdict?.reason ? `: ${ruleVerdict.reason}` : '';
    switch (verdict) {
        case 'SYNTAX':
            return { decision: 'DENY', reasons: [`rule verdict SYNTAX${ruleReason}`] };
        case 'ASK':
            return { decision: 'ASK', reasons: [`rule verdict ASK${ruleReason}`] };
        case 'SAFE':
            return { decision: 'ALLOW', reasons: [] };
        case 'AI':
            if (!judgeOutcome) return { decision: 'ASK', reasons: ['no judge outcome'] };
            if (judgeOutcome.outcome === 'ratings') return stage3(judgeOutcome.ratings, thresholds, callEvidenceOf(ruleVerdict));
            return { decision: 'ASK', reasons: [`judge unavailable: ${judgeOutcome.reason}`] };
        default:
            return { decision: 'ASK', reasons: [`unknown rule verdict ${String(verdict)}`] };
    }
}
