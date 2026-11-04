// TFIX-8: pass-through filters that can EMIT new objects between a text source and Select-String. Select-String reads files for FileInfo
// objects it receives, so after a data source (Get-Content / native output)
//   - ForEach-Object (every alias and parameter form: script block, -Process/-Begin/-End, -MemberName) can emit anything: always "paths";
//   - Where-Object, Sort-Object, Select-Object, Tee-Object, Group-Object, Get-Unique with an -InputObject value (any accepted prefix, also
//     the colon form) replace their pipeline input by that value: "paths"; without one they keep the kind of their input.
// Probe (pwsh 7.6.7, synthetic folder): ForEach-Object { gci } / -Begin / -End read the files (count > 0); -MemberName (Directory, PSPath, PSDrive,
// PSProvider, ToString, GetType, Length, PSChildName) and every -InputObject form read none after a text source (the piped text cannot bind, so the
// command fails or stays silent), Select-Object -ExpandProperty PSPath / PSDrive stays data. The -InputObject forms are classified "paths" anyway
// (conservative: the value is emitted whenever the cmdlet runs without pipeline input).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CWD, createClient } from './harness.mjs';

/** Forms (LISTING = a listing expression) that must be a path source after text. */
const EMITTING = [
    'ForEach-Object { Get-ChildItem LIT }', '% { Get-ChildItem LIT }', 'foreach { Get-ChildItem LIT }', 'ForEach-Object -Process { Get-ChildItem LIT }',
    'ForEach-Object -Begin { Get-ChildItem LIT } -Process { $_ }', 'ForEach-Object -Process { $_ } -End { Get-ChildItem LIT }', 'ForEach-Object { $_ } { } { Get-ChildItem LIT }',
    'ForEach-Object { $_ }', '% { $_ }', 'foreach { $_.Name }', 'ForEach-Object -MemberName Directory', '% -MemberName PSPath', 'foreach -MemberName ToString',
    'ForEach-Object -InputObject LISTING { $_ }', 'ForEach-Object -inp LISTING -Process { $_ }',
    'Select-Object -InputObject LISTING', 'Select-Object -InputObject:LISTING', 'Select-Object -inp LISTING', 'select -InputObject LISTING -First 5',
    'Select-Object -InputObject LISTING -ExpandProperty Name',
    'Tee-Object -InputObject LISTING -Variable v', 'Tee-Object -InputObject:LISTING -Variable v', 'tee -inp LISTING -Variable v',
    'Sort-Object -InputObject LISTING', 'Sort-Object -InputObject:LISTING', 'sort -inp LISTING', 'Sort-Object -Inpu LISTING -Unique',
    'Group-Object -InputObject LISTING', 'group -inp LISTING -NoElement', 'Group-Object -InputObject:LISTING',
    'Get-Unique -InputObject LISTING', 'gu -inp LISTING', 'Get-Unique -InputObject:LISTING -AsString',
    'Where-Object -InputObject LISTING { $true }', 'where -inp LISTING { $true }', '? -InputObject LISTING { $true }', 'Where-Object -InputObject:LISTING -Property Name -Like *',
];

/** Forms that keep the kind of their text input. */
const TEXT_KEPT = [
    'Where-Object { $true }', 'where { $_ }', '? { $_ }', 'Where-Object Name -like a*', 'Where-Object { Get-ChildItem LIT }',
    'Sort-Object', 'Sort-Object -Unique', 'sort -Descending', 'Sort-Object -Property Length', 'Sort-Object -Top 3',
    'Select-Object -First 3', 'Select-Object -Last 2', 'Select-Object -Unique', 'Select-Object -Property Name', 'Select-Object -Property *', 'select -ExpandProperty PSPath',
    'Select-Object -ExpandProperty PSDrive', 'Select-Object -Skip 1', 'Select-Object -Index 0',
    'Tee-Object -Variable v', 'tee -FilePath out.txt', 'Tee-Object -FilePath out.txt -Append',
    'Group-Object', 'group -NoElement', 'Group-Object -Property Length', 'Group-Object -AsHashTable', 'Get-Unique', 'gu', 'Get-Unique -AsString', 'Get-Unique -OnType',
    'Write-Output', 'Get-Random -Count 3', 'Sort-Object | Select-Object -First 2 | Where-Object { $true }',
];

describe('pipe source: emitting pass-through filters are path sources (TFIX-8)', () => {
    let client;
    let tmp;
    before(() => {
        client = createClient().client;
        tmp = mkdtempSync(join(tmpdir(), 'tfix8-pipe-'));
        writeFileSync(join(tmp, 'a.txt'), 'needle in a');
        writeFileSync(join(tmp, 'b.txt'), 'needle in b');
        writeFileSync(join(tmp, 'x.dat'), 'plain text line\nsecond line');
    });
    after(async () => {
        await client.stop();
        rmSync(tmp, { recursive: true, force: true });
    });

    const kindOf = async (script) => {
        const f = await client.argv(script, CWD);
        return f.commands[f.commands.length - 1].pipeSource;
    };
    const expand = (form) => form.replaceAll('LISTING', '(Get-ChildItem)').replaceAll('LIT', 'C:\\x');

    for (const form of EMITTING) {
        it(`Argv_PipeSource_${form.replace(/\W+/g, '_')}_AfterTextIsPaths`, async () => {
            // Act
            const overContent = await kindOf(`Get-Content x | ${expand(form)} | Select-String foo`);
            const overNative = await kindOf(`rg -l x | ${expand(form)} | Select-String foo`);
            const chained = await kindOf(`Get-Content x | Sort-Object | ${expand(form)} | Where-Object { $true } | Select-String foo`);
            // Assert
            assert.equal(overContent, 'paths', form);
            assert.equal(overNative, 'paths', form);
            assert.equal(chained, 'paths', form);
        });
    }

    for (const form of TEXT_KEPT) {
        it(`Argv_PipeSource_${form.replace(/\W+/g, '_')}_KeepsTheKindOfItsInput`, async () => {
            // Act
            const overText = await kindOf(`Get-Content x | ${expand(form)} | Select-String foo`);
            const overListing = await kindOf(`Get-ChildItem | ${expand(form)} | Select-String foo`);
            // Assert
            assert.equal(overText, 'data', `${form}: text stays text`);
            assert.equal(overListing, 'paths', `${form}: a listing stays a listing`);
        });
    }

    it('Argv_PipeSource_ForEachObjectAfterListing_StaysPaths_AndLaterTextSourceStillWins', async () => {
        // Arrange / Act
        const afterListing = await kindOf('Get-ChildItem | ForEach-Object { $_ } | Select-String foo');
        const emitterBeforeText = await kindOf('Get-Content x | ForEach-Object { $_ } | Get-Content y | Select-String foo');
        const nativeThenFilter = await kindOf('rg -l x | Sort-Object | Select-String foo');
        // Assert
        assert.equal(afterListing, 'paths');
        assert.equal(emitterBeforeText, 'data', 'Get-Content directly before Select-String is the text source');
        assert.equal(nativeThenFilter, 'data');
    });

    it('Argv_PipeSource_AmbiguousOrUnrelatedParameterPrefixes_AreNotInputObject', async () => {
        // Arrange / Act: -In on Where-Object is the -In operator, -Ind on Select-Object is -Index, -i on Sort-Object IS InputObject
        const whereIn = await kindOf('Get-Content x | Where-Object Name -In a,b | Select-String foo');
        const selectIndex = await kindOf('Get-Content x | Select-Object -Ind 0 | Select-String foo');
        const sortPrefix = await kindOf('Get-Content x | Sort-Object -i (Get-ChildItem) | Select-String foo');
        const sortVerbose = await kindOf('Get-Content x | Sort-Object -Verbose | Select-String foo');
        const groupInfo = await kindOf('Get-Content x | Group-Object -InformationAction Ignore | Select-String foo');
        // Assert
        assert.equal(whereIn, 'data');
        assert.equal(selectIndex, 'data');
        assert.equal(sortPrefix, 'paths');
        assert.equal(sortVerbose, 'data');
        assert.equal(groupInfo, 'data');
    });

    it('Powershell_EmittingFilterForms_BehaveAsProbed', () => {
        // Arrange: files read through each form after a text source ('x.dat' holds no keyword); a count > 0 proves the form emits FileInfo
        const script = [
            '$ErrorActionPreference = "SilentlyContinue"',
            '$t = $env:TFIX8_TMP',
            '$out = [ordered]@{}',
            'foreach ($m in (ConvertFrom-Json $env:TFIX8_FORMS)) {',
            `  $src = $m -creplace "LISTING", "(Get-ChildItem -LiteralPath '$t' -Filter *.txt)" -creplace "LIT", ("'" + $t + "'")`,
            `  try { $sb = [scriptblock]::Create("Get-Content -LiteralPath '$t\\x.dat' | $src | Select-String needle"); $out[$m] = @(& $sb | Where-Object { $_ -is [Microsoft.PowerShell.Commands.MatchInfo] -and $_.Filename -in "a.txt", "b.txt" }).Count } catch { $out[$m] = "ERR" }`,
            '}',
            '$out["sentinel"] = @(Get-ChildItem -LiteralPath $t -Filter *.txt | Select-String needle).Count',
            '$out | ConvertTo-Json -Compress',
        ].join('\n');
        const forms = [...EMITTING.filter((f) => !f.includes('GetType')), ...TEXT_KEPT.filter((f) => !f.includes('out.txt') && !f.includes('LIT'))];
        let json;
        try {
            json = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8', windowsHide: true, timeout: 240000, env: { ...process.env, TFIX8_TMP: tmp, TFIX8_FORMS: JSON.stringify(forms) },
            });
        } catch (e) {
            assert.fail(`pwsh run failed: ${e.message}`);
        }
        const counts = JSON.parse(json.trim().split(/\r?\n/).pop());

        // Assert
        assert.equal(counts.sentinel, 2, 'the harness reads the synthetic files');
        const readers = ['ForEach-Object { Get-ChildItem LIT }', '% { Get-ChildItem LIT }', 'foreach { Get-ChildItem LIT }', 'ForEach-Object -Process { Get-ChildItem LIT }',
            'ForEach-Object -Begin { Get-ChildItem LIT } -Process { $_ }', 'ForEach-Object -Process { $_ } -End { Get-ChildItem LIT }'];
        for (const form of readers) assert.ok(counts[form] >= 1, `${form}: reads the files (got ${JSON.stringify(counts[form])})`);
        // every form whose real count is > 0 must be classified "paths" (EMITTING); the TEXT_KEPT forms must read nothing
        for (const form of TEXT_KEPT.filter((f) => !f.includes('out.txt') && !f.includes('LIT'))) assert.equal(counts[form], 0, `${form}: reads nothing after text`);
    });
});
