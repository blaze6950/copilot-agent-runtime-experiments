/**
 * Minimal stand-in for the CLI extension session: records hook registrations, ui calls and event listeners.
 * ui.confirm answers false by default (fail-closed for tests that do not script an answer).
 * @returns {{
 *   hooks: Record<string, Function>,
 *   listeners: Map<string, Function[]>,
 *   ui: { calls: Array<{ method: string, args: unknown[] }>, notify: (...args: unknown[]) => void, confirm: (...args: unknown[]) => Promise<boolean> },
 *   on: (event: string, fn: Function) => void,
 *   emit: (event: string, payload?: unknown) => Promise<void>,
 * }}
 */
export function createFakeSession() {
    const listeners = new Map();
    const calls = [];
    return {
        hooks: {},
        listeners,
        ui: {
            calls,
            notify: (...args) => {
                calls.push({ method: 'notify', args });
            },
            confirm: async (...args) => {
                calls.push({ method: 'confirm', args });
                return false;
            },
        },
        on(event, fn) {
            const list = listeners.get(event) ?? [];
            list.push(fn);
            listeners.set(event, list);
        },
        async emit(event, payload) {
            for (const fn of listeners.get(event) ?? []) await fn(payload);
        },
    };
}
