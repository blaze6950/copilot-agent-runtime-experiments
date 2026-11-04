// TFIX-7 item 2: Write-Output / Get-Random between a producer and Select-String. A switch or common parameter (with or without a
// value: -Verbose:0, -NoEnumerate:$false, -ErrorAction Stop) is NOT a list value: the cmdlet still re-emits its pipeline input and the
// pipe source stays the kind of the element before it. Only InputObject (any prefix PowerShell binds to it) or a positional value is a list
// value. Each form is classified by the worker AND run in real PowerShell on a synthetic temp folder (no real files are read), so the
// classification is checked against what Select-String really receives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CWD, createClient } from './harness.mjs';

/** Forms that keep re-emitting their pipeline input (no list value). */
const PASS_THROUGH = [
    'Write-Output', 'Write-Output -Verbose:0', 'Write-Output -Verbose:$false', 'Write-Output -Verbose', 'Write-Output -Debug:$true', 'Write-Output -Debug',
    'Write-Output -NoEnumerate', 'Write-Output -NoEnumerate:0', 'Write-Output -NoEnumerate:$false', 'Write-Output -n:$false', 'Write-Output -ErrorAction SilentlyContinue',
    'Write-Output -ErrorAction:SilentlyContinue', 'Write-Output -ea SilentlyContinue', 'Write-Output -WarningAction SilentlyContinue', 'Write-Output -InformationAction Ignore',
    'Write-Output -infa Ignore', 'Write-Output -ErrorVariable ev', 'Write-Output -OutVariable ov', 'Write-Output -PipelineVariable pv', 'Write-Output -ProgressAction SilentlyContinue',
    'Write-Output -NoEnumerate -Verbose:0 -ErrorAction SilentlyContinue', 'echo -Verbose:0',
    'Get-Random -Count 3', 'Get-Random -Count 3 -Verbose:0', 'Get-Random -Count 3 -Debug', 'Get-Random -Count 3 -SetSeed 1', 'Get-Random -Count 3 -ErrorAction SilentlyContinue',
    'Get-Random -Count 3 -ea SilentlyContinue', 'Get-Random -Count 3 -Verbose', 'Get-Random -Verbose:0', 'Get-Random -Verbose', 'Get-Random -Debug', 'Get-Random -SetSeed 1',
    'Get-Random -ErrorAction SilentlyContinue', 'Get-Random -ErrorVariable ev', 'Get-Random -Count 2 -OutVariable ov',
];

/** Forms with a list value (LISTING is a listing expression): the value feeds the output, not the pipeline. */
const LIST_VALUE = [
    'Write-Output -InputObject LISTING', 'Write-Output -InputObject:LISTING', 'Write-Output -i LISTING', 'Write-Output -in LISTING', 'Write-Output -inp LISTING',
    'Write-Output -Input:LISTING', 'Write-Output LISTING', 'Write-Output -Verbose LISTING', 'Write-Output -NoEnumerate LISTING', 'Write-Output -Debug:$false LISTING',
    'Write-Output -ErrorAction SilentlyContinue LISTING', 'Write-Output -ea Stop -Verbose:0 LISTING', 'Write-Output -NoEnumerate:$false -InputObject LISTING',
    'Write-Output -Foo LISTING', 'echo -Verbose LISTING',
    'Get-Random -InputObject LISTING', 'Get-Random -InputObject:LISTING', 'Get-Random -i LISTING', 'Get-Random -Inp LISTING -Count 3', 'Get-Random LISTING',
    'Get-Random -Verbose LISTING', 'Get-Random -Debug LISTING', 'Get-Random -Shuffle LISTING', 'Get-Random -Count 3 LISTING', 'Get-Random -ErrorAction SilentlyContinue LISTING',
    'Get-Random -Verbose:0 LISTING', 'Get-Random -SetSeed 1 LISTING',
];

describe('pipe source: switch and common parameters of Write-Output / Get-Random (TFIX-7 item 2)', () => {
    let client;
    let tmp;
    before(() => {
        client = createClient().client;
        tmp = mkdtempSync(join(tmpdir(), 'tfix7-pipe-'));
        writeFileSync(join(tmp, 'a.txt'), 'needle in a');
        writeFileSync(join(tmp, 'b.txt'), 'needle in b');
    });
    after(async () => {
        await client.stop();
        rmSync(tmp, { recursive: true, force: true });
    });

    const kindOf = async (script) => {
        const f = await client.argv(script, CWD);
        return f.commands[f.commands.length - 1].pipeSource;
    };

    for (const form of PASS_THROUGH) {
        it(`Argv_PipeSource_${form.replace(/\W+/g, '_')}_PassesItsInputThrough`, async () => {
            // Act
            const overText = await kindOf(`Get-Content x | ${form} | Select-String foo`);
            const overListing = await kindOf(`Get-ChildItem | ${form} | Select-String foo`);
            // Assert
            assert.equal(overText, 'data', `${form}: text stays text`);
            assert.equal(overListing, 'paths', `${form}: a listing stays a listing`);
        });
    }

    for (const form of LIST_VALUE) {
        it(`Argv_PipeSource_${form.replace(/\W+/g, '_')}_FollowsItsListValue`, async () => {
            // Act
            const overText = await kindOf(`Get-Content x | ${form.replaceAll('LISTING', '(Get-ChildItem)')} | Select-String foo`);
            // Assert
            assert.equal(overText, 'paths', form);
        });
    }

    it('Argv_PipeSource_ConstantListValues_AreData', async () => {
        // Arrange / Act
        const cases = {
            positional: await kindOf("Get-ChildItem | Write-Output 'x' | Select-String foo"),
            inputObject: await kindOf("Get-ChildItem | Write-Output -InputObject:'text' | Select-String foo"),
            afterSwitch: await kindOf("Get-ChildItem | Write-Output -Verbose:0 'x' | Select-String foo"),
            afterValued: await kindOf("Get-ChildItem | Write-Output -ErrorAction Stop 'x' | Select-String foo"),
            unknownParameter: await kindOf('Get-ChildItem | Write-Output -Foo | Select-String foo'),
            randomMaximum: await kindOf('Get-Content x | Get-Random -Maximum 10 | Select-String foo'),
            randomPositionalNumber: await kindOf('Get-Content x | Get-Random 10 | Select-String foo'),
        };
        // Assert
        for (const [id, kind] of Object.entries(cases)) assert.equal(kind, 'data', id);
    });

    it('Argv_PipeSource_NonConstantValuesAndAmbiguousParameters_StayPaths', async () => {
        // Arrange / Act
        const cases = {
            variable: await kindOf('Get-Content x | Write-Output $f | Select-String foo'),
            colonVariable: await kindOf('Get-Content x | Write-Output -InputObject:$f | Select-String foo'),
            afterSwitchVariable: await kindOf('Get-Content x | Write-Output -Verbose:0 $f | Select-String foo'),
            splat: await kindOf('Get-Content x | Write-Output @a | Select-String foo'),
            ambiguous: await kindOf('Get-Content x | Write-Output -e | Select-String foo'),
            unknownWithVariable: await kindOf('Get-Content x | Write-Output -Foo:$f | Select-String foo'),
        };
        // Assert
        for (const [id, kind] of Object.entries(cases)) assert.equal(kind, 'paths', id);
    });

    it('Powershell_SwitchAndCommonParameterForms_BehaveAsClassified', () => {
        // Arrange: pass-through forms must hand the listing on (files read > 0); list-value forms must read files without any upstream listing
        const script = [
            '$ErrorActionPreference = "SilentlyContinue"',
            '$t = $env:TFIX7_TMP',
            '$out = [ordered]@{}',
            'foreach ($m in (ConvertFrom-Json $env:TFIX7_PASS)) {',
            `  try { $sb = [scriptblock]::Create("Get-ChildItem -LiteralPath '$t' | $m | Select-String needle"); $out["P|$m"] = @(& $sb | Where-Object { $_ -is [Microsoft.PowerShell.Commands.MatchInfo] }).Count } catch { $out["P|$m"] = 'ERR' }`,
            '}',
            'foreach ($m in (ConvertFrom-Json $env:TFIX7_VALUE)) {',
            `  try { $sb = [scriptblock]::Create(($m -replace "LISTING", "(Get-ChildItem -LiteralPath '$t')") + " | Select-String needle"); $out["V|$m"] = @(& $sb | Where-Object { $_ -is [Microsoft.PowerShell.Commands.MatchInfo] }).Count } catch { $out["V|$m"] = 'ERR' }`,
            '}',
            '$out["sentinel"] = @(Get-ChildItem -LiteralPath $t | Select-String needle).Count',
            '$out | ConvertTo-Json -Compress',
        ].join('\n');
        let json;
        try {
            json = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8', windowsHide: true, timeout: 180000,
                env: { ...process.env, TFIX7_TMP: tmp, TFIX7_PASS: JSON.stringify(PASS_THROUGH), TFIX7_VALUE: JSON.stringify(LIST_VALUE) },
            });
        } catch (e) {
            assert.fail(`pwsh run failed: ${e.message}`);
        }
        const counts = JSON.parse(json.trim().split(/\r?\n/).pop());

        // Assert
        assert.equal(counts.sentinel, 2, 'the harness reads the synthetic files');
        for (const form of PASS_THROUGH) assert.ok(counts[`P|${form}`] >= 1, `${form}: the listing reaches Select-String (got ${JSON.stringify(counts[`P|${form}`])})`);
        // a list-value form that reads files proves the value (not the pipeline) feeds the output: it is classified "paths" above.
        // Not every list-value form reads files in real PowerShell: -NoEnumerate hands the listing on as ONE array object and an unknown
        // parameter makes the command fail; both stay "paths" (the safe side) and read nothing.
        const readsNothing = new Set(['Write-Output -Foo LISTING', 'Write-Output -NoEnumerate LISTING']);
        for (const form of LIST_VALUE) {
            if (readsNothing.has(form)) continue;
            assert.ok(counts[`V|${form}`] >= 1, `${form}: the list value reaches Select-String (got ${JSON.stringify(counts[`V|${form}`])})`);
        }
    });
});
