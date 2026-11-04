// Shared contracts of the shell governor: frozen enums and JSDoc typedefs. No runtime dependencies, no SDK imports.

/** Verdicts in increasing severity (SYNTAX is the only automatic deny; ASK asks the user). */
export const VERDICT = Object.freeze({ SAFE: 'SAFE', AI: 'AI', ASK: 'ASK', SYNTAX: 'SYNTAX' });

/** Severity per verdict; a higher value is stricter. */
export const VERDICT_SEVERITY = Object.freeze({ SAFE: 0, AI: 1, ASK: 2, SYNTAX: 3 });

/** Operation classes in increasing risk order (the index is the rank), from the governor-draft engine. */
export const OP_CLASS_RANK = Object.freeze([
    'read', 'read-remote', 'session', 'scratch', 'write', 'execute-code', 'download', 'install', 'auth',
    'credential', 'cost', 'unknown', 'spawn-agent', 'publish', 'remote-write', 'delete', 'history-rewrite',
    'remote-destructive', 'admin', 'persistence', 'privilege', 'system', 'dynamic',
]);

/** Intent of each operation class (what the operation does to the machine or remote state). */
export const INTENT = Object.freeze({ READ: 'read', WRITE: 'write', DELETE: 'delete', EXECUTE: 'execute' });

/** Operation class → intent. Every class in OP_CLASS_RANK has exactly one intent. */
export const CLASS_INTENT = Object.freeze({
    read: INTENT.READ, 'read-remote': INTENT.READ, session: INTENT.READ, scratch: INTENT.WRITE, write: INTENT.WRITE,
    'execute-code': INTENT.EXECUTE, download: INTENT.WRITE, install: INTENT.WRITE, auth: INTENT.READ,
    credential: INTENT.READ, cost: INTENT.READ, unknown: INTENT.READ, 'spawn-agent': INTENT.READ,
    publish: INTENT.WRITE, 'remote-write': INTENT.WRITE, delete: INTENT.DELETE, 'history-rewrite': INTENT.WRITE,
    'remote-destructive': INTENT.DELETE, admin: INTENT.WRITE, persistence: INTENT.WRITE, privilege: INTENT.WRITE,
    system: INTENT.WRITE, dynamic: INTENT.EXECUTE,
});

/** Directory levels: normal (access per allow), protected (read only unless allowed), secret (any access asks). */
export const LEVEL = Object.freeze({ NORMAL: 'normal', PROTECTED: 'protected', SECRET: 'secret' });

/** The nine AI judge ratings (each an integer 0..RATING_MAX). Stage-3 blocks on the first four at ≥ 1, the rest at ≥ 2. */
export const RATINGS = Object.freeze([
    'destructive', 'irreversible', 'credential_access', 'exfiltration',
    'blast_radius', 'privilege_persistence', 'prod_external', 'obfuscation', 'task_mismatch',
]);

/** Highest judge rating; every rating is an integer 0..RATING_MAX. */
export const RATING_MAX = 3;

/**
 * Deterministic facts extracted from a script or tool call (draft shape; later tasks may add fields).
 * @typedef {object} Facts
 * @property {string[]} classes operation classes found (values from OP_CLASS_RANK)
 * @property {Array<'read'|'write'|'delete'|'execute'>} intents intents found (values from INTENT)
 * @property {string[]} paths paths referenced by the operations
 * @property {string[]} notes extraction notes (unresolved reads, dynamic parts, syntax problems)
 */

/**
 * Verdict of one decision.
 * @typedef {object} Verdict
 * @property {'SAFE'|'AI'|'ASK'|'SYNTAX'} verdict
 * @property {string[]} ruleIds matched rule ids
 * @property {string} reason short human-readable reason (no secrets, no full script text)
 */

/**
 * AI judge ratings for one script.
 * @typedef {object} Ratings
 * @property {Record<typeof RATINGS[number], number>} values each rating 0..RATING_MAX
 * @property {number} confidence 0–1
 * @property {string} [whatItDoes] one sentence from the judge: what the script does
 * @property {string} [worstConsequence] one sentence from the judge: the worst realistic consequence if the script runs
 */

/**
 * Output of the preToolUse hook, as the CLI reads it.
 * @typedef {object} HookOutput
 * @property {'allow'|'deny'|'ask'} permissionDecision
 * @property {string} [permissionDecisionReason]
 */
