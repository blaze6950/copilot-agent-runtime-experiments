// Port of the extractor checks of bench/s4-selftest.mjs (A1-A13, B13) at worker level: facts only.
// Engine verdicts (A14, B1-B12, ...) belong to T3/T8; the facts those verdicts rely on are asserted here.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { CWD, ELSEWHERE, HOME, TEMP, commandNamed, createClient, samePath } from './harness.mjs';

describe('extractor v2 (s4) port', () => {
    let client;
    before(() => { client = createClient().client; });
    after(async () => { await client.stop(); });

    it('Argv_GitBranchDashD_CaseOfFlagPreserved', async () => { // A1
        // Arrange / Act
        const facts = await client.argv('git branch -D _x', CWD);
        // Assert
        assert.ok(facts.commands[0].args.some((a) => a.k === 'param' && a.name === 'D'));
    });

    it('Argv_CurlPackedShortFlags_KeptRawAndBundleValueBound', async () => { // A2
        // Arrange / Act
        const facts = await client.argv("curl.exe -sL -w '%{http_code}' https://example.invalid/x", CWD);
        // Assert
        const c = facts.commands[0];
        assert.equal(c.name, 'curl');
        assert.equal(c.inv, 'exe');
        const bundle = c.args.find((a) => a.k === 'param' && a.name === 'sL');
        assert.ok(bundle);
        assert.equal(bundle.takesValue, false);
        const w = c.args.find((a) => a.name === 'w');
        assert.equal(w.takesValue, true);
        assert.equal(c.args[c.args.indexOf(w) + 1].valueFor, c.args.indexOf(w));
    });

    it('Argv_GitGlobalNoValueFlag_DoesNotConsumeSubcommand', async () => { // A3 (arity from the flag table)
        // Arrange / Act
        const facts = await client.argv('git --no-pager branch --show-current', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal(args[0].raw, '--no-pager');
        assert.equal(args[0].takesValue, false);
        assert.equal(args[1].raw, 'branch');
        assert.equal(args[1].valueFor, null);
        assert.equal(args[2].takesValue, false);
    });

    it('Argv_GitGlobalWithValueFlag_ConsumesNextWordOnly', async () => { // A3 (value arity, case sensitive)
        // Arrange / Act
        const facts = await client.argv('git -C sub status -c', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal(args[0].takesValue, true);
        assert.equal(args[1].valueFor, 0);
        assert.equal(args[2].valueFor, null);
        assert.equal(args[3].takesValue, true); // trailing -c is a distinct (lower-case) flag; no word follows
    });

    it('Argv_CaseInsensitiveTool_FlagMatchedIgnoringCase', async () => { // catalog caseSensitive:false
        // Arrange / Act
        const facts = await client.argv('az account show --QUERY name', CWD);
        // Assert
        const args = facts.commands[0].args;
        const q = args.find((a) => a.name === 'QUERY');
        assert.equal(q.takesValue, true);
        assert.equal(args[args.indexOf(q) + 1].valueFor, args.indexOf(q));
    });

    it('Argv_ToolWithoutFlagTableEntry_NoArityAnnotation', async () => {
        // Arrange / Act
        const facts = await client.argv('unknowntool --x y', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal('takesValue' in args[0], false);
        assert.equal('valueFor' in args[1], false);
    });

    it('Argv_GhApiMethodFlag_SignificantValueKept', async () => { // A4
        // Arrange / Act
        const facts = await client.argv('gh api -X POST repos/a/b/x', CWD);
        // Assert
        const args = facts.commands[0].args;
        const x = args.find((a) => a.k === 'param' && a.name === 'X');
        const next = args[args.indexOf(x) + 1];
        assert.equal(next.value, 'POST');
        assert.equal(next.isConst, true);
        assert.equal(next.valueFor, args.indexOf(x));
        assert.equal(args[0].raw, 'api');
        assert.equal(args[0].valueFor, null);
    });

    it('Argv_SnowSqlCarrier_QueryLiteralExtractedAsValueOfDashQ', async () => { // A5
        // Arrange / Act
        const facts = await client.argv('snow -c example_prod sql -q "select current_role()"', CWD);
        // Assert
        const args = facts.commands[0].args;
        assert.equal(args[1].value, 'example_prod');
        assert.equal(args[1].valueFor, 0);
        assert.equal(args[2].raw, 'sql');
        assert.equal(args[2].valueFor, null);
        const q = args.find((a) => a.name === 'q');
        const sql = args[args.indexOf(q) + 1];
        assert.equal(sql.value, 'select current_role()');
        assert.equal(sql.valueFor, args.indexOf(q));
    });

    it('Argv_SnowSqlWithComments_MultilineLiteralKeptVerbatim', async () => { // A5b
        // Arrange / Act
        const facts = await client.argv('snow sql -q "-- note\n/* x */ DELETE FROM t WHERE id = 1"', CWD);
        // Assert
        const sql = facts.commands[0].args.find((a) => a.k === 'word' && /DELETE/.test(a.value ?? ''));
        assert.ok(sql);
        assert.ok(sql.value.startsWith('-- note\n/* x */ DELETE'));
        assert.equal(sql.isConst, true);
    });

    it('Argv_SetLocation_EffectiveCwdTrackedForLaterCommands', async () => { // A6
        // Arrange
        const script = `Set-Location -LiteralPath '${ELSEWHERE}'; git status`;
        // Act
        const facts = await client.argv(script, HOME);
        // Assert
        assert.ok(samePath(facts.commands[0].cwd, HOME));
        assert.ok(samePath(facts.commands[1].cwd, ELSEWHERE), facts.commands[1].cwd);
        assert.equal(facts.commands[1].cwdKnown, true);
    });

    it('Argv_PushAndPopLocation_CwdRestoredAfterPop', async () => {
        // Arrange
        const script = `Push-Location '${ELSEWHERE}'; Get-Item a; Pop-Location; Get-Item b`;
        // Act
        const facts = await client.argv(script, CWD);
        // Assert
        const items = facts.commands.filter((c) => c.name === 'get-item');
        assert.ok(samePath(items[0].cwd, ELSEWHERE));
        assert.ok(samePath(items[1].cwd, CWD));
    });

    it('Argv_SetLocationDynamicTarget_CwdBecomesUnknown', async () => {
        // Arrange / Act
        const facts = await client.argv('Set-Location $x; Get-Item a', CWD);
        // Assert
        assert.equal(facts.commands[1].cwdKnown, false);
        assert.equal(facts.commands[1].cwd, null);
    });

    it('Argv_NullSinkRedirect_FlaggedAsNullSink', async () => { // A7
        // Arrange / Act
        const facts = await client.argv('grep x 2>$null', CWD);
        // Assert
        const r = facts.commands[0].redirs;
        assert.equal(r.length, 1);
        assert.equal(r[0].nullSink, true);
    });

    it('Argv_WriteHostString_NotPathBound', async () => { // A8
        // Arrange / Act
        const facts = await client.argv("Write-Host 'C:\\Windows\\foo'", CWD);
        // Assert
        assert.equal(facts.commands[0].args[0].pathParam, false);
    });

    it('Argv_FullPathExecutable_ReportedByBasename', async () => { // A9
        // Arrange / Act
        const facts = await client.argv('& "C:\\Program Files\\Snowflake CLI\\snow.exe" sql -q x', CWD);
        // Assert
        const c = facts.commands[0];
        assert.equal(c.name, 'snow');
        assert.equal(c.inv, 'exe');
        assert.ok(samePath(c.exeValue, 'C:\\Program Files\\Snowflake CLI\\snow.exe'));
    });

    it('Argv_AssignedConstantVariable_PropagatedIntoPathArgument', async () => { // A10
        // Arrange / Act
        const facts = await client.argv('$d = "$env:TEMP\\tf"; Remove-Item $d\\y', CWD);
        // Assert
        const w = facts.commands[0].args[0];
        assert.equal(w.isConst, true);
        assert.ok(samePath(w.value, join(TEMP, 'tf', 'y')), w.value);
        assert.deepEqual(facts.constVars, ['d']);
    });

    it('Argv_ReassignedVariable_NotConstant', async () => {
        // Arrange / Act
        const facts = await client.argv('$d = "a"; $d = "b"; Remove-Item $d', CWD);
        // Assert
        assert.equal(facts.commands[0].args[0].isConst, false);
        assert.deepEqual(facts.constVars, []);
    });

    it('Argv_PwshDashCommand_InnerScriptExtractedRecursively', async () => { // A11
        // Arrange
        const inner = join(HOME, '.copilot', 'x');
        // Act
        const facts = await client.argv(`pwsh -NoProfile -Command 'Remove-Item ${inner}'`, CWD);
        // Assert
        assert.equal(facts.flags.nestedShell, true);
        assert.equal(facts.commands[0].inner.commands[0].name, 'remove-item');
    });

    it('Argv_PwshEncodedCommandColonForm_DecodedAndAnalysed', async () => {
        // Arrange
        const encoded = Buffer.from('Get-Date', 'utf16le').toString('base64');
        // Act
        const facts = await client.argv(`pwsh -EncodedCommand:${encoded}`, CWD);
        // Assert
        assert.equal(facts.flags.encoded, true);
        assert.equal(facts.commands[0].inner.encodedDecoded, true);
        assert.equal(facts.commands[0].inner.commands[0].name, 'get-date');
    });

    it('Argv_PwshEncodedCommandSeparateArgument_FlaggedUndecodableLikeV2', async () => {
        // Arrange (v2 behaviour kept for parity with the S6 research result: only the colon form is decoded)
        const encoded = Buffer.from('Get-Date', 'utf16le').toString('base64');
        // Act
        const facts = await client.argv(`pwsh -EncodedCommand ${encoded}`, CWD);
        // Assert
        assert.equal(facts.flags.encoded, true);
        assert.equal(facts.flags.undecodable, true);
        assert.equal(facts.flags.nestedDynamic, true);
        assert.equal(facts.commands[0].inner, null);
    });

    it('Argv_CmdSlashC_InnerTextRecorded', async () => { // A11b
        // Arrange / Act
        const facts = await client.argv('cmd /c "del /q x.txt"', CWD);
        // Assert
        const inner = facts.commands[0].inner;
        assert.equal(inner.kind, 'cmd');
        assert.match(inner.text, /del/);
    });

    it('Argv_IexOfLiteral_InnerScriptExtractedAndDepthLimited', async () => {
        // Arrange / Act
        const facts = await client.argv('iex "iex \'Get-Date\'"', CWD);
        // Assert
        assert.equal(facts.flags.iex, true);
        assert.equal(facts.commands[0].inner.commands[0].inner.commands[0].name, 'get-date');
    });

    it('Argv_UnresolvedInvocationVariable_IsDynamic', async () => { // A12
        // Arrange / Act
        const facts = await client.argv("& $v 'x'", CWD);
        // Assert
        assert.equal(facts.commands[0].inv, 'dynamic');
        assert.equal(facts.flags.dynamic, true);
    });

    it('Argv_InvocationVariableWithConstantExe_ResolvesToExeCommand', async () => { // A12b
        // Arrange / Act
        const facts = await client.argv('$exe = "$env:TEMP\\tf\\terraform.exe"; & $exe version', CWD);
        // Assert
        const c = commandNamed(facts, 'terraform');
        assert.ok(c);
        assert.equal(c.inv, 'exe');
        assert.ok(samePath(c.exeValue, join(TEMP, 'tf', 'terraform.exe')));
    });

    it('Argv_UnterminatedString_ParseErrorWithCategory', async () => { // A13
        // Arrange / Act
        const facts = await client.argv("git status 'unterminated", CWD);
        // Assert
        assert.ok(facts.parseErrors.length > 0);
        assert.equal(typeof facts.parseErrors[0].category, 'string');
    });

    it('Argv_SetLocationThenRelativeRead_PathBindingOfSetLocationButCwdOfNextCommand', async () => { // B13 (fact side)
        // Arrange / Act
        const facts = await client.argv(`Set-Location '${ELSEWHERE}'; Get-ChildItem .`, CWD);
        // Assert
        const [setLoc, getChild] = facts.commands;
        assert.equal(setLoc.name, 'set-location');
        assert.equal(setLoc.args[0].pathParam, true);
        assert.ok(samePath(setLoc.cwd, CWD)); // path argument is resolved against the previous cwd
        assert.ok(samePath(getChild.cwd, ELSEWHERE));
    });

    it('Argv_PipedCommand_PipedFromFlagged', async () => {
        // Arrange / Act
        const facts = await client.argv('Get-Process | Select-Object Name', CWD);
        // Assert
        assert.equal(facts.commands[0].pipedFrom, false);
        assert.equal(facts.commands[1].pipedFrom, true);
    });
});

// DROPPED from s4-selftest.mjs A/B13 scope: A14 ("search pattern does not leak into signature") — tests engine
// signature normalisation (T8); the worker returns raw facts and has no signature.
