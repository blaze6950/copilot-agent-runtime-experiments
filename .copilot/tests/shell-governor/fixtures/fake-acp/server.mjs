// Fake ACP server for the judge tests: JSON-RPC 2.0 over stdio, newline-delimited. Never calls a model.
// Behaviour is selected by directives found in the prompt text:
//   FAKE:banner          answer with "Info:" banners glued in front of the JSON (no newline), split over chunks
//   FAKE:permission      send session/request_permission first; answer reports how the client replied
//   FAKE:permission-noreject   same, but the options contain no reject option
//   FAKE:permission-kindtrap   same, but an allow option has a reject-looking optionId
//   FAKE:unknown-request send an unsupported request (fs/read_text_file); answer reports the error code the client sent
//   FAKE:strayBrace      a stray "{" in the banner before the JSON
// Env: FAKE_ACP_HANG_INIT=1 never answers initialize; FAKE_ACP_HANG_NEW_SESSION=1 never answers session/new.
//   FAKE:invalid         answer with a JSON object that violates the schema
//   FAKE:nosentences     answer with valid ratings and without the what_it_does / worst_consequence fields
//   FAKE:badsentence     answer with valid ratings and what_it_does set to a number (not a string)
//   FAKE:prose           answer with no JSON at all
//   FAKE:hang            never answer
//   FAKE:crash           exit the process while handling the prompt
//   FAKE:slow:<ms>       answer after <ms> milliseconds
// Optional env: FAKE_ACP_LOG = file that receives one JSON line per event (spawn, prompt, new-session).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.env.FAKE_ACP_LOG;
const log = (entry) => { if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n'); };
log({ event: 'spawn', argv: process.argv.slice(2), home: process.env.COPILOT_HOME ?? null, cwd: process.cwd() });

const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, text) => write({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});

let nextSession = 1;
let nextServerId = 1000;
let inFlight = 0;
let maxInFlight = 0;
let prompts = 0;
const waiting = new Map();

/** A verdict with valid ratings; `sentences` are the two one-sentence fields (defaults: valid strings). */
const verdict = (extra, sentences = { what_it_does: `ok ${extra}`, worst_consequence: 'nothing' }) => JSON.stringify({
    ratings: {
        destructive: 0, blast_radius: 0, irreversible: 0, credential_access: 0, exfiltration: 0,
        privilege_persistence: 0, prod_external: 0, obfuscation: 0, task_mismatch: 0,
    },
    confidence: 0.9,
    ...sentences,
});

async function handlePrompt(id, params) {
    const text = (params.prompt ?? []).map((p) => p.text ?? '').join('\n');
    prompts += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log({ event: 'prompt', sessionId: params.sessionId, text });
    try {
        if (text.includes('FAKE:crash')) process.exit(3);
        if (text.includes('FAKE:hang')) return;
        const slow = /FAKE:slow:(\d+)/.exec(text);
        if (slow) await new Promise((resolve) => setTimeout(resolve, Number(slow[1])));
        let permission = 'none';
        const variant = /FAKE:permission(-[a-z]+)?/.exec(text);
        if (variant) {
            const requestId = nextServerId++;
            const reply = new Promise((resolve) => waiting.set(requestId, resolve));
            const options = {
                '': [
                    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ],
                '-noreject': [
                    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
                ],
                // the optionId looks like a rejection but its kind says allow: the client must go by kind
                '-kindtrap': [
                    { optionId: 'reject-trap', name: 'Looks like reject', kind: 'allow_once' },
                    { optionId: 'real-no', name: 'No', kind: 'reject_once' },
                ],
            }[variant[1] ?? ''];
            write({
                id: requestId, method: 'session/request_permission',
                params: { sessionId: params.sessionId, toolCall: { toolCallId: 't1', title: 'powershell' }, options },
            });
            const outcome = (await reply)?.result?.outcome;
            if (outcome?.outcome === 'cancelled') permission = 'cancelled';
            else if (outcome?.outcome === 'selected' && ['reject-once', 'real-no'].includes(outcome.optionId)) permission = 'rejected';
            else permission = 'granted';
        }
        let unknown = 'none';
        if (text.includes('FAKE:unknown-request')) {
            const requestId = nextServerId++;
            const reply = new Promise((resolve) => waiting.set(requestId, resolve));
            write({ id: requestId, method: 'fs/read_text_file', params: { path: 'C:\\secret.txt' } });
            unknown = `error${(await reply)?.error?.code}`;
        }
        const info = `maxInflight=${maxInFlight} prompts=${prompts} permission=${permission} unknown=${unknown}`;
        if (text.includes('FAKE:invalid')) {
            update(params.sessionId, '{"ratings":{"destructive":7},"confidence":2}');
        } else if (text.includes('FAKE:nosentences')) {
            update(params.sessionId, verdict(info, {}));
        } else if (text.includes('FAKE:badsentence')) {
            update(params.sessionId, verdict(info, { what_it_does: 5, worst_consequence: 'nothing' }));
        } else if (text.includes('FAKE:prose')) {
            update(params.sessionId, 'I cannot comply with that request.');
        } else if (text.includes('FAKE:strayBrace')) {
            update(params.sessionId, 'Info: retrying { ');
            update(params.sessionId, verdict(info));
        } else if (text.includes('FAKE:banner')) {
            const body = verdict(info);
            update(params.sessionId, 'Info: Model switched to gpt-6-luna Info: Using fallback "}" [');
            update(params.sessionId, body.slice(0, 40));
            update(params.sessionId, body.slice(40));
        } else {
            update(params.sessionId, verdict(info));
        }
        write({ id, result: { stopReason: 'end_turn' } });
    } finally {
        inFlight -= 1;
    }
}

createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
        return;
    }
    switch (message.method) {
        case 'initialize':
            if (process.env.FAKE_ACP_HANG_INIT === '1') break;
            write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            break;
        case 'session/new': {
            if (process.env.FAKE_ACP_HANG_NEW_SESSION === '1') break;
            const sessionId = `fake-session-${nextSession++}`;
            log({ event: 'new-session', sessionId, params: message.params });
            write({ id: message.id, result: { sessionId } });
            break;
        }
        case 'session/prompt':
            void handlePrompt(message.id, message.params);
            break;
        case 'session/cancel':
            log({ event: 'cancel', params: message.params });
            break;
        default:
            if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'unknown method' } });
    }
});
