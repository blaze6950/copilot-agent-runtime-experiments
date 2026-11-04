// Deterministic decision for the read tools view, grep and glob (D-12, D-39): directory path rules only, no AI judge.
// A grep (content search) whose search root reaches a secret rule base asks (READ-SECRET-ROOT-SEARCH, stage 2);
// a glob with such a root is allowed and only counted (secretRootRuleIds); view is unchanged.
// Shared by lib/governor.mjs and tools/replay.mjs. No SDK import, no console output.

import { homedir } from 'node:os';
import { INTENT, VERDICT } from './contracts.mjs';
import { NOT_LOCAL_PATH, pathVerdict, resolveFull, secretBasesReached } from './paths.mjs';

/** Tools decided here (their paths are checked; their patterns and globs are never read as paths). */
export const READ_TOOLS = new Set(['view', 'grep', 'glob']);

/** Finding id: the call's arguments have a shape this module does not recognise, so no path can be checked. */
export const READ_ARGS_RULE = 'READ-ARGS-UNRECOGNISED';

/** Finding id: a read target is not a constant local path (URL, registry, UNC, provider or dynamic value). */
export const READ_TARGET_RULE = 'READ-TARGET-UNRESOLVED';

/** Finding id: a grep (content search) whose search root contains a secret rule base (stage 2). */
export const READ_SECRET_ROOT_RULE = 'READ-SECRET-ROOT-SEARCH';

const SECRET_RULE = 'DIR-SECRET';
const SEARCH_TOOLS = new Set(['grep', 'glob']);
/** Tools that read file contents: a search root that reaches a secret rule base asks; glob lists names only and is counted. */
const CONTENT_SEARCH_TOOLS = new Set(['grep']);

/**
 * Decision for one read tool call.
 * @typedef {object} ReadToolDecision
 * @property {'SAFE'|'ASK'} verdict
 * @property {string[]} ruleIds distinct ids of every target verdict when SAFE, or of the findings when ASK
 * @property {Array<{ id: string, explanation: string }>} findings one entry per reason to ask (empty when SAFE)
 * @property {string[]} targets resolved path per target, or `unresolved: <raw value>`
 * @property {string[]} secretRootRuleIds secret rule ids a search root reaches (grep: asks with READ-SECRET-ROOT-SEARCH; glob: counted only)
 */

const isPathText = (value) => typeof value === 'string' && value.trim() !== '';
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const unique = (values) => [...new Set(values)];

/**
 * Raw path values one read tool call names, or the reason its arguments are not recognised.
 * `view` takes `path`. `grep` and `glob` take `paths` (string or non-empty list) and/or `path`: every key given is checked
 * (union, distinct), and the working directory is the root only when neither key is given. `pattern` and `glob` are never read as paths.
 * @param {string} tool
 * @param {unknown} args
 * @param {string|null|undefined} cwd
 * @returns {{ raws: string[] } | { problem: string }}
 */
export function readTargets(tool, args, cwd) {
    if (!isPlainObject(args)) return { problem: 'arguments are not an object' };
    if (tool === 'view') {
        return isPathText(args.path) ? { raws: [args.path] } : { problem: 'no usable path argument' };
    }
    if (tool === 'grep' || tool === 'glob') {
        const raws = [];
        if (args.paths !== undefined) {
            const listed = pathList(args.paths);
            if (listed === null) return { problem: 'paths is neither a path nor a list of paths' };
            raws.push(...listed);
        }
        if (args.path !== undefined) {
            if (!isPathText(args.path)) return { problem: 'no usable path argument' };
            raws.push(args.path);
        }
        if (raws.length > 0) return { raws: unique(raws) };
        if (isPathText(cwd)) return { raws: [cwd] };
        return { problem: 'no search root and no working directory' };
    }
    return { problem: 'not a read tool' };
}

/** A non-blank path string as a one-entry list, a non-empty list of non-blank strings as itself, else null. */
function pathList(value) {
    if (isPathText(value)) return [value];
    if (Array.isArray(value) && value.length > 0 && value.every(isPathText)) return [...value];
    return null;
}

/** Decision that asks because the arguments of the call are not recognised. */
function unrecognisedArgs(tool, problem) {
    return {
        verdict: VERDICT.ASK,
        ruleIds: [READ_ARGS_RULE],
        findings: [{ id: READ_ARGS_RULE, explanation: `the ${tool} call has an argument shape the governor does not recognise (${problem}); the read paths cannot be checked` }],
        targets: [],
        secretRootRuleIds: [],
    };
}

/**
 * Decision of one view, grep or glob call. Each target is judged for a read by its directory verdict; an AI verdict becomes ASK
 * because read tools never reach the AI judge. For grep, a search root that reaches a secret rule base asks (READ-SECRET-ROOT-SEARCH);
 * for glob, it is only counted (secretRootRuleIds).
 * @param {{ tool: string, args: unknown, cwd?: string|null, policy: object, home?: string }} input
 *   `policy` is the compiled directory policy of the agent for this call (see directoryPolicyFor in engine.mjs)
 * @returns {ReadToolDecision}
 */
export function evaluateReadTool({ tool, args, cwd = null, policy, home = homedir() }) {
    const located = readTargets(tool, args, cwd);
    if ('problem' in located) return unrecognisedArgs(tool, located.problem);

    const findings = [];
    const safeRuleIds = [];
    const targets = [];
    const secretRootRuleIds = [];
    for (const raw of located.raws) {
        const full = resolveFull(raw, cwd, { home });
        if (full === null || NOT_LOCAL_PATH.test(full)) {
            findings.push({ id: READ_TARGET_RULE, explanation: 'the read target is not a constant local path' });
            targets.push(`unresolved: ${raw}`);
            continue;
        }
        targets.push(full);
        const verdict = pathVerdict(full, INTENT.READ, policy);
        if (verdict.verdict === VERDICT.SAFE) {
            safeRuleIds.push(...verdict.ruleIds);
        } else if (verdict.verdict === VERDICT.AI) {
            for (const id of verdict.ruleIds) findings.push({ id, explanation: `${verdict.reason}; read tools never go to the AI judge, so this asks` });
        } else {
            for (const id of verdict.ruleIds) findings.push({ id, explanation: verdict.reason });
        }
        if (SEARCH_TOOLS.has(tool) && verdict.ruleIds[0] !== SECRET_RULE) {
            secretRootRuleIds.push(...secretBasesReached(full, policy));
        }
    }

    const reachedIds = unique(secretRootRuleIds);
    if (CONTENT_SEARCH_TOOLS.has(tool) && reachedIds.length > 0) {
        findings.push({ id: READ_SECRET_ROOT_RULE, explanation: `grep searches file contents under a folder that contains secret locations (${reachedIds.join(', ')}); search a narrower folder that contains no secret location` });
    }

    const asks = findings.length > 0;
    return {
        verdict: asks ? VERDICT.ASK : VERDICT.SAFE,
        ruleIds: unique(asks ? findings.map((finding) => finding.id) : safeRuleIds),
        findings,
        targets,
        secretRootRuleIds: reachedIds,
    };
}
