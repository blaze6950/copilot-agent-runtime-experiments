// Worker facts added for the T8 review findings: dynamic script-block invocation, statement count, and the injected
// user home for $env:USERPROFILE / $env:HOME.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { CWD, HOME, createClient, samePath } from './harness.mjs';

describe('extractor facts for the rule engine (T8 review)', () => {
    let client;
    before(() => { client = createClient().client; });
    after(async () => { await client.stop(); });

    it('Argv_NewScriptBlockInvoke_FlagsDynamicInvoke', async () => { // C5
        // Arrange / Act
        const facts = await client.argv("$ExecutionContext.InvokeCommand.NewScriptBlock('Get-Content x').Invoke()", CWD);
        // Assert
        assert.equal(facts.flags.dynamicInvoke, true);
        assert.equal(facts.flags.dynamic, true);
        assert.equal(facts.statementCount, 1);
        assert.equal(facts.commands.length, 0);
    });

    it('Argv_InvokeScriptAndScriptBlockCreate_FlagDynamicInvoke', async () => { // C5
        // Arrange / Act
        const invokeScript = await client.argv("$ExecutionContext.InvokeCommand.InvokeScript('Get-Content x')", CWD);
        const create = await client.argv("[scriptblock]::Create('Get-Content x')", CWD);
        const sb = await client.argv('$sb.Invoke()', CWD);
        // Assert
        assert.equal(invokeScript.flags.dynamicInvoke, true);
        assert.equal(create.flags.dynamicInvoke, true);
        assert.equal(sb.flags.dynamicInvoke, true);
    });

    it('Argv_OrdinaryMethodCallsAndCommands_DoNotFlagDynamicInvoke', async () => { // C5
        // Arrange / Act
        const facts = await client.argv("'abc'.ToUpper(); Get-Process", CWD);
        // Assert
        assert.equal(facts.flags.dynamicInvoke, false);
    });

    it('Argv_StatementCount_CountsTopLevelStatementsOnly', async () => { // C5
        // Arrange / Act
        const three = await client.argv('Get-Date; $x = 1; if ($x) { Get-Process }', CWD);
        const empty = await client.argv('', CWD);
        const comment = await client.argv('# nothing here', CWD);
        // Assert
        assert.equal(three.statementCount, 3);
        assert.equal(empty.statementCount, 0);
        assert.equal(comment.statementCount, 0);
    });

    it('Argv_ExpressionStatementRedirect_BecomesExpressionPseudoCommand', async () => { // follow-up 1
        // Arrange / Act
        const facts = await client.argv("'x' > a.txt", CWD);
        const append = await client.argv('$v = 1; $v >> C:\\p\\f.txt', CWD);
        const sink = await client.argv("'x' > $null", CWD);
        const own = await client.argv('Get-Content x > out.txt', CWD);
        // Assert
        assert.equal(facts.commands.length, 1);
        assert.equal(facts.commands[0].inv, 'expression');
        assert.equal(facts.commands[0].name, '<expression>');
        assert.equal(facts.commands[0].redirs[0].raw, 'a.txt');
        assert.equal(facts.commands[0].redirs[0].nullSink, false);
        assert.equal(append.commands[0].redirs[0].append, true);
        assert.equal(sink.commands[0].redirs[0].nullSink, true);
        assert.equal(own.commands.length, 1);
        assert.equal(own.commands[0].name, 'get-content');
    });

    it('Argv_ExpressionRedirectAfterSetLocation_UsesTheTrackedCwd', async () => { // follow-up 1
        // Arrange / Act
        const facts = await client.argv(`Set-Location '${join(CWD, 'sub')}'; 'x' > a.txt`, CWD);
        // Assert
        const expr = facts.commands.find((c) => c.inv === 'expression');
        assert.ok(samePath(expr.cwd, join(CWD, 'sub')), expr.cwd);
    });

    it('Argv_PipeSource_PathProducersAndDataProducers', async () => { // follow-up 2
        // Arrange / Act
        const cases = {
            gci: await client.argv('gci | Get-Content', CWD),
            literal: await client.argv("'a' | Get-Content", CWD),
            variable: await client.argv('$f | Get-Content', CWD),
            filtered: await client.argv('Get-ChildItem | Where-Object { $true } | Select-Object -First 1 | Get-Content', CWD),
            content: await client.argv('Get-Content x | Select-String foo', CWD),
            native: await client.argv('git log | Select-String foo', CWD),
            first: await client.argv('Get-Content x', CWD),
        };
        const last = (f) => f.commands[f.commands.length - 1];
        // Assert
        assert.equal(last(cases.gci).pipeSource, 'paths');
        assert.equal(last(cases.literal).pipeSource, 'paths');
        assert.equal(last(cases.variable).pipeSource, 'paths');
        assert.equal(last(cases.filtered).pipeSource, 'paths');
        assert.equal(last(cases.content).pipeSource, 'data');
        assert.equal(last(cases.native).pipeSource, 'data');
        assert.equal(last(cases.first).pipeSource, null);
    });

    it('Argv_ProcessStartMember_FlagsDynamicInvoke', async () => { // N3
        // Arrange / Act
        const facts = await client.argv('$p.Start()', CWD);
        // Assert
        assert.equal(facts.flags.dynamicInvoke, true);
    });

    it('Argv_PipeSource_OnlyContentAndNativeOutputIsData', async () => { // N1
        // Arrange / Act
        const content = await client.argv('cat x | Select-String foo', CWD);
        const native = await client.argv('rg -l x | Select-String foo', CWD);
        const csv = await client.argv('Import-Csv x.csv | Select-String foo', CWD);
        const json = await client.argv("'{}' | ConvertFrom-Json | Select-String foo", CWD);
        const last = (f) => f.commands[f.commands.length - 1];
        // Assert
        assert.equal(last(content).pipeSource, 'data');
        assert.equal(last(native).pipeSource, 'data');
        assert.equal(last(csv).pipeSource, 'paths');
        assert.equal(last(json).pipeSource, 'data', 'TFIX-4: parsed JSON objects are no files; Select-String reads files only for FileInfo objects');
    });

    it('Argv_ValueOfKnownValueParameter_IsNoPositionalPath', async () => { // TFIX-4 R2
        // Arrange / Act
        const f = await client.argv('git log | Select-String x -Context 2,3 -Encoding utf8; Get-ChildItem -Filter *.cs C:\\x', CWD);
        const sls = f.commands.find((c) => c.name === 'select-string');
        const gci = f.commands.find((c) => c.name === 'get-childitem');
        const posOf = (c) => c.args.filter((a) => a.k === 'word').map((a) => a.pos);
        // Assert: only the pattern is positional; the values of -Context/-Encoding/-Filter are not; the path of Get-ChildItem still is
        assert.deepEqual(posOf(sls), [0, null, null]);
        assert.deepEqual(posOf(gci), [null, 0]);
    });

    it('Argv_PipeSource_TextAndObjectProducersAreDataPathProducersAreNot', async () => { // TFIX-4 R2
        // Arrange / Act
        const kind = async (script) => {
            const f = await client.argv(script, CWD);
            return f.commands[f.commands.length - 1].pipeSource;
        };
        // Assert: producers that cannot emit FileInfo/path items
        for (const s of ["Write-Output 'a' | Select-String x", 'Get-Process | Select-String x', 'Get-Date | Select-String x', 'Get-Command git | Select-String x',
            'Invoke-RestMethod https://example.invalid | Select-String x', 'gh pr list | Select-String x', '& git log | Select-String x',
            'Get-Content x | Where-Object { $_ } | Select-String x', 'Select-String a x | Select-String b']) {
            assert.equal(await kind(s), 'data', s);
        }
        // Assert: producers that can yield FileInfo, paths or anything unknown
        for (const s of ['Get-ChildItem | Select-String x', 'gci -r | Select-String x', 'Get-Item x | Select-String x', 'Resolve-Path x | Select-String x',
            'Get-SomethingElse | Select-String x', '$f | Select-String x', 'Write-Output $f | Select-String x', "'a' | Select-String x", 'Import-Csv x | Select-String x',
            'Get-Content x | ForEach-Object { $_ } | Select-String x']) { // TFIX-8: ForEach-Object can emit anything
            assert.equal(await kind(s), 'paths', s);
        }
    });

    it('Argv_EnvUserProfileAndHome_UseConfiguredUserHome', async () => { // W6
        // Arrange / Act
        const profile = await client.argv('Get-Content "$env:USERPROFILE\\.ssh\\id_rsa"', CWD);
        const home = await client.argv('Get-Content "$env:HOME\\x"', CWD);
        // Assert
        const a = profile.commands[0].args[0];
        assert.ok(a.isConst && samePath(a.value, join(HOME, '.ssh', 'id_rsa')), JSON.stringify(a));
        assert.ok(samePath(home.commands[0].args[0].value, join(HOME, 'x')));
    });
});
