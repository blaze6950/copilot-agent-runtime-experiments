// Orchestration of the shell governor: one preToolUse hook call → decision. No SDK import and no console output (stdout of the
// extension process is the JSON-RPC channel); the session, worker, judge, dialog and audit come in through createGovernor(deps).
//
// Flow per call (D-7: independent calls run concurrently, no lock; the stages of one call run in sequence):
//   powershell                       → worker argv facts → engine → (AI: judge → Stage-3) → (ASK: dialog) → hook output
//   write_powershell                 → same pipeline on the `input` text, with three differences: the input may be keystrokes for
//                                      a program that is not PowerShell, so a parse error is an ASK (never an automatic deny);
//                                      empty or whitespace-only input and pure control keys ("{enter}", "{up}", "{ctrl+c}") are
//                                      no decision; an unreadable argument shape is an ASK. Arguments: { shellId, input, delay? }.
//   edit / create / apply_patch      → directory policy on every target path with write intent → (anything but SAFE: dialog);
//                                      edit / create with neither path nor file_path → no decision, unless another argument key
//                                      looks like a path → ask
//   view / grep / glob               → directory policy with read intent on every target path (lib/read-tools.mjs) → (ASK: dialog);
//                                      never the judge; every decision writes an audit line
//   every other tool                 → no decision
// Fail-closed (AC-14): every exception, a missing governor config or an unrecognised argument shape gives hook "ask" with a
// reason, never allow or deny (the one exception is the path-less edit / create above). The only automatic deny is a syntax
// error of a powershell call (AC-1); the other deny is the user's "Decline". After beginShutdown() every governed call is an
// ASK, so a late call never restarts the worker.
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERDICT } from './contracts.mjs';
import { createEngine } from './engine.mjs';
import { judgeRequestOf } from './judge-prompt.mjs';
import { combine } from './policy.mjs';
import { NOT_LOCAL_PATH, pathVerdict, repoRootOf, resolveFull } from './paths.mjs';
import { READ_TOOLS, evaluateReadTool } from './read-tools.mjs';
import { createSessionContext } from './session-context.mjs';

/** Tools the governor decides; every other tool passes through without a decision. */
const POWERSHELL_TOOL = 'powershell';
const WRITE_SHELL_TOOL = 'write_powershell';
const FILE_TOOLS = new Set(['edit', 'create', 'apply_patch']);

/** How long the governor reuses a config snapshot (ms); matches the engine's default. 0 = check the config on every call. */
export const DEFAULT_SETTINGS_TTL_MS = 1000;
const MAX_REASON_CHARS = 600;

/**
 * Patch headers are matched after trimming leading whitespace and tolerate a missing space after "***", so a header the
 * real patch tool might still accept is never skipped. A line that starts with "***" and is none of these is an unknown shape.
 */
const PATCH_FILE_HEADER = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/;
const PATCH_MOVE_HEADER = /^\*\*\*\s*Move to:\s*(.+?)\s*$/;
const PATCH_MARKER = /^\*\*\*\s*(?:Begin Patch|End Patch|End of File)\s*$/;
/** Argument keys that look like a path: an edit / create without `path` or `file_path` but with such a key asks, never passes. */
const PATH_LIKE_KEY = Object.freeze(/path|target|dest|folder|dir|location|filename|file_name/i);
/** Argument keys that name a file or location by their exact name (case-insensitive); a substring such as `file` in `file_text` does not count. */
const PATH_KEY_EXACT = Object.freeze(/^(file|uri|url|src|source)$/i);
/** Key presses a write_powershell input may consist of (no text): `{enter}`, `{up}`, `{ctrl+c}`, ... */
const CONTROL_KEY = /\{(?:(?:ctrl|alt|shift)\+[a-z]|enter|return|up|down|left|right|home|end|pageup|pagedown|tab|esc|escape|backspace|bs|delete|del|insert|ins|space|f(?:[1-9]|1[0-2]))\}/gi;

const oneLine = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text) => (text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text);
const hookAsk = (reason) => ({ permissionDecision: 'ask', permissionDecisionReason: clip(oneLine(reason)) });
const hookDeny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: clip(oneLine(reason)) });
const hookAllow = () => ({ permissionDecision: 'allow', permissionDecisionReason: 'approved by the user in the shell governor dialog' });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Working directory of a hook call, or null when the hook input has none. */
const cwdOf = (input) => (typeof input.workingDirectory === 'string' && input.workingDirectory !== '' ? input.workingDirectory : null);
/** The call purpose the agent states (toolArgs.description). Shown to the user as unverified; sent to the judge as an unverified claim that may only support task fit (D-37). */
const callPurposeOf = (input) => (isPlainObject(input.toolArgs) && typeof input.toolArgs.description === 'string' ? input.toolArgs.description : undefined);

/** Short, script-free description of an internal failure. */
function describeError(err) {
    const message = oneLine(err?.message ?? err);
    if (err?.name === 'PwshClientError') return `worker ${err.code ?? 'error'}: ${message}`;
    if (err?.name === 'EngineError') return `engine ${err.code ?? 'error'}: ${message}`;
    return `${oneLine(err?.name ?? 'Error')}: ${message}`;
}

/**
 * Target paths of an edit, create or apply_patch call.
 * An edit or create whose arguments have neither `path` nor `file_path` names no file target (`noPath: true`), unless another
 * argument key looks like a path; then the target is unreadable (`problem: 'path-like key without path'`).
 * @param {string} tool
 * @param {unknown} args the hook's toolArgs
 * @returns {{ targets: Array<{ raw: string, intent: 'write' | 'delete' }>, problem?: string, noPath?: boolean }}
 */
export function fileTargets(tool, args) {
    if (tool === 'edit' || tool === 'create') {
        if (!isPlainObject(args)) return { targets: [], problem: 'arguments are not an object' };
        if (args.path === undefined && args.file_path === undefined) {
            if (Object.keys(args).some((key) => PATH_LIKE_KEY.test(key) || PATH_KEY_EXACT.test(key))) return { targets: [], problem: 'path-like key without path' };
            return { targets: [], problem: 'no path key', noPath: true };
        }
        const raws = [args.path, args.file_path].filter((v) => v !== undefined);
        if (raws.some((v) => typeof v !== 'string' || v.trim() === '')) {
            return { targets: [], problem: 'no usable path argument' };
        }
        return { targets: [...new Set(raws)].map((raw) => ({ raw, intent: 'write' })) };
    }
    const text = typeof args === 'string' ? args : isPlainObject(args) ? args.input ?? args.patch : undefined;
    if (typeof text !== 'string') return { targets: [], problem: 'no patch text' };
    const targets = [];
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.trimStart();
        if (!line.startsWith('***')) continue;
        const header = PATCH_FILE_HEADER.exec(line);
        if (header) {
            targets.push({ raw: header[2], intent: header[1] === 'Delete' ? 'delete' : 'write' });
            continue;
        }
        const move = PATCH_MOVE_HEADER.exec(line);
        if (move) {
            targets.push({ raw: move[1], intent: 'write' });
            continue;
        }
        if (!PATCH_MARKER.test(line)) return { targets: [], problem: 'unrecognised patch header' };
    }
    return targets.length > 0 ? { targets } : { targets: [], problem: 'no file header in the patch' };
}

/**
 * @typedef {object} GovernorDeps
 * @property {{ get: () => { governor: any, enabled: boolean }, agentPolicy: (agent: string) => { directories: object[] } }} config config store
 * @property {{ argv: Function }} [worker] facts provider used to build the default engine
 * @property {{ judge: (request: object) => Promise<object> }} judge
 * @property {{ ask: (request: object) => Promise<{ outcome: string, reason?: string }> }} dialog
 * @property {{ write: (entry: object) => boolean }} audit
 * @property {{ evaluate: (call: object) => Promise<object>, directoryPolicyFor: (call: { agent: string, cwd: string | null }) => object }} [engine] replaces the default engine (tests); file and read tools need directoryPolicyFor
 * @property {ReturnType<typeof createSessionContext>} [sessionContext] default: a new session context
 * @property {() => Promise<string | null | undefined>} [resolveMainAgentName] runtime lookup of the main agent's name
 * @property {string | (() => string | null | undefined)} [sessionId] id of the session (for `{sessionId}` directory rules and the audit)
 * @property {string} [home] user home (default os.homedir())
 * @property {string} [copilotHome] default `<home>\.copilot`
 * @property {string} [temp] default $TEMP
 * @property {(path: string) => boolean} [exists] existence check for repo roots (default fs.existsSync)
 * @property {number} [settingsTtlMs] reuse time of the config snapshot (default 1000; 0 = every call)
 * @property {() => number} [now] epoch-ms clock for the snapshot age (default Date.now)
 * @property {(err: unknown, context?: string) => void} [onError] receives internal failures (never script text); must not throw
 */

/**
 * Creates the governor.
 * @param {GovernorDeps} deps
 * @returns {{ onPreToolUse: (input: object) => Promise<object | undefined>, onEvent: (event: object) => void, beginShutdown: () => void }}
 */
export function createGovernor(deps = {}) {
    const { config, judge, dialog, audit, worker } = deps;
    if (!config || typeof config.get !== 'function' || typeof config.agentPolicy !== 'function') throw new TypeError('createGovernor: config is required');
    if (!judge || typeof judge.judge !== 'function') throw new TypeError('createGovernor: judge is required');
    if (!dialog || typeof dialog.ask !== 'function') throw new TypeError('createGovernor: dialog is required');
    if (!audit || typeof audit.write !== 'function') throw new TypeError('createGovernor: audit is required');

    const home = deps.home ?? homedir();
    const copilotHome = deps.copilotHome ?? join(home, '.copilot');
    const temp = deps.temp ?? process.env.TEMP ?? process.env.TMP ?? tmpdir();
    const exists = deps.exists ?? existsSync;
    const now = deps.now ?? (() => Date.now());
    const ttlMs = Number.isFinite(deps.settingsTtlMs) && deps.settingsTtlMs >= 0 ? deps.settingsTtlMs : DEFAULT_SETTINGS_TTL_MS;
    const sessionIdOf = () => {
        const id = typeof deps.sessionId === 'function' ? deps.sessionId() : deps.sessionId;
        return typeof id === 'string' && id !== '' ? id : undefined;
    };

    const sessionContext = deps.sessionContext ?? createSessionContext({ resolveMainAgentName: deps.resolveMainAgentName });
    const engine = deps.engine ?? createEngine({
        config, worker, session: sessionContext, sessionId: () => sessionIdOf() ?? null, home, copilotHome, temp, exists,
        settingsTtlMs: ttlMs, now,
    });

    const report = (err, context) => {
        try {
            deps.onError?.(err, context);
        } catch {
            // a failing error hook must never change a decision
        }
    };

    // ---- config snapshot: config.get() stats every config file, so a snapshot is reused for ttlMs ----
    let snapshot = null;
    let shuttingDown = false;
    function settings() {
        const at = now();
        if (!snapshot || at - snapshot.at >= ttlMs || at < snapshot.at) snapshot = { at, value: config.get() };
        return snapshot.value;
    }

    // ---- what the session events tell about the modes (agents: session context) ----
    let agentMode = null;

    /** @param {object} event */
    function onEvent(event) {
        try {
            sessionContext.observe(event);
            const data = event?.data ?? {};
            switch (event?.type) {
                case 'session.mode_changed':
                    agentMode = typeof data.newMode === 'string' ? data.newMode : null;
                    break;
                default:
                    break;
            }
        } catch (err) {
            report(err, 'onEvent');
        }
    }

    const permissionMode = () => (agentMode === 'autopilot' ? 'autopilot' : 'manual');

    /** Caller of a call (session context): name, type, own description and the task of its dispatch; never the dispatch prompt. */
    async function identify(input) {
        return sessionContext.callerOf(
            typeof input.agentId === 'string' && input.agentId !== '' ? input.agentId : null,
            typeof input.agentType === 'string' ? input.agentType : undefined,
        );
    }

    const auditWrite = (entry) => {
        try {
            audit.write({ session: sessionIdOf()?.slice(0, 8), ...entry });
        } catch (err) {
            report(err, 'audit');
        }
    };

    /** Shows the dialog and maps its outcome to hook output. A dialog failure is an ASK, never an allow. */
    async function askUser(request, auditBase) {
        let outcome;
        try {
            outcome = await dialog.ask({ ...request, permissionMode: permissionMode() });
        } catch (err) {
            report(err, 'dialog');
            auditWrite({ ...auditBase, dialogOutcome: 'hook-ask' });
            return { hook: hookAsk(`approval dialog failed: ${describeError(err)}`), approved: false, denied: false };
        }
        const kind = outcome?.outcome;
        auditWrite({ ...auditBase, dialogOutcome: kind });
        if (kind === 'allow') return { hook: hookAllow(), approved: true, denied: false };
        if (kind === 'deny') return { hook: hookDeny(outcome.reason || 'declined by user'), approved: false, denied: true };
        if (kind === 'ask' || kind === 'hook-ask') return { hook: hookAsk(outcome.reason || 'the approval dialog could not decide'), approved: false, denied: false };
        return { hook: hookAsk('the approval dialog returned an unknown outcome'), approved: false, denied: false };
    }

    const explained = (rule) => ({ id: String(rule.rule ?? rule.id), explanation: String(rule.reason ?? rule.detail ?? rule.explanation ?? '') });

    // ---- powershell and write_powershell ----
    async function decidePowershell(input, current, tool) {
        const writeShell = tool === WRITE_SHELL_TOOL;
        const text = isPlainObject(input.toolArgs) ? input.toolArgs[writeShell ? 'input' : 'command'] : undefined;
        if (typeof text !== 'string') return hookAsk(`the ${tool} call has no ${writeShell ? 'input' : 'command'} text the governor can read`);
        if (writeShell && text.replace(CONTROL_KEY, '').trim() === '') return undefined; // nothing to execute: empty input or key presses only
        const script = text;
        const who = await identify(input);
        const cwd = cwdOf(input);

        const result = await engine.evaluate({ script, cwd, agent: who.name });
        const base = { agent: who.name, tool, script, verdict: result.verdict, ruleIds: result.rules.map((r) => r.rule) };

        if (result.verdict === VERDICT.SYNTAX) {
            auditWrite(base);
            if (writeShell) {
                // the input may be keystrokes for a program that is not PowerShell: never an automatic deny
                return hookAsk(`the write_powershell input does not parse as PowerShell (it may be keystrokes for another program), so it needs your decision. ${result.reason}`);
            }
            return hookDeny(result.reason);
        }

        let judgeOutcome;
        if (result.verdict === VERDICT.AI) judgeOutcome = await runJudge(input, script, result, who, cwd, current);
        const policy = combine(result, judgeOutcome, current.governor.stage3);
        const ratings = judgeOutcome?.outcome === 'ratings' ? judgeOutcome.ratings : undefined;
        const withJudge = { ...base, ratings, judgeLatencyMs: judgeOutcome?.outcome === 'ratings' ? judgeOutcome.latencyMs : undefined };

        if (policy.decision === 'ALLOW') {
            auditWrite(withJudge);
            markEngineWrites(result);
            return undefined;
        }

        // ASK (a DENY from the policy is only possible for SYNTAX, handled above; anything else is treated as ASK)
        const ruleIds = result.rules.map(explained);
        if (result.verdict === VERDICT.AI) {
            ruleIds.push(ratings
                ? { id: 'AI-STAGE3', explanation: policy.reasons.join('; ') }
                : { id: 'AI-JUDGE-UNAVAILABLE', explanation: policy.reasons.join('; ') });
        }
        const answer = await askUser({
            agentName: who.name,
            agentType: who.type,
            taskName: who.taskName,
            taskDescription: who.taskDescription,
            cwd: cwd ?? '',
            tool,
            script,
            ruleIds,
            ratings,
            facts: result.facts,
            agentDescription: who.description,
            callPurpose: callPurposeOf(input),
        }, withJudge);
        if (!answer.denied) markEngineWrites(result);
        return answer.hook;
    }

    /** Judge call; a throwing judge becomes an ASK outcome. */
    async function runJudge(input, script, result, who, cwd, current) {
        try {
            const context = await sessionContext.judgeContext(who.agentId);
            const codeRoots = Array.isArray(current.governor?.codeRoots) ? current.governor.codeRoots : [];
            return await judge.judge(judgeRequestOf({
                script,
                facts: result.facts,
                caller: who,
                context,
                callPurpose: callPurposeOf(input),
                cwdClass: repoRootOf(cwd, { codeRoots, exists }) ? 'repo' : 'other',
            }));
        } catch (err) {
            report(err, 'judge');
            return { outcome: 'ask', reason: `judge failed: ${describeError(err)}` };
        }
    }

    /**
     * A script that writes may create the scripts it runs later: the paths it names count as written in this session.
     * The facts do not say which path is the write target, so all of them are marked; that only ever makes a script
     * "fresh" (stricter), never "pre-existing".
     */
    function markEngineWrites(result) {
        const facts = result.facts;
        if (!Array.isArray(facts?.intents) || !facts.intents.includes('write') || !Array.isArray(facts.paths)) return;
        for (const path of facts.paths) sessionContext.markWritten(path);
    }

    // ---- edit / create / apply_patch ----
    async function decideFileTool(tool, input) {
        const who = await identify(input);
        const parsed = fileTargets(tool, input.toolArgs);
        if (parsed.noPath) return undefined; // edit/create without any path-like key: no file target, so no decision and no audit line
        const base = { agent: who.name, tool, verdict: VERDICT.ASK };
        if (parsed.problem) {
            auditWrite({ ...base, script: `${tool}: unrecognised arguments`, ruleIds: ['FILE-ARGS-UNRECOGNISED'] });
            return hookAsk(`the ${tool} call has an argument shape the governor does not recognise (${parsed.problem}); the target paths cannot be checked`);
        }

        const cwd = cwdOf(input);
        const policy = engine.directoryPolicyFor({ agent: who.name, cwd });

        const findings = [];
        const resolved = [];
        for (const target of parsed.targets) {
            const full = resolveFull(target.raw, cwd, { home });
            if (full === null || NOT_LOCAL_PATH.test(full)) {
                findings.push({ id: 'FILE-TARGET-UNRESOLVED', explanation: `the ${target.intent} target is not a constant local path` });
                resolved.push(`unresolved: ${target.raw}`);
                continue;
            }
            resolved.push(full);
            const verdict = pathVerdict(full, target.intent, policy);
            // a file tool has no judge: every non-SAFE directory verdict (protected, secret, outside every rule, not allowed) is a dialog
            if (verdict.verdict !== VERDICT.SAFE) for (const id of verdict.ruleIds) findings.push({ id, explanation: verdict.reason });
        }

        if (findings.length === 0) {
            for (const target of resolved) if (!target.startsWith('unresolved: ')) sessionContext.markWritten(target);
            return undefined;
        }

        const intents = [...new Set(parsed.targets.map((t) => t.intent))];
        const answer = await askUser({
            agentName: who.name,
            agentType: who.type,
            taskName: who.taskName,
            taskDescription: who.taskDescription,
            cwd: cwd ?? '',
            tool,
            script: parsed.targets.map((t, i) => `${tool} (${t.intent}): ${resolved[i]}`).join('\n'),
            ruleIds: findings,
            facts: { classes: intents.includes('delete') ? ['write', 'delete'] : ['write'], intents, paths: resolved.filter((r) => !r.startsWith('unresolved: ')), notes: [] },
            agentDescription: who.description,
            callPurpose: callPurposeOf(input),
        }, { ...base, script: resolved.join('\n'), ruleIds: findings.map((f) => f.id) });
        if (!answer.denied) for (const target of resolved) if (!target.startsWith('unresolved: ')) sessionContext.markWritten(target);
        return answer.hook;
    }

    /**
     * Decision of one view, grep or glob call (D-12, D-39): directory policy with read intent only. An AI verdict asks (read tools
     * never reach the judge); an unrecognised argument shape asks; every decision writes an audit line.
     * @param {string} tool
     * @param {object} input PreToolUseHookInput
     * @returns {Promise<object | undefined>}
     */
    async function decideReadTool(tool, input) {
        const who = await identify(input);
        const cwd = cwdOf(input);
        const policy = engine.directoryPolicyFor({ agent: who.name, cwd });
        const decision = evaluateReadTool({ tool, args: input.toolArgs, cwd, policy, home });
        const auditScript = decision.targets.length ? decision.targets.join('\n') : `${tool}: unrecognised arguments`;
        if (decision.verdict === VERDICT.SAFE) {
            auditWrite({ agent: who.name, tool, script: auditScript, verdict: VERDICT.SAFE, ruleIds: decision.ruleIds });
            return undefined;
        }
        const answer = await askUser({
            agentName: who.name,
            agentType: who.type,
            taskName: who.taskName,
            taskDescription: who.taskDescription,
            cwd: cwd ?? '',
            tool,
            script: decision.targets.length ? decision.targets.map((t) => `${tool} (read): ${t}`).join('\n') : auditScript,
            ruleIds: decision.findings,
            facts: { classes: ['read'], intents: ['read'], paths: decision.targets.filter((t) => !t.startsWith('unresolved: ')), notes: [] },
            agentDescription: who.description,
            callPurpose: callPurposeOf(input),
        }, { agent: who.name, tool, verdict: VERDICT.ASK, script: auditScript, ruleIds: decision.ruleIds });
        return answer.hook;
    }

    /**
     * The preToolUse hook. Returns undefined for "no decision", otherwise hook output (allow after an explicit approval,
     * deny for a syntax error or a decline, ask for everything the governor cannot or may not decide).
     * @param {object} input PreToolUseHookInput
     * @returns {Promise<{ permissionDecision: 'allow' | 'deny' | 'ask', permissionDecisionReason?: string } | undefined>}
     */
    async function onPreToolUse(input) {
        const tool = typeof input?.toolName === 'string' ? input.toolName.toLowerCase() : '';
        const shell = tool === POWERSHELL_TOOL || tool === WRITE_SHELL_TOOL;
        const read = READ_TOOLS.has(tool);
        if (!shell && !read && !FILE_TOOLS.has(tool)) return undefined;
        if (shuttingDown) return hookAsk('shell governor is shutting down; this call cannot be checked');
        try {
            const current = settings();
            if (!current.governor) {
                return hookAsk('shell governor: governor config unavailable (no valid governor.json has been loaded), so this call cannot be checked');
            }
            if (current.enabled === false) return undefined;
            if (shell) return await decidePowershell(input, current, tool);
            if (read) return await decideReadTool(tool, input);
            return await decideFileTool(tool, input);
        } catch (err) {
            report(err, 'onPreToolUse');
            auditWrite({ tool, agent: undefined, verdict: VERDICT.ASK, ruleIds: ['GOVERNOR-ERROR'] });
            return hookAsk(`shell governor internal error (${describeError(err)}); asking instead of deciding`);
        }
    }

    /** Marks the governor as shutting down: from now on governed calls are an ASK and nothing starts the worker again. */
    function beginShutdown() {
        shuttingDown = true;
    }

    return Object.freeze({ onPreToolUse, onEvent, beginShutdown });
}
