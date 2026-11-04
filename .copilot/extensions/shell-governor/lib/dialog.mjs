// Approval dialog of the shell governor. Builds a plain-text message (agent and task, agent-file link, purpose line,
// judge sentences, rule names, script excerpt) and a full review file (all details and the whole script), shows one elicitation
// form per request and re-shows it until an explicit answer arrives ("Approve once", "Decline", or guidance typed in "Other",
// which counts as a decline). No SDK import:
// the session ui object is injected. Only the fields of the request are rendered, so no session history can leak.
// Fail-closed: when the dialog cannot be shown or the review file cannot be written, the outcome is 'ask' or
// 'hook-ask' with a reason, never allow.
//
// Production wiring (T9) must:
// - inject a monotonic clock (performance.now()-based) for the review-file stamp and the pruning of old reviews;
// - always pass `capabilities` from the host, so a host without elicitation is detected before any dialog is built.
//
// Host detection rule (live probe on CLI 1.0.98, T11 follow-up). Both an interactive session and `copilot -p` report
// capabilities.ui.elicitation === true and a function session.ui.elicitation, so elicitation alone cannot tell them apart.
// The only observed difference is capabilities.ui.canvases: true in an interactive session, false in `copilot -p`.
// - No dialog (outcome 'ask', reason "no interactive UI"; the CLI turns it into a deny in -p mode) when
//   session.ui.elicitation is not a function, capabilities.ui.elicitation === false, capabilities.ui.canvases === false,
//   or the request runs in autopilot. Nothing is written to the review folder in these cases.
// - A host that reports elicitation === true AND canvases === true is known interactive: the dialog waits for the user
//   with no time limit (the user may legitimately take long).
// - Any other host that gets a dialog (capability object missing or partial) is not known interactive. Each display then
//   has a watchdog (watchdogMs, default 10 minutes): when it expires the outcome is 'hook-ask' with a reason, so an
//   elicitation that never settles cannot hang the hook.
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RATINGS } from './contracts.mjs';
import { hashScript } from './audit.mjs';

/** Decision values of the elicitation form. Only APPROVE_ONCE and DECLINE count as answers. */
export const DECISION = Object.freeze({ NOT_DECIDED: 'not_decided', APPROVE_ONCE: 'approve_once', DECLINE: 'decline' });

const DECISION_OPTIONS = Object.freeze([
    { const: DECISION.NOT_DECIDED, title: '— not decided —' },
    { const: DECISION.APPROVE_ONCE, title: 'Approve once' },
    { const: DECISION.DECLINE, title: 'Decline' },
]);
/** Limit for the guidance typed in "Other", after it is made one line and trimmed. */
const MAX_GUIDANCE_LENGTH = 500;
/** Limit for the call purpose the agent states (toolArgs.description); shown unverified. */
const MAX_CALL_PURPOSE_CHARS = 300;
/** Total dialog displays per request, the first one included. Then the governor returns hook-ask (R-10). */
const MAX_DISPLAYS = 50;
/** Limit for one display on a host that is not known to be interactive (see the detection rule in the header). */
const DEFAULT_WATCHDOG_MS = 600_000;
const DEFAULT_REVIEW_RETENTION_DAYS = 14;
const MAX_TASK_NAME_CHARS = 200;
const MAX_REVIEW_NAME_TRIES = 1000;
/** Agent names that may be linked: a plain file name, no path separators and no "..". */
const AGENT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DAY_MS = 86_400_000;

/**
 * Characters shown as \xNN (≤ 0xFF) or \uNNNN: C0 (tab stays), DEL, C1, U+2028 and U+2029, plus the invisible and
 * direction-changing format characters that can disguise text: U+200B–U+200F (zero-width, LRM, RLM),
 * U+202A–U+202E (embeddings, overrides), U+2060–U+2064 (word joiner, invisible operators), U+2066–U+2069 (isolates), U+FEFF.
 * Line breaks are split before this applies.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** The invisible and direction-control part of CONTROL_CHARS (the reason for the warning line). */
const HIDDEN_FORMAT_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
/** Review files written by this module: <stamp>-<12 hex>[-n].txt */
const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]{12}(?:-\d+)?\.txt$/;

const escapeOne = (char) => {
    const code = char.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
};
const escapeControl = (text) => text.replace(CONTROL_CHARS, escapeOne);
/** `\s` without U+2028, U+2029 and U+FEFF, which are escaped instead of being collapsed into a space. */
const COLLAPSIBLE_SPACE = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;
const oneLine = (value) => escapeControl(String(value ?? '').replace(COLLAPSIBLE_SPACE, ' ').trim());
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text);
/** Cuts a script line to `max` characters (exact cut, no ellipsis: the note below the script says so). */
const cutLine = (text, max) => (text.length > max ? text.slice(0, max) : text);

/**
 * file:/// URL with forward slashes and %20 for spaces; the drive letter keeps its colon.
 * UNC paths become file://server/share/... URLs.
 * @param {string} path absolute path (drive or UNC)
 * @returns {string}
 */
export function fileUrl(path) {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('//')) {
        const [host, ...rest] = normalized.slice(2).split('/');
        return `file://${host}/${rest.map((segment) => encodeURIComponent(segment)).join('/')}`;
    }
    const segments = normalized.replace(/^\/+/, '').split('/');
    const encoded = segments.map((segment, i) => (i === 0 && /^[A-Za-z]:$/.test(segment)
        ? segment
        : encodeURIComponent(segment)));
    return `file:///${encoded.join('/')}`;
}

/**
 * Dialog settings from the governor config (`dialog` section). scriptLines: N > 0 shows N lines; maxLineChars: N > 0 cuts
 * longer script lines to N characters. Absent, 0 or invalid = no limit (Infinity).
 */
function settingsOf(config) {
    const dialog = config?.dialog ?? {};
    const positiveOrUnlimited = (value) => (Number.isInteger(value) && value > 0 ? value : Infinity);
    return {
        scriptLines: positiveOrUnlimited(dialog.scriptLines),
        maxLineChars: positiveOrUnlimited(dialog.maxLineChars),
    };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * file:/// link to `<agentsDir>/<agentName>.agent.md` when that file exists; null otherwise (no link, no error).
 * The name must be a plain agent name, so the link never leaves the agents folder.
 */
function agentFileUrl(agentsDir, agentName) {
    if (typeof agentsDir !== 'string' || !agentsDir) return null;
    if (typeof agentName !== 'string' || !AGENT_FILE_NAME.test(agentName) || agentName.includes('..')) return null;
    const path = join(agentsDir, `${agentName}.agent.md`);
    return existsSync(path) ? fileUrl(path) : null;
}

/** Why no dialog can be shown, or null when one can. See the detection rule in the header. */
function noUiReason(ui, capabilities, request) {
    if (typeof ui?.elicitation !== 'function' || capabilities?.ui?.elicitation === false) {
        return 'no interactive UI: the host has no elicitation capability';
    }
    if (capabilities?.ui?.canvases === false) {
        return 'no interactive UI: the host reports no canvas UI (prompt mode)';
    }
    if (request.permissionMode === 'autopilot') return 'no interactive UI: autopilot mode declines dialogs';
    return null;
}

/** True only when the host affirmatively reports elicitation and canvases (an interactive session, observed). */
function isKnownInteractive(capabilities) {
    return capabilities?.ui?.elicitation === true && capabilities?.ui?.canvases === true;
}

/**
 * Resolves with the elicitation result. When `ms` is a number, rejects with code 'WATCHDOG' if no result arrives in time;
 * when `ms` is null (known interactive host) there is no limit.
 */
async function withWatchdog(pending, ms) {
    if (ms === null) return pending;
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(Object.assign(new Error(`approval dialog gave no answer within ${ms} ms`), { code: 'WATCHDOG' }));
        }, ms);
    });
    try {
        return await Promise.race([pending, expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** Rule ids with one-line explanations; accepts {id, explanation} objects or plain ids. */
function normalizeRules(ruleIds) {
    if (!Array.isArray(ruleIds)) return [];
    return ruleIds.map((rule) => ({ id: oneLine(rule?.id ?? rule), explanation: oneLine(rule?.explanation) }));
}

/**
 * Script lines, escaped and numbered. `count` limits the lines; `maxChars` cuts each shown line (Infinity = no cut).
 * `cut` counts the shown lines that were longer than `maxChars`.
 */
function numberedScript(script, { count = Infinity, maxChars = Infinity } = {}) {
    const lines = script.split(/\r\n|\r|\n/);
    const escaped = lines.slice(0, count).map((text) => escapeControl(text));
    const shown = escaped.map((text) => cutLine(text, maxChars));
    const width = String(shown.length).length;
    return {
        total: lines.length,
        cut: escaped.filter((text) => text.length > maxChars).length,
        shown: shown.map((text, i) => `${String(i + 1).padStart(width)} | ${text}`),
    };
}

function ruleLines(rules) {
    return ['Matched rules:', ...(rules.length
        ? rules.map((rule) => `  ${rule.id}: ${rule.explanation}`)
        : ['  none'])];
}

/** Rule ids only, for the dialog message (the explanations are in the review file). */
const ruleNamesLine = (rules) => `Rules: ${rules.length ? rules.map((rule) => rule.id).join(', ') : 'none'}`;

/**
 * The two one-sentence judge fields. A missing or blank field reads "not given by the AI judge".
 * Caller passes a plain-object ratings value.
 */
function judgeLines(ratings) {
    const sentence = (value) => (typeof value === 'string' ? oneLine(value) : '') || 'not given by the AI judge';
    return [
        `What it does (AI): ${sentence(ratings.whatItDoes)}`,
        `Worst realistic consequence (AI): ${sentence(ratings.worstConsequence)}`,
    ];
}

/**
 * Script block for the message: the first `scriptLines` lines (all when Infinity), each line cut to `maxLineChars`
 * (Infinity = no cut). One note per cut kind sits below the shown lines: long lines cut, and lines left out.
 */
function scriptBlock(scriptText, scriptLines, maxLineChars) {
    const script = numberedScript(scriptText, { count: scriptLines, maxChars: maxLineChars });
    const header = script.total > scriptLines
        ? `Script (first ${scriptLines} of ${script.total} lines):`
        : `Script (${script.total} lines):`;
    return [
        header,
        ...script.shown,
        ...(script.cut > 0 ? [`[long lines cut at ${maxLineChars} characters, full script in the review file]`] : []),
        ...(script.total > scriptLines ? [`[cut at ${scriptLines} lines, full script in the review file]`] : []),
    ];
}

/** Ratings: integers 0–3 are shown, anything else as "-". Confidence is shown with two decimals when valid. */
function ratingLines(ratings) {
    const values = ratings.values ?? {};
    const scale = (value) => (Number.isInteger(value) && value >= 0 && value <= 3 ? String(value) : '-');
    const confidence = Number.isFinite(ratings.confidence) && ratings.confidence >= 0 && ratings.confidence <= 1
        ? ratings.confidence.toFixed(2)
        : '-';
    const width = Math.max(...RATINGS.map((name) => name.length));
    return [
        'AI ratings (0 = none, 3 = high):',
        ...RATINGS.map((name) => `  ${name.padEnd(width)}  ${scale(values[name])}`),
        `AI confidence: ${confidence}`,
    ];
}

/** Facts per kind, one line per kind with every item (the message shows no facts; the review file has all of them). */
function factLines(facts) {
    const rows = [['Operations', facts?.classes], ['Intents', facts?.intents], ['Paths', facts?.paths], ['Notes', facts?.notes]]
        .filter(([, items]) => Array.isArray(items) && items.length > 0)
        .map(([label, items]) => `  ${label}: ${items.map((item) => oneLine(item)).join(', ')}`);
    return ['Extracted facts:', ...(rows.length ? rows : ['  none'])];
}

const claimLine = (request) => `Agent's description (its claim, not verified): ${oneLine(request.agentDescription) || 'none given'}`;
/** Call purpose from toolArgs.description (unverified); "none given" when the request has no string. */
const callPurposeLine = (request) => {
    const purpose = typeof request.callPurpose === 'string' ? oneLine(request.callPurpose) : '';
    return `Purpose stated by the agent (unverified): ${purpose ? clip(purpose, MAX_CALL_PURPOSE_CHARS) : 'none given'}`;
};
/** Header lines shared by the message and the review file. The task part and the agent-file line appear only when known. */
function headerLines(request, agentFile) {
    const taskName = typeof request.taskName === 'string' ? oneLine(request.taskName) : '';
    return [
        `Agent: ${oneLine(request.agentName)}${taskName ? ` — "${clip(taskName, MAX_TASK_NAME_CHARS)}"` : ''}`,
        ...(agentFile ? [`Agent file: ${agentFile}`] : []),
        `Working folder: ${oneLine(request.cwd)}`,
        `Tool: ${oneLine(request.tool)}`,
    ];
}

/** Warning line when the script or any text shown here contains invisible or direction-control characters; else an empty list. */
function hiddenCharWarning(request) {
    const shown = [request.script, request.agentName, request.agentType, request.taskName, request.taskDescription, request.cwd,
        request.tool, request.agentDescription, request.ratings?.whatItDoes, request.ratings?.worstConsequence, request.callPurpose, JSON.stringify(request.facts ?? null), JSON.stringify(request.ruleIds ?? null)];
    if (!shown.some((text) => HIDDEN_FORMAT_CHARS.test(String(text ?? '')))) return [];
    return [['WARNING: the text contains invisible or direction-control characters (they can disguise what a script does); they are shown here as \\uNNNN escapes.']];
}

/**
 * Compact plain-text dialog message: agent header (task name, agent-file link), purpose line, the two judge sentences,
 * rule names, the review link (before the script, so it survives bottom clipping), then the numbered script
 * (`scriptLines` lines and `maxLineChars` characters per line when set). Ratings, facts and the agent's claim are in the
 * review file only.
 */
function buildMessage(request, rules, scriptText, settings, reviewLink, agentFile) {
    const blocks = [
        ['Shell governor: approval needed', ...headerLines(request, agentFile)],
        ...hiddenCharWarning(request),
        [callPurposeLine(request)],
        ...(isPlainObject(request.ratings) ? [judgeLines(request.ratings)] : []),
        [ruleNamesLine(rules)],
        [`Full script and details: ${reviewLink}`],
        scriptBlock(scriptText, settings.scriptLines, settings.maxLineChars),
        ['Answer "Approve once" or "Decline", or type guidance in "Other" (counts as Decline). "— not decided —" or an empty answer shows this dialog again.'],
    ];
    return blocks.map((block) => block.join('\n')).join('\n\n');
}

/** Full review file body: every detail of the request and the whole script (escaped, not capped). */
function reviewBody(request, rules, scriptText, hash, timeIso, agentFile) {
    const script = numberedScript(scriptText);
    const blocks = [
        ['Shell governor review (local file, never committed)', `Time: ${timeIso}`],
        [...headerLines(request, agentFile), `Agent type: ${oneLine(request.agentType) || 'unknown'}`, `Script SHA-256: ${hash}`],
        [`Task description (from the parent agent's dispatch): ${oneLine(request.taskDescription) || 'none given'}`],
        ...hiddenCharWarning(request),
        ruleLines(rules),
        isPlainObject(request.ratings) ? judgeLines(request.ratings) : ['AI judge: not consulted'],
        isPlainObject(request.ratings) ? ratingLines(request.ratings) : ['AI ratings: none'],
        factLines(request.facts),
        [callPurposeLine(request), claimLine(request)],
        [`Full script (${script.total} lines):`, ...script.shown],
    ];
    return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}

/** Fresh schema per display, so a host cannot mutate the next one. */
function buildSchema() {
    return {
        type: 'object',
        properties: {
            decision: {
                type: 'string',
                title: 'Decision',
                default: DECISION.NOT_DECIDED,
                oneOf: DECISION_OPTIONS.map((option) => ({ ...option })),
            },
        },
    };
}

/**
 * Turns one elicitation result into a final outcome, or null when the dialog must be shown again.
 * "approve_once" allows and "decline" denies. Any other text (typed in "Other") is guidance: it denies, and the trimmed
 * text is returned to the agent. Cancel, a decline action, missing content, "not_decided" and blank text re-show.
 */
function readAnswer(result) {
    if (!result || typeof result !== 'object' || result.action !== 'accept') return null;
    const content = result.content;
    if (!content || typeof content !== 'object') return null;
    const { decision } = content;
    if (typeof decision !== 'string') return null;
    if (decision === DECISION.APPROVE_ONCE) return { outcome: 'allow' };
    if (decision === DECISION.DECLINE) return { outcome: 'deny', reason: 'declined by user' };
    if (decision === DECISION.NOT_DECIDED) return null;
    const guidance = oneLine(decision).trim().slice(0, MAX_GUIDANCE_LENGTH).trim();
    return guidance ? { outcome: 'deny', reason: `declined by user: ${guidance}` } : null;
}

/**
 * Writes the review file with an exclusive create. A name already taken (same tick, same script) gets a -1, -2, …
 * suffix, so two requests never overwrite each other's review.
 */
function writeReview(reviewsDir, nowMs, hash, body) {
    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
    mkdirSync(reviewsDir, { recursive: true });
    for (let n = 0; n < MAX_REVIEW_NAME_TRIES; n += 1) {
        const path = join(reviewsDir, `${stamp}-${hash.slice(0, 12)}${n === 0 ? '' : `-${n}`}.txt`);
        try {
            writeFileSync(path, body, { encoding: 'utf8', flag: 'wx' });
            return path;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }
    throw Object.assign(new Error('no free review file name'), { code: 'EEXIST' });
}

/**
 * Removes review files older than `retentionDays` (by the stamp in their name, so only files this module wrote are
 * touched). Best-effort: failures are reported through onError and never stop the caller.
 */
function pruneReviews(reviewsDir, nowMs, retentionDays, onError) {
    let entries;
    try {
        entries = readdirSync(reviewsDir, { withFileTypes: true });
    } catch (err) {
        if (err.code !== 'ENOENT') onError(err);
        return;
    }
    const cutoff = nowMs - retentionDays * DAY_MS;
    for (const entry of entries) {
        const match = REVIEW_NAME.exec(entry.name);
        if (!match) continue;
        const createdMs = Date.parse(match[1].replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z'));
        if (!(createdMs < cutoff)) continue;
        try {
            unlinkSync(join(reviewsDir, entry.name));
        } catch (err) {
            onError(err);
        }
    }
}

/**
 * @param {object} options
 * @param {{ elicitation?: (params: object) => Promise<object> }} options.ui session.ui (only elicitation is used)
 * @param {{ now: () => number }} options.clock see the production notes at the top of this file
 * @param {string} options.reviewsDir absolute folder of the review files (created on first use)
 * @param {object | (() => object)} [options.config] governor settings, read on every ask; the `dialog` section is used
 * @param {{ ui?: { elicitation?: boolean } }} [options.capabilities] host capabilities; elicitation false = no UI
 * @param {string} [options.agentsDir] folder of the agent files; absent = no agent-file link
 * @param {number} [options.reviewRetentionDays] review files older than this are removed on each ask (default 14)
 * @param {number} [options.watchdogMs] limit for one display on a host that is not known interactive (default 600000)
 * @param {(err: unknown) => void} [options.onError] receives best-effort failures (pruning); default ignores them
 */
export function createDialog({
    ui,
    clock,
    reviewsDir,
    config = {},
    capabilities,
    agentsDir,
    reviewRetentionDays = DEFAULT_REVIEW_RETENTION_DAYS,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    onError = () => {},
} = {}) {
    if (!clock || typeof clock.now !== 'function') throw new TypeError('createDialog: clock is required');
    if (!reviewsDir) throw new TypeError('createDialog: reviewsDir is required');
    const retentionDays = Number.isFinite(reviewRetentionDays) && reviewRetentionDays >= 0
        ? reviewRetentionDays
        : DEFAULT_REVIEW_RETENTION_DAYS;
    const displayLimitMs = Number.isFinite(watchdogMs) && watchdogMs > 0 ? watchdogMs : DEFAULT_WATCHDOG_MS;

    return Object.freeze({
        /**
         * Asks the user about one script.
         * @param {object} request agentName, taskName, taskDescription, agentType, cwd, tool, script, ruleIds, ratings
         *   (values, confidence, whatItDoes, worstConsequence), facts, agentDescription, callPurpose, permissionMode
         * @returns {Promise<{outcome:'allow'} | {outcome:'deny', reason:string} | {outcome:'ask', reason:string} | {outcome:'hook-ask', reason:string}>}
         */
        async ask(request = {}) {
            pruneReviews(reviewsDir, clock.now(), retentionDays, onError);

            const unavailable = noUiReason(ui, capabilities, request);
            if (unavailable) return { outcome: 'ask', reason: unavailable };

            const settings = settingsOf(typeof config === 'function' ? config() : config);
            const script = String(request.script ?? '');
            const hash = hashScript(script);
            const nowMs = clock.now();
            const rules = normalizeRules(request.ruleIds);
            const agentFile = agentFileUrl(agentsDir, request.agentName);

            let reviewPath;
            try {
                reviewPath = writeReview(
                    reviewsDir,
                    nowMs,
                    hash,
                    reviewBody(request, rules, script, hash, new Date(nowMs).toISOString(), agentFile),
                );
            } catch (err) {
                return { outcome: 'hook-ask', reason: `approval dialog unavailable: review file not written (${err?.code ?? 'error'})` };
            }

            const message = buildMessage(request, rules, script, settings, fileUrl(reviewPath), agentFile);

            // Known interactive hosts wait without a limit; any other host gets the watchdog on every display.
            const watchdog = isKnownInteractive(capabilities) ? null : displayLimitMs;
            for (let displays = 1; displays <= MAX_DISPLAYS; displays += 1) {
                let result;
                try {
                    result = await withWatchdog(ui.elicitation({ message, requestedSchema: buildSchema() }), watchdog);
                } catch (err) {
                    if (err?.code === 'WATCHDOG') return { outcome: 'hook-ask', reason: err.message };
                    return { outcome: 'hook-ask', reason: `approval dialog failed: ${oneLine(err?.message ?? err)}` };
                }
                const outcome = readAnswer(result);
                if (outcome) return outcome;
            }
            return { outcome: 'hook-ask', reason: `approval dialog displayed ${MAX_DISPLAYS} times without an answer` };
        },
    });
}
