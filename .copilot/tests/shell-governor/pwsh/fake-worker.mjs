// Fake pwsh worker for PwshClient tests: speaks the worker's JSON-lines protocol and misbehaves on cue.
// The request's `script` selects the behaviour (the client sends it as the payload of parse/argv):
//   FAKE:malformed        reply {id, op} only (no facts)
//   FAKE:badfield:<name>=<json>   reply normally except that field <name> has the JSON value
//   FAKE:hang             never reply
//   FAKE:slow:<ms>        reply after <ms>
//   FAKE:stderr:<text>    write <text> to stderr, then reply normally
//   FAKE:badline:<text>   write <text> as a non-JSON stdout line, then reply normally
//   FAKE:error:<text>     reply {id, error: <text>}
//   FAKE:crash            exit(1) without replying
// anything else gets a valid reply.
import { createInterface } from 'node:readline';

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
send({ ready: true, psVersion: 'fake', pid: process.pid });

const good = (req) => (req.op === 'argv'
    ? { id: req.id, op: 'argv', cwd: null, parseErrors: [], commentSpans: [], statementCount: 0, constVars: [], dotnetCalls: [], commands: [], dotnet: [], flags: {} }
    : { id: req.id, parseErrors: [], commentSpans: [], commandCount: 0, commands: [], redirections: { count: 0, files: [] } });

let chain = Promise.resolve();
// Requests are served one at a time, in order, like the real worker.
createInterface({ input: process.stdin }).on('line', (line) => {
    chain = chain.then(() => handle(JSON.parse(line)));
});

async function handle(req) {
    if (req.op === 'config') return send({ id: req.id, op: 'config', applied: [] });
    if (req.op === 'exit') {
        send({ id: req.id, op: 'exit', served: 0 });
        process.exit(0);
    }
    if (req.op === 'stats') return send({ id: req.id, op: 'stats', pid: process.pid, served: 0 });
    const script = String(req.script ?? '');
    const [, kind, arg] = /^FAKE:([a-z]+)(?::(.*))?$/s.exec(script) ?? [];
    switch (kind) {
        case 'malformed': return send({ id: req.id, op: req.op });
        case 'badfield': return send({ ...good(req), [arg.split('=')[0]]: JSON.parse(arg.split('=')[1]) });
        case 'hang': return new Promise(() => {});
        case 'slow': await new Promise((resolve) => setTimeout(resolve, Number(arg))); return send(good(req));
        case 'stderr': process.stderr.write(`${arg}\n`); return send(good(req));
        case 'badline': process.stdout.write(`${arg}\n`); return send(good(req));
        case 'error': return send({ id: req.id, error: arg });
        case 'crash': return process.exit(1);
        default: return send(good(req));
    }
}
