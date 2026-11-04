import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { createClient, waitFor } from './harness.mjs';

describe('PwshClient', () => {
    const clients = [];
    const make = (overrides) => {
        const made = createClient(overrides);
        clients.push(made.client);
        return made;
    };
    afterEach(async () => {
        await Promise.all(clients.splice(0).map((c) => c.stop()));
    });

    it('PwshClient_FirstRequest_StartsWorkerLazily', async () => {
        // Arrange
        const { client } = make();
        const before = client.pid;
        // Act
        await client.parse('Get-Date');
        // Assert
        assert.equal(before, null);
        assert.equal(typeof client.pid, 'number');
    });

    it('PwshClient_ConcurrentRequests_MultiplexedById', async () => {
        // Arrange
        const { client } = make();
        const n = 24;
        // Act
        const results = await Promise.all(Array.from({ length: n }, (_, i) =>
            (i % 2 === 0 ? client.parse(`Write-Output n${i}`) : client.argv(`Write-Output n${i}`, null))));
        // Assert
        const ids = new Set(results.map((r) => r.id));
        assert.equal(ids.size, n);
        results.forEach((r, i) => {
            const text = i % 2 === 0 ? r.commands[0].firstArgs[0] : r.commands[0].args[0].raw;
            assert.equal(text, `n${i}`);
        });
    });

    it('PwshClient_WorkerCrash_RestartsAndSuccessfulRequestResetsTheLimit', async () => {
        // Arrange
        const { client } = make();
        await client.parse('Get-Date');
        const firstPid = client.pid;
        process.kill(firstPid);
        assert.ok(await waitFor(() => client.pid === null), 'client noticed the exit');
        // Act: the crash is recovered by a restart; the successful request resets the counter, so a later crash is recovered too
        const facts = await client.parse('Get-Date');
        const secondPid = client.pid;
        process.kill(secondPid);
        assert.ok(await waitFor(() => client.pid === null), 'client noticed the second exit');
        const again = await client.parse('Get-Date');
        // Assert (the limit itself is covered in pwsh-client-fake.test.mjs)
        assert.equal(facts.commandCount, 1);
        assert.equal(again.commandCount, 1);
        assert.notEqual(secondPid, firstPid);
    });

    it('PwshClient_CrashDuringRequest_RejectsPendingWithUnavailable', async () => {
        // Arrange
        const { client } = make();
        await client.parse('Get-Date');
        const pid = client.pid;
        // Act
        const pending = client.parse(`Write-Output ${'x'.repeat(10)}`);
        process.kill(pid);
        // Assert: either the request raced ahead of the kill and succeeded, or it fails with the documented code
        await pending.then(() => {}, (e) => assert.equal(e.code, 'WORKER_UNAVAILABLE'));
    });

    it('PwshClient_IdleTimeout_StopsWorker', async () => {
        // Arrange
        const { client, clock } = make({ idleMs: 1000 });
        await client.parse('Get-Date');
        // Act / Assert: just below the limit the worker keeps running
        clock.advance(999);
        await client.checkIdle();
        assert.equal(typeof client.pid, 'number');
        // at the limit it is stopped
        clock.advance(1);
        await client.checkIdle();
        assert.equal(client.pid, null);
    });

    it('PwshClient_RequestRefreshesIdleTimer_WorkerKeptAlive', async () => {
        // Arrange
        const { client, clock } = make({ idleMs: 1000 });
        await client.parse('Get-Date');
        clock.advance(900);
        await client.parse('Get-Date');
        // Act
        clock.advance(900);
        await client.checkIdle();
        // Assert
        assert.equal(typeof client.pid, 'number');
    });

    it('PwshClient_AfterIdleStop_NextRequestStartsFreshWorkerWithoutUsingRestart', async () => {
        // Arrange
        const { client, clock } = make({ idleMs: 1000 });
        await client.parse('Get-Date');
        clock.advance(1000);
        await client.checkIdle();
        // Act
        const facts = await client.argv('git --no-pager status', null);
        process.kill(client.pid); // a later crash must still get its one restart
        await waitFor(() => client.pid === null);
        const again = await client.parse('Get-Date');
        // Assert
        assert.equal(facts.commands[0].args[0].takesValue, false); // config was re-sent to the new worker
        assert.equal(again.commandCount, 1);
    });

    it('PwshClient_WorkerUnavailable_RejectsWithReason', async () => {
        // Arrange
        const { client } = make({ pwshPath: join(tmpdir(), 'gov-t2-no-such-pwsh.exe') });
        // Act / Assert
        await assert.rejects(client.parse('Get-Date'), (e) => {
            assert.equal(e.code, 'WORKER_UNAVAILABLE');
            assert.match(e.message, /pwsh worker/);
            assert.equal(typeof e.reason, 'string');
            return true;
        });
    });

    it('PwshClient_ReadyTimeout_RejectsWithUnavailable', async () => {
        // Arrange: a process that stays alive but never prints the ready line
        const silent = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const { client } = make({ spawnFn: silent, readyTimeoutMs: 300 });
        // Act / Assert
        await assert.rejects(client.parse('Get-Date'), (e) => e.code === 'WORKER_UNAVAILABLE' && /ready/.test(e.message));
    });

    it('PwshClient_Stop_RejectsLaterRequestsAndKillsWorker', async () => {
        // Arrange
        const { client } = make();
        await client.parse('Get-Date');
        // Act
        await client.stop();
        // Assert
        assert.equal(client.pid, null);
        await assert.rejects(client.parse('Get-Date'), (e) => e.code === 'WORKER_UNAVAILABLE' && /stopped/.test(e.message));
    });

    it('PwshClient_ConfigFunction_EvaluatedOnEachWorkerStart', async () => {
        // Arrange
        let calls = 0;
        const { client } = make({ workerConfig: () => { calls++; return { userHome: tmpdir() }; } });
        // Act
        await client.parse('Get-Date');
        await client.parse('Get-Date');
        // Assert
        assert.equal(calls, 1);
    });
});
