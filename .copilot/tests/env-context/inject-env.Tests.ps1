<#
.SYNOPSIS
    Self-contained tests for env-context/inject-env.ps1 (no Pester dependency).
    Run: pwsh -NoProfile -File tests/env-context/inject-env.Tests.ps1   (exit code = number of failures)
    Each case runs the hook as a child process from a temp copy of the hook layout: env-context/inject-env.ps1,
    hook-ui/HookUi.ps1 (when the repository has it) and a fixture env.json. All temp folders are deleted at the end.
#>
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hookSource = Join-Path $repoRoot 'env-context/inject-env.ps1'
$uiSource = Join-Path $repoRoot 'hook-ui/HookUi.ps1'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('env-context-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0
$pwshExe = (Get-Command pwsh).Source

function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

# Temp copy of the hook layout with a fixture env.json, one known directory and a work folder (a.txt, sub\b.txt, no git).
# -SkipWork puts the work folder into Tree.SkipFor; -NoUi leaves hook-ui\HookUi.ps1 out of the copy.
function New-EnvHome([switch] $SkipWork, [switch] $NoUi) {
    $h = Join-Path $tmp ('home-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $h 'env-context') | Out-Null
    Copy-Item -LiteralPath $hookSource -Destination (Join-Path $h 'env-context/inject-env.ps1')
    if (-not $NoUi -and (Test-Path -LiteralPath $uiSource -PathType Leaf)) {
        New-Item -ItemType Directory -Path (Join-Path $h 'hook-ui') | Out-Null
        Copy-Item -LiteralPath $uiSource -Destination (Join-Path $h 'hook-ui/HookUi.ps1')
    }
    $known = Join-Path $h 'known'
    $work = Join-Path $h 'work'
    New-Item -ItemType Directory -Path $known, (Join-Path $work 'sub') | Out-Null
    Set-Content -LiteralPath (Join-Path $work 'a.txt') -Value 'a' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $work 'sub/b.txt') -Value 'b' -Encoding utf8
    $skipFor = if ($SkipWork) { @($work) } else { @() }
    $cfg = [ordered]@{
        Facts       = @('FACT-ONE')
        Directories = @([ordered]@{ Name = 'known'; Path = $known; Description = 'known dir' })
        Tree        = [ordered]@{ Enabled = $true; MaxDepth = 2; MaxEntries = 50; TimeoutSeconds = 5; Exclude = @('node_modules'); SkipFor = $skipFor }
    }
    Set-Content -LiteralPath (Join-Path $h 'env-context/env.json') -Value ($cfg | ConvertTo-Json -Depth 5) -Encoding utf8
    return [pscustomobject]@{ Home = $h; Work = $work; Known = $known }
}

function New-EnvPayload([string] $Cwd, [string] $Source = 'new', [string] $AgentId = $null) {
    $p = [ordered]@{ cwd = $Cwd; source = $Source }
    if ($AgentId) { $p.agentId = $AgentId }
    return ($p | ConvertTo-Json -Compress)
}

# $NoColor: $null removes NO_COLOR for the child process; any other value sets it. The caller's value is restored.
function Invoke-EnvHook([string] $HomePath, [string] $Stdin, [AllowNull()] [string] $NoColor) {
    $old = $env:NO_COLOR
    if ($null -eq $NoColor) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = $NoColor }
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $out = @($Stdin | & $pwshExe -NoProfile -File (Join-Path $HomePath 'env-context/inject-env.ps1') 2>$null)
        $code = $LASTEXITCODE
        $sw.Stop()
    }
    finally { if ($null -eq $old) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = $old } }
    $lines = @($out | Where-Object { $_ -ne '' })
    $progress = $null; $ctx = $null
    foreach ($l in $lines) {
        try {
            $o = $l | ConvertFrom-Json
            if ($o.type -eq 'progress') { $progress = [string]$o.message }
            if ($null -ne $o.additionalContext) { $ctx = [string]$o.additionalContext }
        }
        catch { }
    }
    return [pscustomobject]@{ code = $code; lines = $lines; progress = $progress; ctx = $ctx; ms = $sw.ElapsedMilliseconds }
}

function Read-LogText([string] $HomePath) {
    $lf = Join-Path $HomePath 'env-context/inject.log'
    if (Test-Path -LiteralPath $lf -PathType Leaf) { return (Get-Content -LiteralPath $lf -Raw) }
    return ''
}

try {
    Assert (Test-Path -LiteralPath $hookSource -PathType Leaf) 'env: inject-env.ps1 exists'

    # e1: exit 0 and exactly two stdout lines: the progress line, then the additionalContext line
    $e = New-EnvHome
    $rColor = Invoke-EnvHook $e.Home (New-EnvPayload $e.Work) $null
    Assert ($rColor.code -eq 0 -and $rColor.lines.Count -eq 2 -and $rColor.lines[0] -match '"type":"progress"' -and $rColor.lines[1] -match '"additionalContext"') 'e1: exit 0 and exactly two lines: progress then additionalContext'

    # e2: NO_COLOR unset -> the progress message is wrapped in cyan (ESC[36m ... ESC[0m)
    Assert ($rColor.progress -match '^\x1b\[36menv context: 1 dirs, 3 entries, \d+ ms\x1b\[0m$') 'e2: progress is ESC[36m env context: 1 dirs, 3 entries, <n> ms ESC[0m when NO_COLOR is unset'

    # e3: NO_COLOR=1 -> plain progress message
    $rPlain = Invoke-EnvHook $e.Home (New-EnvPayload $e.Work) '1'
    Assert ($rPlain.progress -match '^env context: 1 dirs, 3 entries, \d+ ms$') 'e3: NO_COLOR=1 -> plain "env context: 1 dirs, 3 entries, <n> ms"'

    # e4: additionalContext is unchanged by the progress rework (pins today's text)
    $expectedContext = @(
        '## Environment context (injected by sessionStart hook)'
        '- FACT-ONE'
        ('- Working directory: `' + $e.Work + '`')
        ''
        '### Known directories'
        ('- known (`' + $e.Known + '`): known dir')
        ''
        '### Working directory tree (depth 2, git-aware, build/vendor dirs omitted)'
        '```'
        'a.txt'
        'sub/'
        '  b.txt'
        '```'
    ) -join "`n"
    $actualContext = ([string]$rPlain.ctx).Replace("`r`n", "`n")
    Assert ($actualContext -eq $expectedContext) 'e4: additionalContext equals the expected environment context text'

    # e5: a payload with agentId, and a resumed session, produce no output and exit 0
    $rAgent = Invoke-EnvHook $e.Home (New-EnvPayload $e.Work 'new' 'agent-1') '1'
    $rResume = Invoke-EnvHook $e.Home (New-EnvPayload $e.Work 'resume') '1'
    Assert ($rAgent.code -eq 0 -and $rAgent.lines.Count -eq 0 -and $rResume.code -eq 0 -and $rResume.lines.Count -eq 0) 'e5: agentId payload and resume payload -> no output, exit 0'

    # e6: a work folder in Tree.SkipFor -> one progress line that says "no tree", and no tree in the context
    $eSkip = New-EnvHome -SkipWork
    $rSkip = Invoke-EnvHook $eSkip.Home (New-EnvPayload $eSkip.Work) '1'
    Assert ($rSkip.code -eq 0 -and $rSkip.progress -match '^env context: 1 dirs, no tree, \d+ ms$' -and -not ([string]$rSkip.ctx).Contains('### Working directory tree')) 'e6: work dir in SkipFor -> "env context: 1 dirs, no tree, <n> ms" and no tree in the context'

    # e7: hook-ui\HookUi.ps1 missing -> plain progress line, exit 0, and the inject.log line names it (ui=)
    $eNoUi = New-EnvHome -NoUi
    $rNoUi = Invoke-EnvHook $eNoUi.Home (New-EnvPayload $eNoUi.Work) $null
    $noUiLog = Read-LogText $eNoUi.Home
    Assert ($rNoUi.code -eq 0 -and $rNoUi.progress -match '^env context: 1 dirs, 3 entries, \d+ ms$' -and $noUiLog -match 'ui=') 'e7: hook-ui missing -> plain line, exit 0, inject.log line contains ui='
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$passed passed, $failures failed"
exit $failures
