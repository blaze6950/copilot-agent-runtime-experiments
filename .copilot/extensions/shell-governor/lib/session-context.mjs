// Session context and freshness tracker for the shell governor. Pure module: session events and write targets come in
// through observe() and markWritten(); file stats come through an injected statFile. No SDK import, no I/O of its own
// beyond the default statFile (node:fs statSync).
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Freshness of a script path (AC-7). */
export const FRESHNESS = Object.freeze({ FRESH: 'fresh', PRE_EXISTING: 'pre-existing', MISSING: 'missing' });

/** Default memory caps; each one can be overridden through createSessionContext({ limits }). */
export const LIMITS = Object.freeze({
    maxAgents: 200,
    maxWrittenPaths: 2000,
    maxDispatchPrompts: 200,
    userMessages: 5,
    userMessageChars: 2000,
    dispatchPromptChars: 4000,
    taskNameChars: 200,
    taskDescriptionChars: 1000,
});

/** Name used when the main agent name cannot be resolved. */
export const MAIN_AGENT_FALLBACK = 'main';

/** How long a resolved main-agent name is reused before the resolver is asked again (ms). */
export const MAIN_AGENT_TTL_MS = 1000;

/** Name used for a subagent whose subagent.started event was not observed. */
export const UNKNOWN_SUBAGENT = 'unnamed-subagent';

/** Tools whose `path` argument names a file they write. */
const PATH_WRITE_TOOLS = new Set(['edit', 'create']);

/** File headers inside an apply_patch body (`*** Update File: <path>` and the Add/Delete variants). */
const PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/gm;

/**
 * Map with a size cap and least-recently-used eviction. get() refreshes recency; set() evicts the oldest entry.
 * @template V
 */
class BoundedMap {
    /** @type {number} */
    #max;
    /** @type {Map<string, V>} */
    #map = new Map();

    /** @param {number} max */
    constructor(max) {
        this.#max = max;
    }

    /** @param {string} key @returns {V | undefined} */
    get(key) {
        if (!this.#map.has(key)) return undefined;
        const value = this.#map.get(key);
        this.#map.delete(key);
        this.#map.set(key, value);
        return value;
    }

    /** @param {string} key @param {V} value */
    set(key, value) {
        this.#map.delete(key);
        this.#map.set(key, value);
        while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value);
    }
}

/** @param {string} fullPath @returns {{ mtimeMs: number } | null} */
function defaultStatFile(fullPath) {
    try {
        return { mtimeMs: statSync(fullPath).mtimeMs };
    } catch {
        return null;
    }
}

/** @param {unknown} value @returns {string | null} trimmed non-empty string or null */
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** @param {string} text @param {number} max */
function capText(text, max) {
    return text.length > max ? text.slice(0, max) : text;
}

/**
 * Extracts the file paths named by an apply_patch call. The arguments are either the patch text itself or an object
 * carrying it in `input` or `patch`.
 * @param {unknown} args
 * @returns {string[]}
 */
function patchPaths(args) {
    const text = typeof args === 'string' ? args : args?.input ?? args?.patch;
    if (typeof text !== 'string') return [];
    return [...text.matchAll(PATCH_FILE_HEADER)].map((m) => m[1]);
}

/**
 * Creates the session context: the subagent registry, dispatch prompts, recent user messages and the set of files
 * written in this session, plus the freshness rule for script paths.
 *
 * Session start: options.sessionStartMs when given; otherwise the timestamp of the first observed event; otherwise the
 * creation time. Working directory (for relative write paths): options.cwd when given; otherwise session.start's
 * data.context.cwd.
 *
 * @param {object} [options]
 * @param {number} [options.sessionStartMs] injected session start in epoch ms
 * @param {string} [options.cwd] working directory used to resolve relative paths
 * @param {(fullPath: string) => ({ mtimeMs: number } | null)} [options.statFile] file stat; null means missing
 * @param {() => Promise<string | null | undefined>} [options.resolveMainAgentName] runtime main-agent name resolver
 * @param {number} [options.mainAgentTtlMs] how long a resolved main-agent name is reused (default 1000 ms, measured with options.clock)
 * @param {() => number} [options.clock] epoch ms clock (used when no session start is known)
 * @param {boolean} [options.caseInsensitive] compare paths case-insensitively (default: true on win32)
 * @param {Partial<typeof LIMITS>} [options.limits] overrides for the memory caps
 * @returns {{
 *   observe: (event: object) => void,
 *   markWritten: (path: string) => void,
 *   scriptStatus: (fullPath: string) => string,
 *   agentName: (agentId: string | null | undefined) => Promise<string>,
 *   mainAgentName: () => Promise<string>,
 *   judgeContext: (agentId: string | null | undefined) => Promise<object>,
 *   callerOf: (agentId: string | null | undefined, hookAgentType?: string) => Promise<object>,
 *   recentUserMessages: () => string[],
 * }}
 */
export function createSessionContext(options = {}) {
    const limits = { ...LIMITS, ...(options.limits ?? {}) };
    const clock = options.clock ?? Date.now;
    const statFile = options.statFile ?? defaultStatFile;
    const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
    const resolveMainAgentName = options.resolveMainAgentName ?? null;
    const mainTtlMs = Number.isFinite(options.mainAgentTtlMs) && options.mainAgentTtlMs >= 0 ? options.mainAgentTtlMs : MAIN_AGENT_TTL_MS;
    const createdMs = clock();
    const startInjected = Number.isFinite(options.sessionStartMs);
    let startMs = startInjected ? options.sessionStartMs : null;
    let cwd = nonEmpty(options.cwd);
    const cwdInjected = cwd !== null;

    /** agentId → { name, type, description, toolCallId } */
    const agents = new BoundedMap(limits.maxAgents);
    /** toolCallId of a `task` call → dispatch prompt */
    const dispatchPrompts = new BoundedMap(limits.maxDispatchPrompts);
    /** toolCallId of a task call → { name, description } from its arguments; each trimmed and capped, null when blank */
    const dispatchTasks = new BoundedMap(limits.maxDispatchPrompts);
    /** normalized full path → true */
    const written = new BoundedMap(limits.maxWrittenPaths);
    /** last user messages, oldest first */
    const userMessages = [];

    let mainName = null;
    let mainNameAtMs = 0;
    let pendingMainName = null;

    const keyOf = (fullPath) => (caseInsensitive ? fullPath.toLowerCase() : fullPath);
    const currentStartMs = () => startMs ?? createdMs;
    const resolveAgainstCwd = (p) => (isAbsolute(p) ? resolve(p) : resolve(cwd ?? process.cwd(), p));

    /** @param {string} p */
    const markWrittenPath = (p) => {
        if (nonEmpty(p) === null) return;
        written.set(keyOf(resolveAgainstCwd(p)), true);
    };

    /** @param {string} toolName @param {string} toolCallId @param {unknown} args */
    const onToolStart = (toolName, toolCallId, args) => {
        if (toolName === 'task') {
            const prompt = nonEmpty(args?.prompt);
            if (prompt !== null && typeof toolCallId === 'string') {
                dispatchPrompts.set(toolCallId, capText(prompt, limits.dispatchPromptChars));
            }
            const name = nonEmpty(args?.name);
            const description = nonEmpty(args?.description);
            if ((name !== null || description !== null) && typeof toolCallId === 'string') {
                dispatchTasks.set(toolCallId, {
                    name: name === null ? null : capText(name, limits.taskNameChars),
                    description: description === null ? null : capText(description, limits.taskDescriptionChars),
                });
            }
        } else if (PATH_WRITE_TOOLS.has(toolName)) {
            markWrittenPath(args?.path ?? args?.file_path);
        } else if (toolName === 'apply_patch') {
            for (const p of patchPaths(args)) markWrittenPath(p);
        }
    };

    /** @param {object} event @param {object} data */
    const onSubagentStarted = (event, data) => {
        if (event.agentId === null || event.agentId === undefined) return;
        agents.set(event.agentId, {
            name: nonEmpty(data.agentName) ?? nonEmpty(data.agentDisplayName) ?? UNKNOWN_SUBAGENT,
            type: nonEmpty(data.agentType) ?? nonEmpty(data.agentName) ?? null,
            description: typeof data.agentDescription === 'string' ? data.agentDescription : '',
            toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : null,
        });
    };

    /** @param {unknown} content */
    const onUserMessage = (content) => {
        if (typeof content !== 'string') return;
        userMessages.push(capText(content, limits.userMessageChars));
        if (userMessages.length > limits.userMessages) userMessages.shift();
    };

    /**
     * Feeds one session event. Only session.start, subagent.started, tool.execution_start and user.message are read;
     * every other event type, including tool outputs and assistant text, is ignored and not stored.
     * @param {object} event
     */
    function observe(event) {
        if (!event || typeof event !== 'object') return;
        const data = event.data ?? {};
        if (!startInjected && startMs === null) {
            const t = Date.parse(event.timestamp);
            if (Number.isFinite(t)) startMs = t;
        }
        switch (event.type) {
            case 'session.start':
                if (!cwdInjected) cwd = nonEmpty(data.context?.cwd);
                break;
            case 'subagent.started':
                onSubagentStarted(event, data);
                break;
            case 'tool.execution_start':
                onToolStart(data.toolName, data.toolCallId, data.arguments);
                break;
            case 'user.message':
                onUserMessage(data.content);
                break;
            default:
                break;
        }
    }

    /**
     * Freshness of a script path: missing when absent; fresh when written in this session or modified at/after the
     * session start; otherwise pre-existing.
     * @param {string} fullPath
     * @returns {string}
     */
    function scriptStatus(fullPath) {
        const full = resolve(fullPath);
        const stat = statFile(full);
        if (!stat) return FRESHNESS.MISSING;
        if (written.get(keyOf(full)) === true) return FRESHNESS.FRESH;
        return stat.mtimeMs >= currentStartMs() ? FRESHNESS.FRESH : FRESHNESS.PRE_EXISTING;
    }

    /**
     * Main-agent name from the injected resolver. A successful name is cached for mainAgentTtlMs (default 1000), then
     * resolved again, so a switch of the agent (including back to the default agent, which has no name and falls back to
     * "main") is picked up. A failure or empty result yields the fallback and is retried on the next call. Concurrent calls
     * share one resolver call.
     * @returns {Promise<string>}
     */
    function mainAgentName() {
        const at = clock();
        if (mainName !== null && at >= mainNameAtMs && at - mainNameAtMs < mainTtlMs) return Promise.resolve(mainName);
        if (resolveMainAgentName === null) return Promise.resolve(MAIN_AGENT_FALLBACK);
        if (pendingMainName === null) {
            pendingMainName = (async () => {
                mainName = null;
                try {
                    const name = nonEmpty(await resolveMainAgentName());
                    if (name !== null) {
                        mainName = name;
                        mainNameAtMs = clock();
                        return name;
                    }
                } catch {
                    // fall through to the fallback; the next call retries
                }
                return MAIN_AGENT_FALLBACK;
            })().finally(() => {
                pendingMainName = null;
            });
        }
        return pendingMainName;
    }

    /** @param {string | null | undefined} agentId */
    async function agentName(agentId) {
        if (agentId === null || agentId === undefined) return mainAgentName();
        return agents.get(agentId)?.name ?? UNKNOWN_SUBAGENT;
    }

    /** @returns {string[]} copy of the last user messages, oldest first */
    function recentUserMessages() {
        return userMessages.slice();
    }

    /**
     * What the judge may see about the agent that issued a call: the subagent's dispatch prompt when known, otherwise
     * the user's recent messages. Never tool outputs or assistant text.
     * @param {string | null | undefined} agentId
     */
    async function judgeContext(agentId) {
        const name = await agentName(agentId);
        if (agentId !== null && agentId !== undefined) {
            const agent = agents.get(agentId);
            const prompt = agent?.toolCallId ? dispatchPrompts.get(agent.toolCallId) : undefined;
            if (prompt !== undefined) return { source: 'dispatch-prompt', agentName: name, dispatchPrompt: prompt };
        }
        return { source: 'user-messages', agentName: name, userMessages: recentUserMessages() };
    }

    /**
     * Caller of a call: name and type (the registry, else the hook's agentType, else "subagent"), its own description and
     * the task name and description of its dispatch. Never the dispatch prompt. The main agent (agentId null) has no task
     * and an empty description.
     * @param {string | null | undefined} agentId
     * @param {string} [hookAgentType] agentType from the hook input; used when the registry does not know the subagent
     * @returns {Promise<{ agentId: string|null, name: string, type: string, description: string, taskName: string|null, taskDescription: string|null }>}
     */
    async function callerOf(agentId, hookAgentType) {
        const id = typeof agentId === 'string' && agentId !== '' ? agentId : null;
        let name = await agentName(id);
        const hookType = nonEmpty(hookAgentType);
        if (id !== null && name === UNKNOWN_SUBAGENT && hookType) name = hookType;
        const entry = id === null ? undefined : agents.get(id);
        const type = id === null ? 'main' : entry?.type ?? hookType ?? 'subagent';
        const description = entry?.description ?? '';
        const task = entry?.toolCallId ? dispatchTasks.get(entry.toolCallId) : undefined;
        return {
            agentId: id,
            name,
            type,
            description,
            taskName: task?.name ?? null,
            taskDescription: task?.description ?? null,
        };
    }

    return {
        observe,
        markWritten: markWrittenPath,
        scriptStatus,
        agentName,
        mainAgentName,
        judgeContext,
        callerOf,
        recentUserMessages,
    };
}
