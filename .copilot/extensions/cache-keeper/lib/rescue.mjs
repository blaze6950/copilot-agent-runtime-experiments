// Rescue of a root turn that is blocked in a long sync tool: choose which task to promote to the background, and do it.
// Promoting the blocking task lets the turn continue before the prompt cache expires.

const SHELL_TOOLS = /^(powershell|bash|shell)$/i;

/** A sync agent task belongs to the root when its toolCallId is one of the root's running tools. */
const isRootAgentTask = (task, tools) => task?.type === "agent" && tools.some((t) => t.toolCallId === task.toolCallId);

/**
 * Choose the task to promote. Shell ids restart per agent (root "0" and a sub-agent's "0" can coexist),
 * so a shell is promoted only when unambiguous.
 * @param {object[]} candidates promotable tasks
 * @param {Array<{toolCallId: string, name: string, shellId?: string|null}>} tools running root tools
 * @returns {{task: object|null, ambiguous?: boolean}}
 */
export function pickRootTask(candidates, tools) {
    const agent = candidates.find((t) => isRootAgentTask(t, tools));
    if (agent) return { task: agent };
    const rootShells = tools.filter((t) => SHELL_TOOLS.test(t.name));
    if (!rootShells.length) return { task: null };
    const shells = candidates.filter((t) => t.type === "shell");
    const byId = shells.filter((t) => rootShells.some((r) => r.shellId && r.shellId === t.id));
    if (byId.length === 1) return { task: byId[0] };
    if (shells.length === 1 && rootShells.length === 1) return { task: shells[0] };
    return { task: null, ambiguous: shells.length > 1 };
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./transport.mjs").createTransport>} deps.transport
 * @param {(msg: string) => void} deps.log
 * @param {{rescues: number, unrescued: number}} deps.stats counters, updated here
 * @param {() => import("./contracts.mjs").TrackerState} deps.getState
 * @param {() => number|null} deps.secLeft seconds of cache left (for the log)
 * @returns {() => Promise<void>} rescue: promote the root's blocking task if it can be identified
 */
export function createRescue({ transport, log, stats, getState, secLeft }) {
    return async function rescue() {
        const tools = [...getState().inFlight.entries()].map(([toolCallId, t]) => ({ toolCallId, ...t }));
        const names = tools.map((t) => t.name).join(",") || "none";
        const candidates = await transport.promotableCandidates();
        const { task, ambiguous } = pickRootTask(candidates, tools);
        if (ambiguous) log("rescue: several sync shells and no unique match; not promoting");
        log(`rescue candidates=[${candidates.map((t) => `${t.type}:${t.id}:${t.toolCallId ?? "-"}:${t.executionMode ?? "?"}`).join(",")}] rootTools=[${tools.map((t) => `${t.name}:${t.toolCallId}${t.shellId ? ":" + t.shellId : ""}`).join(",")}]`);
        if (task && (await transport.promote(task.id))) {
            stats.rescues++;
            log(`rescue: promoted ${task.type}:${task.id} toolCallId=${task.toolCallId ?? "-"} tools=${names} cacheLeft=${secLeft()}s`);
            return;
        }
        stats.unrescued++;
        log(`rescue impossible: waiting in ${names}; promotable=${task ? `${task.type}:${task.id}` : "none"}; candidates=${candidates.length} cacheLeft=${secLeft()}s`);
    };
}
