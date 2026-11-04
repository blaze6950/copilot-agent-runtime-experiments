// Test doubles for the cache-keeper: a timer-based fake clock, a fake CLI session and a fake transport.
export const T0 = Date.parse("2026-10-18T00:00:00Z");
export const flush = () => new Promise((r) => setImmediate(r));

/** Fake clock with virtual timers; `advance(ms)` fires every due timer in order and lets async callbacks settle. */
export function fakeClock() {
    let t = T0, seq = 0; const timers = new Map();
    return {
        now: () => t,
        timerCount: () => timers.size,
        setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { at: t + ms, f }); return id; },
        clearTimeout: (id) => timers.delete(id),
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); t = due[1].at; due[1].f(); await flush(); await flush();
            }
            t = end;
        },
    };
}

/**
 * Fake CLI session. Options: agent, tasks, promotable, pending, processing, `items` (extra queued items), `stuckCommands`
 * (enqueued commands stay in the queue like in the CLI's blocked state) and `fail` (rpc names that throw, e.g. "queue.sendNow").
 * Every call is recorded in `calls`.
 */
export function fakeSession(o = {}) {
    const s = {
        agent: o.agent ?? "1main", tasks: o.tasks ?? [], promotable: o.promotable ?? null, pending: o.pending ?? false,
        processing: o.processing ?? false, fail: new Set(o.fail ?? []), items: [...(o.items ?? [])], stuckCommands: o.stuckCommands ?? false,
        calls: { sends: [], enqueued: [], promoted: [], removed: [], sentNow: [] },
    };
    const dropItem = (id) => { s.items = s.items.filter((i) => i.id !== id); if (id === "p1") s.pending = false; };
    const guard = (name, fn) => async (arg) => { if (s.fail.has(name)) throw new Error(`${name} failed`); return fn(arg); };
    s.send = guard("send", async ({ prompt }) => { s.calls.sends.push(prompt); });
    s.rpc = {
        agent: { getCurrent: guard("agent.getCurrent", async () => ({ agent: { name: s.agent } })) },
        metadata: { isProcessing: guard("metadata.isProcessing", async () => ({ processing: s.processing })) },
        queue: {
            pendingItems: guard("queue.pendingItems", async () => ({ items: [...(s.pending ? [{ id: "p1", kind: "message", displayText: "queued" }] : []), ...s.items], steeringMessages: [] })),
            removeAt: guard("queue.removeAt", async ({ id }) => { s.calls.removed.push(id); dropItem(id); return { removed: true }; }),
            sendNow: guard("queue.sendNow", async ({ id }) => { s.calls.sentNow.push(id); dropItem(id); return { steered: true }; }),
        },
        commands: {
            enqueue: guard("commands.enqueue", async ({ command }) => {
                s.calls.enqueued.push(command);
                const queueId = `q${s.calls.enqueued.length}`;
                if (s.stuckCommands) s.items.push({ id: queueId, kind: "command", displayText: command });
                return { queued: true, queueId };
            }),
        },
        tasks: {
            list: guard("tasks.list", async () => ({ tasks: s.tasks })),
            getCurrentPromotable: guard("tasks.getCurrentPromotable", async () => ({ task: s.promotable ?? undefined })),
            promoteToBackground: guard("tasks.promoteToBackground", async ({ id }) => { s.calls.promoted.push(id); return { promoted: true }; }),
        },
    };
    return s;
}

/**
 * Fake transport with the same observable knobs as fakeSession (agent, tasks, promotable, pending, processing, items,
 * stuckCommands) and a `calls` record. `processing` may be null ("unknown", like a failed isProcessing).
 */
export function fakeTransport(o = {}) {
    const t = {
        agent: o.agent ?? "1main", tasks: o.tasks ?? [], promotable: o.promotable ?? null, pending: o.pending ?? false,
        processing: o.processing === undefined ? false : o.processing, items: [...(o.items ?? [])], stuckCommands: o.stuckCommands ?? false,
        calls: { sends: [], enqueued: [], promoted: [], removed: [], sentNow: [] },
        sendPrompt: async (text) => { t.calls.sends.push(text); return true; },
        enqueueCommand: async (command) => {
            t.calls.enqueued.push(command);
            const queueId = `q${t.calls.enqueued.length}`;
            if (t.stuckCommands) t.items.push({ id: queueId, kind: "command", displayText: command });
            return { queued: true, queueId };
        },
        pendingItems: async () => ({ items: [...(t.pending ? [{ id: "p1", kind: "message", displayText: "queued" }] : []), ...t.items], steeringCount: 0 }),
        removeQueued: async (id) => { t.calls.removed.push(id); t.items = t.items.filter((i) => i.id !== id); if (id === "p1") t.pending = false; return true; },
        sendNow: async (id) => { t.calls.sentNow.push(id); t.items = t.items.filter((i) => i.id !== id); if (id === "p1") t.pending = false; return true; },
        listTasks: async () => t.tasks.filter((x) => x.status === "running"),
        promotableCandidates: async () => {
            const list = t.tasks.filter((x) => x.status === "running" && x.executionMode === "sync" && x.canPromoteToBackground !== false);
            if (list.length) return list;
            return t.promotable ? [t.promotable] : [];
        },
        promote: async (id) => { t.calls.promoted.push(id); return true; },
        isProcessing: async () => t.processing,
        currentAgentName: async () => t.agent,
    };
    return t;
}
