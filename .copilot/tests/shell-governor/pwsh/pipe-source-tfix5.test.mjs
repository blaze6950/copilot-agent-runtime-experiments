// TFIX-5 item 1: audit of the "data" pipeline producers (worker.ps1 $v2PipeData). A producer is "data" only when it never re-emits
// its pipeline input objects: Select-String reads files for FileInfo items it receives, so a re-emitting cmdlet (Get-Random) between a
// Get-ChildItem listing and Select-String must keep the kind of the listing ("paths"). The empirical part runs real PowerShell against
// a synthetic temp folder (no real files are read).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CWD, createClient } from './harness.mjs';

/** Members of $v2PipeData after TFIX-5 (get-random moved to the pass-through set), with what the audit found. */
const DATA_MEMBERS = [
    'ConvertFrom-Json', 'ConvertFrom-Csv', 'ConvertFrom-StringData', 'Get-Process', 'Get-Service', 'Get-Date', 'Get-Command', 'Get-Host',
    'Get-Help', 'Get-Module', 'Get-Alias', 'Get-History', 'Get-WinEvent', 'Get-EventLog', 'Out-String', 'Format-List', 'Format-Table',
    'Measure-Object', 'Invoke-RestMethod', 'Invoke-WebRequest', 'Join-Path', 'Split-Path', 'Test-Path', 'Get-Clipboard', 'Select-String needle',
];

/** Members whose pipeline legitimately fails in real PowerShell (the pipeline stops at the member, so no file is read): reported as 'ERR', never as a count.
 * Every other member must report a number, so a typo or a broken pipeline cannot pass as "0 files read". */
const EXPECTED_ERR = new Map([
    ['ConvertFrom-Json', 'rejects a FileInfo path as invalid JSON'],
    ['ConvertFrom-StringData', 'rejects a FileInfo path as invalid name=value data'],
    ['Get-Module', 'FileInfo input binds -Name and conflicts with the parameter set'],
    ['Invoke-RestMethod', 'needs a -Uri (no network access in a test)'],
    ['Invoke-WebRequest', 'needs a -Uri (no network access in a test)'],
    ['Get-EventLog', 'only exists in Windows PowerShell 5.1'],
]);

describe('pipe source audit (TFIX-5 item 1)', () => {
    let client;
    let tmp;
    before(() => {
        client = createClient().client;
        tmp = mkdtempSync(join(tmpdir(), 'tfix5-pipe-'));
        writeFileSync(join(tmp, 'a.txt'), 'needle in a');
        writeFileSync(join(tmp, 'b.txt'), 'needle in b');
        mkdirSync(join(tmp, 'sub'));
    });
    after(async () => {
        await client.stop();
        rmSync(tmp, { recursive: true, force: true });
    });

    const kindOf = async (script) => {
        const f = await client.argv(script, CWD);
        return f.commands[f.commands.length - 1].pipeSource;
    };

    for (const member of DATA_MEMBERS) {
        it(`Argv_PipeSource_${member.split(' ')[0]}_IsDataBecauseItNeverReEmitsItsInput`, async () => {
            // Act / Assert
            assert.equal(await kindOf(`Get-ChildItem | ${member} | Select-String x`), 'data', member);
        });
    }

    it('Argv_PipeSource_GetRandom_KeepsTheKindOfItsInput', async () => {
        // Arrange / Act: Get-Random re-emits the objects it receives
        const fromListing = await kindOf('Get-ChildItem $HOME -Force | Get-Random -Count 100 | Select-String foo');
        const noCount = await kindOf('Get-ChildItem | Get-Random | Select-String foo');
        const alone = await kindOf('Get-Random | Select-String foo');
        const fromText = await kindOf('Get-Content x | Get-Random -Count 3 | Select-String foo');
        const viaAlias = await kindOf('gci | Get-Random | Select-String foo');
        // Assert
        assert.equal(fromListing, 'paths');
        assert.equal(noCount, 'paths');
        assert.equal(alone, 'paths', 'unknown input: stays on the safe side');
        assert.equal(fromText, 'data', 'text lines stay text lines');
        assert.equal(viaAlias, 'paths');
    });

    it('Argv_PipeSource_WriteOutputWithoutArguments_PassesItsInputThrough', async () => {
        // Arrange / Act
        const fromListing = await kindOf('Get-ChildItem | Write-Output | Select-String x');
        const fromText = await kindOf('Get-Content x | Write-Output | Select-String x');
        const constText = await kindOf("Write-Output 'a' | Select-String x");
        const variable = await kindOf('Write-Output $f | Select-String x');
        // Assert
        assert.equal(fromListing, 'paths');
        assert.equal(fromText, 'data');
        assert.equal(constText, 'data');
        assert.equal(variable, 'paths');
    });

    it('Argv_PipeSource_GetUnique_FollowsItsInput', async () => { // TFIX-6 F3: Get-Unique re-emits its input; the engine already treats it as pass-through
        // Arrange / Act
        const fromText = await kindOf('Get-Content x | Get-Unique | Select-String foo');
        const fromTextAlias = await kindOf('Get-Content x | gu | Select-String foo');
        const fromListing = await kindOf('gci | Get-Unique | Select-String foo');
        const fromListingLong = await kindOf('Get-ChildItem | Get-Unique | Select-String foo');
        const chained = await kindOf('Get-Content x | Sort-Object | Get-Unique | Select-String foo');
        // Assert
        assert.equal(fromText, 'data');
        assert.equal(fromTextAlias, 'data');
        assert.equal(fromListing, 'paths');
        assert.equal(fromListingLong, 'paths');
        assert.equal(chained, 'data');
    });

    it('Argv_PipeSource_GetRandomAndWriteOutputWithInputObjectValue_AreNotPassThrough', async () => { // TFIX-6 F4: the value, not the pipeline, feeds the output
        // Arrange / Act
        const cases = {
            randomSpace: await kindOf('Get-Content x | Get-Random -InputObject (Get-ChildItem) | Select-String foo'),
            randomColon: await kindOf('Get-Content x | Get-Random -InputObject:(Get-ChildItem) | Select-String foo'),
            randomPrefix: await kindOf('Get-Content x | Get-Random -Inp (Get-ChildItem) -Count 3 | Select-String foo'),
            randomPositional: await kindOf('Get-Content x | Get-Random (Get-ChildItem) | Select-String foo'),
            outputSpace: await kindOf('Get-Content x | Write-Output -InputObject (Get-ChildItem) | Select-String foo'),
            outputColon: await kindOf('Get-Content x | Write-Output -InputObject:(Get-ChildItem) | Select-String foo'),
            outputColonVariable: await kindOf('Get-Content x | Write-Output -InputObject:$f | Select-String foo'),
            outputAlias: await kindOf('Get-Content x | echo -InputObject:$f | Select-String foo'),
        };
        // Assert
        for (const [id, kind] of Object.entries(cases)) assert.equal(kind, 'paths', id);
    });

    it('Argv_PipeSource_GetRandomAndWriteOutputWithoutInputObject_StillPassThroughOrConstant', async () => { // TFIX-6 F4: the fix must not break the harmless forms
        // Arrange / Act
        const randomCount = await kindOf('Get-Content x | Get-Random -Count 3 | Select-String foo');
        const randomShuffle = await kindOf('Get-Content x | Get-Random -Count 3 -SetSeed 4 | Select-String foo');
        const randomMax = await kindOf('Get-Content x | Get-Random -Maximum 10 | Select-String foo');
        const outputSwitch = await kindOf('Get-Content x | Write-Output -NoEnumerate | Select-String foo');
        const outputConstColon = await kindOf("Get-ChildItem | Write-Output -InputObject:'text' | Select-String foo");
        const outputListing = await kindOf('Get-ChildItem | Write-Output | Select-String foo');
        // Assert
        assert.equal(randomCount, 'data');
        assert.equal(randomShuffle, 'data');
        assert.equal(randomMax, 'data');
        assert.equal(outputSwitch, 'data');
        assert.equal(outputConstColon, 'data', 'constant text only');
        assert.equal(outputListing, 'paths');
    });

    it('Argv_PipeSource_PassThroughFilters_AreNeverInTheDataSet', async () => {
        // Arrange / Act: every filter that can re-emit its input must inherit the kind of the listing before it
        const filters = ['Where-Object { $true }', 'Sort-Object', 'Select-Object -First 5', 'ForEach-Object { $_ }', 'Tee-Object -Variable v', 'Group-Object',
            'Get-Unique', 'Select-Object -Unique', 'Write-Output', 'Get-Random -Count 9', 'Sort-Object -Unique', 'Where-Object Name -like a*', 'Out-Null'];
        // Assert
        for (const filter of filters) {
            assert.equal(await kindOf(`Get-ChildItem | ${filter} | Select-String x`), 'paths', filter);
        }
    });

    it('Powershell_DataMembersBetweenListingAndSelectString_ReadNoFile', () => {
        // Arrange: the same pipeline in real PowerShell; the count is the number of lines Select-String printed ('ERR' when the pipeline itself failed)
        const script = [
            '$ErrorActionPreference = "SilentlyContinue"',
            '$t = $env:TFIX5_TMP',
            '$out = [ordered]@{}',
            'foreach ($m in ($env:TFIX5_MEMBERS -split ";")) {',
            `  try { $sb = [scriptblock]::Create("Get-ChildItem -LiteralPath '$t' | $m | Select-String needle"); $out[$m] = @(& $sb).Count } catch { $out[$m] = 'ERR' }`,
            '}',
            '$out["baseline"] = @(Get-ChildItem -LiteralPath $t | Select-String needle).Count',
            '$out["Get-Random -Count 100"] = @(Get-ChildItem -LiteralPath $t | Get-Random -Count 100 | Select-String needle).Count',
            '$out["Write-Output"] = @(Get-ChildItem -LiteralPath $t | Write-Output | Select-String needle).Count',
            '$out["Get-Unique"] = @(Get-ChildItem -LiteralPath $t | Get-Unique | Select-String needle).Count',
            '$out["Get-Random -InputObject"] = @(Get-Random -InputObject (Get-ChildItem -LiteralPath $t) -Count 100 | Select-String needle).Count',
            '$out["Write-Output -InputObject"] = @(Write-Output -InputObject (Get-ChildItem -LiteralPath $t) | Select-String needle).Count',
            '$out | ConvertTo-Json -Compress',
        ].join('\n');
        let json;
        try {
            json = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, TFIX5_TMP: tmp, TFIX5_MEMBERS: DATA_MEMBERS.join(';') },
            });
        } catch (e) {
            assert.fail(`pwsh run failed: ${e.message}`);
        }
        const counts = JSON.parse(json.trim().split(/\r?\n/).pop());

        // Assert: the harness is meaningful (Select-String does read the listed files) and the re-emitting cmdlet does too
        assert.equal(counts.baseline, 2, 'Get-ChildItem | Select-String reads both files');
        assert.equal(counts['Get-Random -Count 100'], 2, 'Get-Random re-emits the FileInfo objects, so the files are read');
        assert.equal(counts['Write-Output'], 2, 'Write-Output without arguments re-emits its pipeline input');
        assert.equal(counts['Get-Unique'], 2, 'Get-Unique re-emits its pipeline input (F3: it is pass-through)');
        assert.equal(counts['Get-Random -InputObject'], 2, 'Get-Random -InputObject emits its value (FileInfo): kind "paths" (F4)');
        assert.equal(counts['Write-Output -InputObject'], 2, 'Write-Output -InputObject emits its value (FileInfo): kind "paths" (F4)');
        for (const [name, count] of Object.entries(counts)) {
            const member = DATA_MEMBERS.find((m) => m === name);
            if (member && EXPECTED_ERR.has(member)) assert.equal(count, 'ERR', `${name}: ${EXPECTED_ERR.get(member)}`);
            else assert.equal(typeof count, 'number', `${name} must be a number (the pipeline must have run), got ${JSON.stringify(count)}`);
        }
        for (const member of DATA_MEMBERS) {
            if (member.startsWith('Select-String') || EXPECTED_ERR.has(member)) continue; // the first Select-String is itself the reader (flagged on its own); see the audit note
            assert.equal(counts[member], 0, `${member} must not hand FileInfo objects to Select-String`);
        }
    });

    it('Powershell_ListingPipelineSentinel_ProvesTheHarnessRan', () => { // TFIX-6 F6: `Get-ChildItem <tmp> | Select-String needle` is 2 in a fresh run, so a 0 elsewhere is not a failed pipeline
        // Arrange / Act
        const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-ChildItem -LiteralPath $env:TFIX5_TMP | Select-String needle).Count'], {
            encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, TFIX5_TMP: tmp },
        });
        // Assert
        assert.equal(Number(out.trim().split(/\r?\n/).pop()), 2);
    });
});
