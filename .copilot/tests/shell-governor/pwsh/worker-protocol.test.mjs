// Protocol-level checks of the worker itself: config, stats, exit, unknown ops, serialisation depth.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { CWD, HOME, createClient, samePath, workerConfig } from './harness.mjs';

const WORKER = fileURLToPath(new URL('../../../extensions/shell-governor/pwsh/worker.ps1', import.meta.url));

describe('worker protocol', () => {
    let client;
    before(() => { client = createClient().client; });
    after(async () => { await client.stop(); });

    it('Worker_ConfigRequest_AppliesUserHomeToTildeAndHome', async () => {
        // Arrange / Act
        const facts = await client.argv('Set-Location ~\\sub; Get-Item a', CWD);
        // Assert
        assert.ok(samePath(facts.commands[1].cwd, join(HOME, 'sub')), facts.commands[1].cwd);
    });

    it('Worker_ConfigRequest_AcknowledgesAppliedKeys', async () => {
        // Arrange / Act
        const ack = await client.request('config', workerConfig());
        // Assert
        assert.equal(ack.op, 'config');
        assert.deepEqual([...ack.applied].sort(), ['copilotHome', 'flagTable', 'secretPatterns', 'systemRoots', 'userHome']);
    });

    it('Worker_ConfigWithInvalidSecretPattern_RejectedWithError', async () => {
        // Arrange / Act / Assert
        await assert.rejects(client.request('config', { secretPatterns: ['(unclosed'] }), (e) => e.code === 'WORKER_ERROR' && /pattern/i.test(e.message));
    });

    it('Worker_Stats_ReportsPidServedAndConfiguredTools', async () => {
        // Arrange
        await client.parse('Get-Date');
        // Act
        const s = await client.stats();
        // Assert
        assert.equal(s.op, 'stats');
        assert.equal(typeof s.pid, 'number');
        assert.ok(s.served >= 1);
        assert.equal(s.flagTools, 6);
        assert.ok(s.workingSetMB > 0);
    });

    it('Worker_UnknownOp_RejectsWithWorkerError', async () => {
        // Arrange / Act / Assert
        await assert.rejects(client.request('frobnicate', {}), (e) => e.code === 'WORKER_ERROR' && /unknown op/.test(e.message));
    });

    it('Worker_RemovedSignatureOp_IsUnknown', async () => {
        // Arrange / Act / Assert
        await assert.rejects(client.request('signature', { script: 'Get-Date' }), (e) => e.code === 'WORKER_ERROR');
    });

    it('Worker_ErrorOnOneRequest_NextRequestStillServed', async () => {
        // Arrange
        await assert.rejects(client.request('frobnicate', {}));
        // Act
        const facts = await client.parse('Get-Date');
        // Assert
        assert.equal(facts.commandCount, 1);
    });

    it('Worker_NullScript_TreatedAsEmpty', async () => {
        // Arrange / Act
        const facts = await client.argv(null, null);
        // Assert
        assert.deepEqual(facts.commands, []);
        assert.deepEqual(facts.parseErrors, []);
    });

    describe('comment spans', () => {
        const slices = (script, spans) => spans.map(([s, e]) => script.slice(s, e));

        it('Worker_ArgvLineAndBlockComments_ReturnsSpansOfBoth', async () => {
            // Arrange
            const script = 'Get-Date # c\n<# b #> Get-Item .';
            // Act
            const facts = await client.argv(script, null);
            // Assert
            assert.deepEqual(slices(script, facts.commentSpans), ['# c', '<# b #>']);
        });

        it('Worker_ParseLineAndBlockComments_ReturnsSpansOfBoth', async () => {
            // Arrange
            const script = '<# c #>Get-Date\n# d';
            // Act
            const facts = await client.parse(script);
            // Assert
            assert.deepEqual(slices(script, facts.commentSpans), ['<# c #>', '# d']);
        });

        it('Worker_ArgvCommentMarkersInsideStringExpression_NoSpansAndCodeStaysVisible', async () => {
            // Arrange: the `<#` and `#>` sit in nested string literals; the text between them is executed code
            const script = '"$("<#")"; Write-Output HIDDEN; "$("#>")"';
            // Act
            const facts = await client.argv(script, null);
            // Assert
            assert.deepEqual(facts.commentSpans, []);
            assert.ok(facts.commands.some((c) => c.name === 'write-output'), 'HIDDEN command is a real command');
        });

        it('Worker_ArgvNoComments_EmptyArrayNotNull', async () => {
            // Arrange / Act
            const facts = await client.argv('Get-Date', null);
            // Assert
            assert.deepEqual(facts.commentSpans, []);
        });

        it('Worker_ArgvSingleComment_StaysAnArrayOfPairs', async () => {
            // Arrange
            const script = 'Get-Date # only';
            // Act
            const facts = await client.argv(script, null);
            // Assert
            assert.ok(Array.isArray(facts.commentSpans) && facts.commentSpans.length === 1 && Array.isArray(facts.commentSpans[0]));
            assert.deepEqual(slices(script, facts.commentSpans), ['# only']);
        });

        it('Worker_ArgvCommentSpansFor_LengthInUtf16UnitsAndSha256OfUtf8', async () => { // TFIX-6 F2: the identity of the analysed text
            // Arrange
            const scripts = ['Get-Date', 'Get-Date # c\r\nGet-Item .\r\n', 'Write-Output "ä😀" # note\nGet-Date', ''];
            for (const script of scripts) {
                // Act
                const facts = await client.argv(script, null);
                // Assert
                assert.deepEqual(facts.commentSpansFor, { length: script.length, sha256: createHash('sha256').update(script, 'utf8').digest('hex') }, JSON.stringify(script));
            }
        });

        it('Worker_ArgvCommentSpansFor_DiffersForOtherText', async () => {
            // Arrange / Act
            const a = await client.argv('Get-Date # a', null);
            const b = await client.argv('Get-Date # b', null);
            // Assert
            assert.equal(a.commentSpansFor.length, b.commentSpansFor.length);
            assert.notEqual(a.commentSpansFor.sha256, b.commentSpansFor.sha256);
        });
    });

    describe('env refs', () => {
        const refs = async (script) => (await client.argv(script, null)).envRefs;

        it('Worker_ArgvEnvReadInPipelineAndAssignment_ReportedWithOriginalCase', async () => {
            // Arrange / Act
            const piped = await refs('$env:GH_TOKEN | Set-Clipboard');
            const assigned = await refs('$t = $env:Github_Token; $u = ${env:MY TOKEN}');
            const inString = await refs('Write-Output "x $env:NPM_TOKEN y"');
            // Assert
            assert.deepEqual(piped, ['GH_TOKEN']);
            assert.deepEqual(assigned, ['Github_Token', 'MY TOKEN']);
            assert.deepEqual(inString, ['NPM_TOKEN']);
        });

        it('Worker_ArgvEnvRefs_DistinctAndEmptyArrayWhenNone', async () => {
            // Arrange / Act
            const twice = await refs('$env:A; $env:A; $ENV:b');
            const none = await refs('Get-Date; $x = 1');
            // Assert
            assert.deepEqual(twice, ['A', 'b']);
            assert.deepEqual(none, []);
        });

        it('Worker_ArgvEnvRefsOfInnerScript_ReportedOnTheInnerResult', async () => {
            // Arrange / Act
            const facts = await client.argv("pwsh -Command '$env:AWS_SECRET_ACCESS_KEY | Set-Clipboard'", null);
            const inner = facts.commands.find((c) => c.inner)?.inner;
            // Assert
            assert.deepEqual(inner?.envRefs, ['AWS_SECRET_ACCESS_KEY']);
        });

        it('Worker_ArgvOtherVariablesAndDriveForms_AreNotEnvRefs', async () => {
            // Arrange / Act
            const other = await refs('$environment = 1; $envx:foo; $global:env; Get-Item Env:PATH');
            // Assert
            assert.deepEqual(other, []);
        });
    });

    it('Worker_ExitOp_AcknowledgesAndExits', async () => {
        // Arrange
        const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const lines = [];
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (l) => lines.push(JSON.parse(l)));
        const exited = new Promise((resolve) => child.once('exit', resolve));
        // Act
        child.stdin.write(`${JSON.stringify({ id: 7, op: 'exit' })}\n`);
        const code = await exited;
        // Assert
        assert.equal(code, 0);
        assert.equal(lines[0].ready, true);
        assert.deepEqual({ id: lines[1].id, op: lines[1].op }, { id: 7, op: 'exit' });
    });
});
