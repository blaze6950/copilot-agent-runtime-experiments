// Port of bench/s5-selftest.mjs fixes a (Join-Path / Path.Combine / concatenation) and b (.NET path arguments)
// at worker level: the worker resolves values; engine verdicts on those values are T8.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { CWD, HOME, TEMP, commandNamed, createClient, samePath } from './harness.mjs';

describe('extractor v2 (s5) port', () => {
    let client;
    before(() => { client = createClient().client; });
    after(async () => { await client.stop(); });

    it('Argv_JoinPathWithEnvTemp_ResolvedToConstant', async () => { // a1
        // Arrange / Act
        const facts = await client.argv("Remove-Item (Join-Path $env:TEMP 'tf\\x')", CWD);
        // Assert
        const w = commandNamed(facts, 'remove-item').args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, join(TEMP, 'tf', 'x')), w.value);
    });

    it('Argv_IoPathCombine_ResolvedToConstant', async () => { // a2
        // Arrange / Act
        const facts = await client.argv("Remove-Item ([IO.Path]::Combine($env:TEMP, 'x'))", CWD);
        // Assert
        const w = commandNamed(facts, 'remove-item').args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, join(TEMP, 'x')), w.value);
    });

    it('Argv_StringConcatenationOfResolvableParts_ResolvedToConstant', async () => { // a3
        // Arrange / Act
        const facts = await client.argv("Remove-Item ($env:TEMP + '\\x')", CWD);
        // Assert
        const w = facts.commands[0].args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, `${TEMP}\\x`), w.value);
    });

    it('Argv_AssignedJoinPath_PropagatesToLaterUse', async () => { // a4
        // Arrange / Act
        const facts = await client.argv("$p = Join-Path $env:TEMP 'q'; Remove-Item $p", CWD);
        // Assert
        const w = commandNamed(facts, 'remove-item').args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, join(TEMP, 'q')), w.value);
    });

    it('Argv_JoinPathFeatureOff_StaysDynamic', async () => { // a5
        // Arrange / Act
        const facts = await client.argv("Remove-Item (Join-Path $env:TEMP 'tf\\x')", CWD, { joinPath: false, dotnetArgs: true });
        // Assert
        assert.equal(commandNamed(facts, 'remove-item').args[0].isConst, false);
    });

    it('Argv_JoinPathHomeSecretFolder_ResolvedAgainstConfiguredHome', async () => { // a6 (fact side)
        // Arrange / Act
        const facts = await client.argv("Get-Content (Join-Path $HOME '.ssh\\id_rsa')", CWD);
        // Assert
        const w = commandNamed(facts, 'get-content').args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, join(HOME, '.ssh', 'id_rsa')), w.value);
    });

    it('Argv_JoinPathWithNonConstantPart_StaysDynamic', async () => {
        // Arrange / Act
        const facts = await client.argv("Remove-Item (Join-Path $unknown 'x')", CWD);
        // Assert
        assert.equal(commandNamed(facts, 'remove-item').args[0].isConst, false);
    });

    it('Argv_DotNetReadLiteralPath_CallReportedWithConstantArgument', async () => { // b1
        // Arrange / Act
        const facts = await client.argv("[IO.File]::ReadAllText('C:\\Windows\\x.txt')", CWD);
        // Assert
        const call = facts.dotnetCalls[0];
        assert.equal(call.type, 'io.file');
        assert.equal(call.method, 'readalltext');
        assert.equal(call.args[0].isConst, true);
        assert.equal(call.args[0].value, 'C:\\Windows\\x.txt');
        assert.ok(samePath(call.cwd, CWD));
    });

    it('Argv_DotNetWriteToEnvTemp_ArgumentResolvedAndSecondArgConstant', async () => { // b2
        // Arrange / Act
        const facts = await client.argv('[IO.File]::WriteAllText("$env:TEMP\\y", \'z\')', CWD);
        // Assert
        const call = facts.dotnetCalls[0];
        assert.equal(call.method, 'writealltext');
        assert.ok(samePath(call.args[0].value, join(TEMP, 'y')));
        assert.equal(call.args[1].value, 'z');
    });

    it('Argv_DotNetDeleteUnderWindows_CallReported', async () => { // b3
        // Arrange / Act
        const facts = await client.argv("[IO.File]::Delete('C:\\Windows\\x')", CWD);
        // Assert
        assert.equal(facts.dotnetCalls[0].method, 'delete');
        assert.equal(facts.dotnetCalls[0].args[0].value, 'C:\\Windows\\x');
    });

    it('Argv_DotNetReadUnresolvedArgument_ArgumentNotConstant', async () => { // b4
        // Arrange / Act
        const facts = await client.argv('[IO.File]::ReadAllText($dyn)', CWD);
        // Assert
        assert.equal(facts.dotnetCalls[0].args[0].isConst, false);
    });

    it('Argv_DotNetArgsFeatureOff_NoCallsButTypeMemberNamesRemain', async () => { // b5
        // Arrange / Act
        const facts = await client.argv("[IO.File]::ReadAllText('C:\\Windows\\x.txt')", CWD, { joinPath: true, dotnetArgs: false });
        // Assert
        assert.equal(facts.dotnetCalls.length, 0);
        assert.ok(facts.dotnet.includes('io.file::readalltext'));
    });

    it('Argv_FeaturesOmitted_BothFeaturesDefaultOnAgainAfterAnOffRequest', async () => {
        // Arrange
        await client.argv('Get-Date', CWD, { joinPath: false, dotnetArgs: false });
        // Act
        const facts = await client.argv("Remove-Item (Join-Path $env:TEMP 'x')", CWD);
        // Assert
        assert.equal(facts.commands[0].args[0].isConst, true);
    });
});
