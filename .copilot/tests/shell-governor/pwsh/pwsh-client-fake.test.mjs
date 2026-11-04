// PwshClient against a fake worker (tests/shell-governor/pwsh/fake-worker.mjs): response validation, restart accounting,
// idle shutdown races, request timeouts and log hygiene. The real worker is covered by the other files in this folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, mock } from 'node:test';
import { createClient, sleep, waitFor } from './harness.mjs';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const fakeSpawn = () => spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

describe('PwshClient with a fake worker', () => {
    const clients = [];
    const make = (overrides = {}) => {
        const made = createClient({ spawnFn: fakeSpawn, requestTimeoutMs: 5000, ...overrides });
        clients.push(made.client);
        return made;
    };
    afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.stop())); });

    describe('response shape (W7)', () => {
        it('PwshClient_ArgvResponseWithoutFacts_RejectsWithWorkerError', async () => {
            // Arrange
            const { client } = make();
            // Act / Assert
            await assert.rejects(client.argv('FAKE:malformed'), (e) => e.code === 'WORKER_ERROR' && e.message === 'malformed argv response');
        });

        it('PwshClient_ArgvResponseWithWrongTypes_RejectsWithWorkerError', async () => {
            // Arrange: each field of the minimal shape is checked on its own
            const { client } = make();
            for (const bad of ['commands="x"', 'parseErrors={}', 'statementCount="1"']) {
                // Act / Assert
                await assert.rejects(client.argv(`FAKE:badfield:${bad}`), (e) => e.code === 'WORKER_ERROR' && /malformed argv response/.test(e.message), bad);
            }
        });

        it('PwshClient_ParseResponseWithoutFacts_RejectsWithWorkerError', async () => {
            // Arrange
            const { client } = make();
            // Act / Assert
            await assert.rejects(client.parse('FAKE:malformed'), (e) => e.code === 'WORKER_ERROR' && e.message === 'malformed parse response');
        });

        it('PwshClient_WellFormedResponses_PassThrough', async () => {
            // Arrange
            const { client } = make();
            // Act
            const argv = await client.argv('Get-Date');
            const parsed = await client.parse('Get-Date');
            // Assert
            assert.deepEqual(argv.commands, []);
            assert.equal(parsed.commandCount, 0);
        });
    });

    describe('restart accounting (S1)', () => {
        it('PwshClient_SuccessfulRequestAfterRestart_ResetsRestartCounter', async () => {
            // Arrange
            const { client } = make();
            await client.parse('Get-Date');
            // Act: three crashes, each followed by a successful request, are all recovered
            for (let i = 0; i < 3; i += 1) {
                process.kill(client.pid);
                assert.ok(await waitFor(() => client.pid === null), `crash ${i} noticed`);
                const facts = await client.parse('Get-Date');
                // Assert
                assert.equal(facts.commandCount, 0, `request after crash ${i}`);
            }
        });

        it('PwshClient_RestartedWorkerCrashesBeforeAnySuccess_RestartLimitStillApplies', async () => {
            // Arrange
            const { client } = make();
            await client.parse('Get-Date');
            process.kill(client.pid);
            assert.ok(await waitFor(() => client.pid === null));
            // Act: the restarted worker dies on its first request
            await assert.rejects(client.parse('FAKE:crash'), (e) => e.code === 'WORKER_UNAVAILABLE');
            // Assert
            await assert.rejects(client.parse('Get-Date'), (e) => e.code === 'WORKER_UNAVAILABLE' && e.reason === 'restart-limit');
        });
    });

    describe('idle shutdown (S1)', () => {
        it('PwshClient_RequestArrivesDuringIdleShutdown_StartsNewWorkerInsteadOfRejecting', async () => {
            // Arrange
            const { client, clock } = make({ idleMs: 1000 });
            await client.parse('Get-Date');
            const firstPid = client.pid;
            clock.advance(1000);
            // Act: the request is issued while the idle shutdown is still in progress
            const idle = client.checkIdle();
            const request = client.parse('Get-Date');
            // Assert
            const facts = await request;
            await idle;
            assert.equal(facts.commandCount, 0);
            assert.equal(typeof client.pid, 'number');
            assert.notEqual(client.pid, firstPid, 'a fresh worker answered');
        });
    });

    describe('request timeout (S1)', () => {
        it('PwshClient_QueuedRequestsBehindSlowOne_TimeoutStartsWhenWritten', async () => {
            // Arrange: eight requests of 100 ms are queued behind each other (800 ms in all) with a 350 ms timeout. The request timer is
            // virtual (mock.timers, enabled after the worker has started): it fires only when the test ticks, and the test ticks 100 ms
            // after each answer. A request's timer is armed when it is written, so at most 100 ms pass during its round trip and it
            // cannot expire. A timer armed at enqueue would expire at 350 ms while requests 5-8 still wait.
            const { client } = make({ requestTimeoutMs: 350 });
            await client.parse('Get-Date');
            // Real-time guard: with virtual time a worker that never answers would hang the test, because nothing advances the clock.
            // The real setTimeout is captured before mock.timers replaces it. The guard is cleared after the reset, with the real clearTimeout.
            const realSetTimeout = globalThis.setTimeout;
            let guard;
            mock.timers.enable({ apis: ['setTimeout'] });
            try {
                // Act: the worker answers one request at a time, and the next request is written when the previous answer arrives
                const requests = Array.from({ length: 8 }, () => client.parse('FAKE:slow:100'));
                const settled = Promise.allSettled(requests); // attaches the handlers at once, so no rejection is unhandled
                const noAnswer = new Promise((_, reject) => {
                    guard = realSetTimeout(() => reject(new Error('worker gave no answer within 15 s of real time')), 15000);
                });
                // The tick happens only after an answer has been processed: the next request is already written and its timer armed
                const drive = async () => {
                    for (const request of requests) {
                        await request.catch(() => {});
                        mock.timers.tick(100);
                    }
                    return settled;
                };
                const results = await Promise.race([drive(), noAnswer]);
                // Assert
                assert.deepEqual(results.map((r) => r.status), Array(8).fill('fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)));
            } finally {
                mock.timers.reset();
                clearTimeout(guard);
            }
        });

        it('PwshClient_HungRequest_TimesOutKillsWorkerAndNextRequestRestarts', async () => {
            // Arrange
            const { client } = make({ requestTimeoutMs: 300 });
            await client.parse('Get-Date');
            // Act / Assert
            await assert.rejects(client.parse('FAKE:hang'), (e) => e.code === 'WORKER_UNAVAILABLE' && e.reason === 'request-timeout');
            assert.equal((await client.parse('Get-Date')).commandCount, 0);
        });
    });

    describe('queue behind a dead worker (TFIX-5 item 7)', () => {
        /** In-memory worker processes: the test decides when a "killed" child reports its exit (the delay that exposed the stall). */
        const scriptedSpawn = () => {
            const children = [];
            const spawnFn = () => {
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.exitCode = null;
                child.pid = 4000 + children.length;
                child.kills = 0;
                child.received = [];
                child.kill = () => { child.kills += 1; }; // the exit event is delivered by the test
                child.die = (code = 1) => { child.exitCode = code; child.emit('exit', code); };
                child.stdin = {
                    on() {},
                    write(body, cb) {
                        const req = JSON.parse(body);
                        child.received.push(req);
                        if (req.op === 'exit') child.die(0);
                        else if (req.op === 'config') child.stdout.write(`${JSON.stringify({ id: req.id, op: 'config', applied: [] })}\n`);
                        else if (req.script !== 'FAKE:hang') {
                            child.stdout.write(`${JSON.stringify({ id: req.id, parseErrors: [], commentSpans: [], commandCount: 0, commands: [], redirections: { count: 0, files: [] } })}\n`);
                        }
                        cb?.();
                        return true;
                    },
                };
                setImmediate(() => child.stdout.write(`${JSON.stringify({ ready: true, psVersion: 'fake', pid: child.pid })}\n`));
                children.push(child);
                return child;
            };
            return { children, spawnFn };
        };

        it('PwshClient_RequestQueuedBehindTimedOutOne_NewWorkerIsStillServed', async () => {
            // Arrange: a hangs on worker 1 and b waits behind it; a times out, worker 1 is killed but has not reported its exit yet,
            // and c starts worker 2: its config request queues behind b (which belongs to worker 1)
            const { children, spawnFn } = scriptedSpawn();
            const { client } = createClient({ spawnFn, requestTimeoutMs: 150 });
            try {
                await client.parse('Get-Date');
                const a = client.parse('FAKE:hang');
                const b = client.parse('Get-Date');
                const bOutcome = b.then((v) => ({ ok: v }), (e) => ({ error: e }));
                await assert.rejects(a, (e) => e.reason === 'request-timeout');
                assert.equal(children[0].kills, 1, 'the hung worker was killed');
                const c = client.parse('Get-Date');
                const cOutcome = c.then((v) => ({ ok: v }), (e) => ({ error: e }));
                assert.ok(await waitFor(() => children.length === 2), 'worker 2 started');
                await sleep(60); // worker 2 is ready and its config request is queued

                // Act: worker 1 finally reports its exit
                children[0].die(1);
                const guard = new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 2000));
                const bResult = await Promise.race([bOutcome, guard]);
                const cResult = await Promise.race([cOutcome, guard]);

                // Assert: b belonged to the dead worker and is rejected; c is served by worker 2 instead of waiting for ever
                assert.equal(bResult.error?.code, 'WORKER_UNAVAILABLE', JSON.stringify(bResult));
                assert.equal(cResult.hung, undefined, 'c must not hang behind the dead worker\'s request');
                assert.equal(cResult.ok?.commandCount, 0);
                assert.ok(children[1].received.some((r) => r.op === 'config'), 'the config request reached worker 2');
            } finally {
                for (const child of children) if (child.exitCode === null) child.die(0);
                await Promise.race([client.stop(), sleep(500)]);
            }
        });
    });

    describe('log hygiene (S2)', () => {
        it('PwshClient_WorkerStderrAndBadStdout_LoggedAsByteCountsOnly', async () => {
            // Arrange
            const logs = [];
            const { client } = make({ onLog: (text) => logs.push(text) });
            // Act
            await client.parse('FAKE:stderr:TOPSECRET-stderr');
            await client.parse('FAKE:badline:TOPSECRET-badline');
            await waitFor(() => logs.length >= 2);
            // Assert
            const all = logs.join('');
            assert.ok(!all.includes('TOPSECRET'), all);
            assert.match(all, /stderr: \d+ bytes/);
            assert.match(all, /bad stdout line: \d+ bytes/);
        });

        it('PwshClient_WorkerErrorResponse_LoggedWithoutMessageText', async () => {
            // Arrange
            const logs = [];
            const { client } = make({ onLog: (text) => logs.push(text) });
            // Act
            await assert.rejects(client.parse('FAKE:error:TOPSECRET-error'), (e) => e.code === 'WORKER_ERROR');
            // Assert
            assert.ok(!logs.join('').includes('TOPSECRET'), logs.join(''));
            assert.match(logs.join(''), /worker error: \d+ bytes/);
        });
    });
});
