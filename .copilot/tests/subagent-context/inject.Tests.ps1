<#
.SYNOPSIS
    Self-contained tests for subagent-context/inject.ps1 (no Pester dependency).
    Run: pwsh -NoProfile -File inject.Tests.ps1   (exit code = number of failures)
    Each test runs the hook as a child process with a synthetic copilot home (COPILOT_HOME_OVERRIDE, copied from
    fixtures/home into a temp folder) and temp repos (marked by a .git folder or file); all temp folders are deleted
    at the end.
#>
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$hookScript = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'subagent-context/inject.ps1'
$fixtureHome = Join-Path $PSScriptRoot 'fixtures/home'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('subagent-context-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0
$pwshExe = (Get-Command pwsh).Source

function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

# Fake copilot home; $Instructions (hashtable of repoInstructions overrides) is merged into profiles.json.
function New-Home([hashtable] $Instructions = @{}, [switch] $NoProfiles) {
    $h = Join-Path $tmp ('home-' + [guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $fixtureHome -Destination $h -Recurse -Force
    $pf = Join-Path $h 'conventions/profiles.json'
    if ($NoProfiles) { Remove-Item -LiteralPath $pf -Force; return $h }
    if ($Instructions.Count -gt 0) {
        $p = Get-Content -LiteralPath $pf -Raw | ConvertFrom-Json
        foreach ($k in $Instructions.Keys) { $p.repoInstructions.$k = $Instructions[$k] }
        Set-Content -LiteralPath $pf -Value ($p | ConvertTo-Json -Depth 6) -Encoding utf8
    }
    return $h
}

function New-Repo([string[]] $Files = @(), [switch] $NoGit) {
    $r = Join-Path $tmp ('repo-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $r | Out-Null
    foreach ($f in $Files) {
        $p = Join-Path $r $f
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
        Set-Content -LiteralPath $p -Value "content of $f" -Encoding utf8
    }
    if (-not $NoGit) { git -C $r init -q | Out-Null }
    return $r
}

function New-Payload([string] $Agent, [string] $Dir = $null, [string] $DirKey = 'workingDirectory', [switch] $NoTranscript) {
    $sessionFolder = Join-Path $tmp 'sessions/11111111-2222-3333-4444-555555555555'
    $p = [ordered]@{ agentName = $Agent; sessionId = '11111111-2222-3333-4444-555555555555' }
    if (-not $NoTranscript) { $p.transcriptPath = Join-Path $sessionFolder 'events.jsonl' }
    if ($Dir) { $p[$DirKey] = $Dir }
    return ($p | ConvertTo-Json -Compress)
}

# $PathOverride replaces PATH for the child process (used to prove that no git process is needed);
# $ScriptPath runs another copy of the entry script (used for the missing-module tests).
# $Color: NO_COLOR is removed for the child process (cyan progress line); without it the child gets NO_COLOR=1.
function Invoke-Hook([string] $Home_, [string] $Stdin, [string] $PathOverride = $null, [string] $ScriptPath = $hookScript, [switch] $Color) {
    $old = $env:COPILOT_HOME_OVERRIDE
    $oldPath = $env:PATH
    $oldNoColor = $env:NO_COLOR
    $env:COPILOT_HOME_OVERRIDE = $Home_
    if ($Color) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = '1' }
    if ($PathOverride) { $env:PATH = $PathOverride }
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $out = @($Stdin | & $pwshExe -NoProfile -File $ScriptPath 2>$null)
        $code = $LASTEXITCODE
        $sw.Stop()
    }
    finally {
        $env:COPILOT_HOME_OVERRIDE = $old; $env:PATH = $oldPath
        if ($null -eq $oldNoColor) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = $oldNoColor }
    }
    $lines = @($out | Where-Object { $_ -ne '' })
    $ctx = $null; $progress = $null; $allJson = $true
    foreach ($l in $lines) {
        try {
            $o = $l | ConvertFrom-Json
            if ($null -ne $o.additionalContext) { $ctx = [string]$o.additionalContext }
            if ($o.type -eq 'progress') { $progress = [string]$o.message }
        }
        catch { $allJson = $false }
    }
    return [pscustomobject]@{ code = $code; lines = $lines; ctx = $ctx; progress = $progress; allJson = $allJson; ms = $sw.ElapsedMilliseconds }
}

function Has($r, [string] $text) { return ($null -ne $r.ctx -and $r.ctx.Contains($text)) }

try {
    Assert (Test-Path -LiteralPath $hookScript -PathType Leaf) 'inject.ps1 exists'
    $sid = '11111111-2222-3333-4444-555555555555'
    $sessionFolder = Join-Path $tmp "sessions/$sid"

    # (1) agent with JSON: common + session + CLI tools (+ rules, shell tools)
    $h = New-Home
    $r = Invoke-Hook $h (New-Payload 'sub-explorer-code')
    Assert ($r.code -eq 0) '1: exit 0'
    Assert ($r.lines.Count -eq 2 -and $r.allJson -and $r.progress) '1: stdout is exactly a progress line and the additionalContext line'
    Assert (Has $r 'COMMON-RULES-MARKER') '1: contains shared-rules.md text'
    Assert (Has $r 'ünï') '1: non-ASCII content survives'
    Assert (($r.lines -join '') -match '^[\x00-\x7F]*$') '1: raw stdout is pure ASCII (non-ASCII escaped)'
    Assert ((Has $r '## Session') -and -not (Has $r '## Current session')) '1: heading is "## Session"'
    Assert (Has $r "- id: $sid") '1: session id line'
    Assert (Has $r "- folder: $sessionFolder") '1: folder = parent of transcriptPath'
    Assert (Has $r "- events: $(Join-Path $sessionFolder 'events.jsonl')") '1: events line'
    $reports = Join-Path $sessionFolder 'files\reports'
    Assert (Has $r "- reports: $reports") '1: reports line = <folder>\files\reports'
    Assert (Test-Path -LiteralPath $reports -PathType Container) '1: hook created the reports folder'
    Assert ((Has $r '## CLI tools') -and (Has $r 'FIXTURE-PWSH-USE') -and (Has $r 'FIXTURE-GIT-USE')) '1: CLI tools (agent + shell) injected'
    Assert (-not (Has $r 'FIXTURE-MISSING-USE')) '1: not-installed tool omitted'
    Assert ((Has $r 'SHELL-RULE-MARKER') -and (Has $r 'AGENT-RULE-MARKER')) '1: CLI rules injected'
    $ctx = [string]$r.ctx
    Assert ($ctx.IndexOf('COMMON-RULES-MARKER') -lt $ctx.IndexOf('## Session') -and $ctx.IndexOf('## Session') -lt $ctx.IndexOf('## CLI tools')) '1: order is common, session, CLI tools'
    Assert (-not (Has $r '## Conventions') -and -not (Has $r '## Repository instructions')) '1: non-code role gets no conventions or repo instructions'
    $log = Join-Path $h 'subagent-context/inject.log'
    Assert ((Test-Path -LiteralPath $log) -and (@(Get-Content -LiteralPath $log).Count -eq 1)) '1: one log line per invocation'

    # IncludeShell=false keeps shell tools out
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main')
    Assert ((Has $r 'FIXTURE-WORKER-PWSH-USE') -and -not (Has $r 'FIXTURE-GIT-USE')) '1b: IncludeShell=false honored'

    # (2) agent without JSON: common + session, no CLI tools
    $r = Invoke-Hook $h (New-Payload 'sub-expert-web')
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2) '2: exit 0, two stdout lines'
    Assert ((Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid") -and (Has $r "- reports: $reports")) '2: common + session block'
    Assert (-not (Has $r '## CLI tools')) '2: no CLI tools section'

    # (2b) no transcriptPath: common only, no session block
    $r = Invoke-Hook $h (New-Payload 'sub-expert-web' -NoTranscript)
    Assert ((Has $r 'COMMON-RULES-MARKER') -and -not (Has $r "- id: $sid")) '2b: no transcriptPath omits the session block'

    # (3) invalid input -> exit 0, no output
    $bad = @{
        'invalid name (space)'  = '{"agentName":"bad name","sessionId":"x","transcriptPath":"C:\\x\\events.jsonl"}'
        'invalid name (slash)'  = '{"agentName":"../evil","sessionId":"x"}'
        'missing agentName'     = '{"sessionId":"x"}'
        'malformed JSON'        = '{"agentName": "sub-worker-main", '
        'empty stdin'           = ''
        'not JSON'              = 'hello'
    }
    foreach ($k in $bad.Keys) {
        $r = Invoke-Hook $h $bad[$k]
        Assert ($r.code -eq 0 -and $r.lines.Count -eq 0) "3: $k -> exit 0, no output"
    }
    # (3b) a failing section is skipped; every other section is still emitted (never a half-silent hook)
    $hBroken = New-Home
    Set-Content -LiteralPath (Join-Path $hBroken 'conventions/profiles.json') -Value '{ broken json' -Encoding utf8
    $r = Invoke-Hook $hBroken (New-Payload 'sub-worker-main' (New-Repo @('App.sln')))
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and $r.allJson) '3a: malformed profiles.json -> exit 0, still two stdout lines'
    Assert ((Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid") -and (Has $r '## CLI tools')) '3a: malformed profiles.json -> shared rules, session and tools still emitted'
    Assert (-not (Has $r '## Conventions') -and -not (Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r '## Repository instructions')) '3a: malformed profiles.json -> conventions and repository instructions skipped'
    Assert ($r.progress -match 'skipped: conventions') '3a: progress message names the skipped conventions section'
    Assert ((Test-Path -LiteralPath (Join-Path $hBroken 'subagent-context/inject.log')) -and ((Get-Content -LiteralPath (Join-Path $hBroken 'subagent-context/inject.log') -Raw) -match 'conventions')) '3a: the skipped section is logged'

    $hBadAgentCfg = New-Home
    Set-Content -LiteralPath (Join-Path $hBadAgentCfg 'cli-tools/sub-explorer-code.json') -Value '{ broken json' -Encoding utf8
    $r = Invoke-Hook $hBadAgentCfg (New-Payload 'sub-explorer-code')
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid")) '3b: malformed cli-tools/<agent>.json -> shared rules and session still emitted'
    Assert (-not (Has $r '## CLI tools') -and ($r.progress -match 'skipped: tools')) '3b: malformed cli-tools/<agent>.json -> tools skipped and named in the progress message'
    $r = Invoke-Hook $hBadAgentCfg (New-Payload 'sub-worker-main' (New-Repo @('App.sln')))
    Assert ((Has $r '## CLI tools') -and (Has $r 'DOTNET-PACK-MARKER')) '3b: the malformed file only affects its own agent'

    $hBadShell = New-Home
    Set-Content -LiteralPath (Join-Path $hBadShell 'cli-tools/_shell.json') -Value '{ broken json' -Encoding utf8
    $r = Invoke-Hook $hBadShell (New-Payload 'sub-explorer-code')
    Assert ($r.code -eq 0 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid") -and -not (Has $r '## CLI tools')) '3b: malformed _shell.json -> tools skipped, other sections emitted'

    $noDirPayload = (@{ agentName = 'sub-explorer-code'; sessionId = $sid; transcriptPath = 'events.jsonl' } | ConvertTo-Json -Compress)
    $r = Invoke-Hook $h $noDirPayload
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r '## CLI tools')) '3c: transcriptPath without a directory part -> shared rules and tools emitted'
    Assert (-not (Has $r "- id: $sid") -and ($r.progress -match 'skipped: session')) '3c: transcriptPath without a directory part -> session skipped and named in the progress message'

    # (3d) reports folder cannot be created AND the log is unwritable: the session block is still emitted
    $blocker = Join-Path $tmp 'blocker-file'
    Set-Content -LiteralPath $blocker -Value 'a file where a folder is needed' -Encoding utf8
    $hNoLog = New-Home
    New-Item -ItemType Directory -Path (Join-Path $hNoLog 'subagent-context/inject.log') | Out-Null
    $blockedTranscript = Join-Path $blocker 'sub/events.jsonl'
    $blockedPayload = (@{ agentName = 'sub-explorer-code'; sessionId = $sid; transcriptPath = $blockedTranscript } | ConvertTo-Json -Compress)
    $r = Invoke-Hook $hNoLog $blockedPayload
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and (Has $r "- id: $sid") -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r '## CLI tools')) '3d: reports folder not creatable and log unwritable -> session block and other sections still emitted, exit 0'

    $hNoProfiles = New-Home -NoProfiles
    $r = Invoke-Hook $hNoProfiles (New-Payload 'sub-worker-main' (New-Repo @()))
    Assert ($r.code -eq 0 -and (Has $r 'COMMON-RULES-MARKER') -and -not (Has $r '## Conventions')) '3: missing profiles.json -> common + session only, exit 0'
    $r = Invoke-Hook (Join-Path $tmp 'no-such-home') (New-Payload 'sub-explorer-code')
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and $r.allJson -and (Has $r "- id: $sid") -and -not (Has $r 'COMMON-RULES-MARKER') -and -not (Has $r '## CLI tools')) '3: unusable home (no shared rules, no tools, log not writable) -> exit 0, session block still emitted'

    # (4) code role, repo with a .NET marker -> general + dotnet
    foreach ($marker in 'App.sln', 'App.slnx', 'App.csproj') {
        $repoMarker = New-Repo @($marker)
        $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoMarker)
        Assert ($r.code -eq 0 -and (Has $r '## Conventions') -and (Has $r 'GENERAL-PACK-MARKER') -and (Has $r 'DOTNET-PACK-MARKER')) "4: marker $marker -> general and dotnet packs"
    }
    $repoNet = New-Repo @('App.sln', 'sub/dir/x.txt')
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' (Join-Path $repoNet 'sub/dir'))
    Assert ((Has $r 'GENERAL-PACK-MARKER') -and (Has $r 'DOTNET-PACK-MARKER')) '4: working dir below the repo root finds the root marker'
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoNet 'cwd')
    Assert ((Has $r 'DOTNET-PACK-MARKER')) '4: cwd field is accepted as fallback'
    $r = Invoke-Hook $h (New-Payload 'sub-reviewer-code' $repoNet)
    Assert ((Has $r 'DOTNET-PACK-MARKER') -and (Has $r 'COMMON-RULES-MARKER')) '4: every code role gets packs (sub-reviewer-code)'

    # (e) repo root with a non-ASCII path segment (no git process involved, so no console code page decoding)
    $repoUni = Join-Path $tmp ('rëpo-ünï-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $repoUni '.git') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $repoUni 'App.sln') -Value 'sln' -Encoding utf8
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoUni)
    Assert ($r.code -eq 0 -and (Has $r 'GENERAL-PACK-MARKER') -and (Has $r 'DOTNET-PACK-MARKER')) '4e: repo root with a non-ASCII path segment is detected, dotnet pack injected'

    # (f) repo root = nearest ancestor with a .git folder or a .git file (worktree), found without invoking git
    $gitDir = Split-Path -Parent $pwshExe
    Assert (-not (Test-Path -LiteralPath (Join-Path $gitDir 'git.exe'))) '4f: precondition: git is not next to pwsh'
    $repoDotGitDir = Join-Path $tmp ('repo-gitdir-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $repoDotGitDir '.git'), (Join-Path $repoDotGitDir 'sub/deep') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $repoDotGitDir 'App.csproj') -Value 'proj' -Encoding utf8
    $r = Invoke-Hook $h (New-Payload 'sub-reviewer-code' (Join-Path $repoDotGitDir 'sub/deep')) $gitDir
    Assert ($r.code -eq 0 -and (Has $r 'DOTNET-PACK-MARKER')) '4f: .git folder found by walking up from a subfolder, without git on PATH'
    $repoDotGitFile = Join-Path $tmp ('repo-gitfile-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $repoDotGitFile 'sub') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $repoDotGitFile '.git') -Value 'gitdir: C:/somewhere/else/.git/worktrees/x' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $repoDotGitFile 'App.slnx') -Value 'slnx' -Encoding utf8
    $r = Invoke-Hook $h (New-Payload 'sub-reviewer-code' (Join-Path $repoDotGitFile 'sub')) $gitDir
    Assert ($r.code -eq 0 -and (Has $r 'DOTNET-PACK-MARKER')) '4f: .git file (worktree) found by walking up, without git on PATH'

    # (5) code role, no .NET markers -> general only
    $repoPlain = New-Repo @('README.md', 'package.json')
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoPlain)
    Assert ((Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r 'DOTNET-PACK-MARKER')) '5: repo without .NET markers -> general only'
    $repoNested = New-Repo @('nested/App.sln', 'nested/deep/App.csproj')
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoNested)
    Assert ((Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r 'DOTNET-PACK-MARKER')) '5: markers are checked at the repo root only (no recursion)'
    $noGit = New-Repo @('App.sln') -NoGit
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $noGit)
    Assert ($r.code -eq 0 -and (Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r 'DOTNET-PACK-MARKER')) '5: no git repo -> general only'
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' (Join-Path $tmp 'does-not-exist'))
    Assert ($r.code -eq 0 -and (Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r 'DOTNET-PACK-MARKER')) '5: unusable working directory -> general only, exit 0'

    # (6) non-code role -> no packs
    $r = Invoke-Hook $h (New-Payload 'sub-explorer-code' $repoNet)
    Assert (-not (Has $r 'GENERAL-PACK-MARKER') -and -not (Has $r 'DOTNET-PACK-MARKER') -and -not (Has $r '## Conventions')) '6: non-code role gets no packs'
    $r = Invoke-Hook $h (New-Payload 'sub-expert-web' $repoNet)
    Assert (-not (Has $r 'GENERAL-PACK-MARKER') -and (Has $r 'COMMON-RULES-MARKER')) '6: non-code role without CLI JSON gets no packs'

    # (7) repo instruction files: native vs inject
    $repoInstr = New-Repo @('AGENTS.md', '.github/copilot-instructions.md', '.github/instructions/a.instructions.md', '.github/instructions/deep/b.instructions.md', '.github/instructions/c.txt')
    $r = Invoke-Hook $h (New-Payload 'sub-worker-main' $repoInstr)
    Assert (-not (Has $r 'content of') -and -not (Has $r '## Repository instructions')) '7: native mode injects no repo instruction files'

    $hGh = New-Home @{ githubMode = 'inject' }
    $r = Invoke-Hook $hGh (New-Payload 'sub-worker-main' $repoInstr)
    Assert ((Has $r '## Repository instructions') -and (Has $r 'content of .github/instructions/a.instructions.md') -and (Has $r 'content of .github/instructions/deep/b.instructions.md')) '7: githubMode inject -> .github/instructions/**/*.instructions.md injected'
    Assert (-not (Has $r 'content of AGENTS.md') -and -not (Has $r 'content of .github/copilot-instructions.md') -and -not (Has $r 'c.txt')) '7: rootFiles stay native, non-matching files omitted'
    Assert ($r.ctx.IndexOf('## Conventions') -lt $r.ctx.IndexOf('## Repository instructions')) '7: conventions precede repository instructions'

    $hRoot = New-Home @{ rootFilesMode = 'inject' }
    $r = Invoke-Hook $hRoot (New-Payload 'sub-worker-main' $repoInstr)
    Assert ((Has $r 'content of AGENTS.md') -and (Has $r 'content of .github/copilot-instructions.md') -and -not (Has $r 'a.instructions.md')) '7: rootFilesMode inject -> root files injected, github group stays native'

    $hBoth = New-Home @{ rootFilesMode = 'inject'; githubMode = 'inject' }
    $r = Invoke-Hook $hBoth (New-Payload 'sub-explorer-code' $repoInstr)
    Assert (-not (Has $r 'content of')) '7: non-code role never gets repo instructions'
    $r = Invoke-Hook $hBoth (New-Payload 'sub-worker-main' $repoNet)
    Assert (-not (Has $r '## Repository instructions')) '7: repo without instruction files -> no section'
    $r = Invoke-Hook $hBoth (New-Payload 'sub-worker-main' $noGit)
    Assert (-not (Has $r '## Repository instructions')) '7: no git repo -> no repo instructions'

    # (8) size cap: files beyond maxBytes are listed by path, not injected
    $repoBig = New-Repo @('AGENTS.md')
    Set-Content -LiteralPath (Join-Path $repoBig 'AGENTS.md') -Value 'SMALL-AGENTS-CONTENT' -Encoding utf8
    New-Item -ItemType Directory -Force -Path (Join-Path $repoBig '.github/instructions') | Out-Null
    $bigPath = Join-Path $repoBig '.github/instructions/big.instructions.md'
    Set-Content -LiteralPath $bigPath -Value ('BIG-CONTENT-' + ('x' * 600)) -Encoding utf8
    $hCap = New-Home @{ rootFilesMode = 'inject'; githubMode = 'inject'; maxBytes = 200 }
    $r = Invoke-Hook $hCap (New-Payload 'sub-worker-main' $repoBig)
    Assert ($r.code -eq 0 -and (Has $r 'SMALL-AGENTS-CONTENT')) '8: file within the cap is injected'
    Assert (-not (Has $r 'BIG-CONTENT-')) '8: file over the cap is not injected'
    Assert ((Has $r 'big.instructions.md') -and (Has $r (Join-Path $repoBig '.github\instructions\big.instructions.md'))) '8: file over the cap is listed by full path'
    $hCap2 = New-Home @{ githubMode = 'inject'; maxBytes = 100 }
    $r = Invoke-Hook $hCap2 (New-Payload 'sub-worker-main' $repoBig)
    Assert (-not (Has $r 'BIG-CONTENT-') -and (Has $r 'big.instructions.md')) '8: single oversized file listed, nothing injected'

    # (8b) the cap counts the injected text in bytes, including the per-file header line "### <path>" + blank line
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $repoCap = New-Repo @()
    $capContent = 'é' * 20
    [System.IO.File]::WriteAllText((Join-Path $repoCap 'AGENTS.md'), $capContent, $utf8NoBom)
    $injectedBytes = $utf8NoBom.GetByteCount("### AGENTS.md`n`n$capContent")
    $hExact = New-Home @{ rootFilesMode = 'inject'; maxBytes = $injectedBytes }
    $r = Invoke-Hook $hExact (New-Payload 'sub-worker-main' $repoCap)
    Assert ((Has $r $capContent) -and -not (Has $r 'Not injected')) '8b: file whose injected text (header + content) is exactly maxBytes is injected'
    $hOver = New-Home @{ rootFilesMode = 'inject'; maxBytes = ($injectedBytes - 1) }
    $r = Invoke-Hook $hOver (New-Payload 'sub-worker-main' $repoCap)
    Assert (-not (Has $r $capContent) -and (Has $r (Join-Path $repoCap 'AGENTS.md')) -and (Has $r 'Not injected')) '8b: one byte over maxBytes -> listed by path, not injected'

    # (h) every invocation writes exactly one log line, early exits included
    function Get-LogLineCount([string] $HomePath) {
        $lf = Join-Path $HomePath 'subagent-context/inject.log'
        if (-not (Test-Path -LiteralPath $lf -PathType Leaf)) { return 0 }
        return @(Get-Content -LiteralPath $lf | Where-Object { $_ }).Count
    }
    $logCases = [ordered]@{
        'success'            = New-Payload 'sub-explorer-code'
        'invalid agent name' = '{"agentName":"bad name","sessionId":"x"}'
        'missing agentName'  = '{"sessionId":"x"}'
        'malformed JSON'     = '{"agentName": '
        'empty stdin'        = ''
        'skipped section'    = $noDirPayload
    }
    foreach ($k in $logCases.Keys) {
        $hLog = New-Home
        $null = Invoke-Hook $hLog $logCases[$k]
        Assert ((Get-LogLineCount $hLog) -eq 1) "h: $k -> exactly one log line"
    }
    $hNothing = New-Home
    Remove-Item -LiteralPath (Join-Path $hNothing 'subagent-context/shared-rules.md') -Force
    $r = Invoke-Hook $hNothing (New-Payload 'sub-expert-web' -NoTranscript)
    Assert ($r.code -eq 0 -and $r.lines.Count -eq 0 -and (Get-LogLineCount $hNothing) -eq 1) 'h: nothing to inject -> no output, exactly one log line'
    $hTwice = New-Home
    $null = Invoke-Hook $hTwice (New-Payload 'sub-explorer-code'); $null = Invoke-Hook $hTwice (New-Payload 'sub-explorer-code')
    Assert ((Get-LogLineCount $hTwice) -eq 2) 'h: two invocations -> two log lines'

    # (m) a missing or broken module skips only its own section(s); Common.ps1 is the only hard dependency
    function New-HookCopy([string] $Break, [string] $How) {
        $copy = Join-Path $tmp ('hookcopy-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $copy | Out-Null
        Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $hookScript) 'inject.ps1') -Destination $copy
        Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $hookScript) 'lib') -Destination $copy -Recurse
        if ($Break) {
            $mod = Join-Path $copy "lib/$Break.ps1"
            if ($How -eq 'delete') { Remove-Item -LiteralPath $mod -Force } else { Set-Content -LiteralPath $mod -Value 'function Broken { {{{ (' -Encoding utf8 }
        }
        return (Join-Path $copy 'inject.ps1')
    }
    foreach ($how in 'delete', 'corrupt') {
        $hMod = New-Home
        $r = Invoke-Hook $hMod (New-Payload 'sub-explorer-code') $null (New-HookCopy 'Tools' $how)
        Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid") -and -not (Has $r '## CLI tools') -and ($r.progress -match 'skipped: tools')) "m: Tools.ps1 $how -> other sections emitted, tools skipped"
        Assert ((Get-LogLineCount $hMod) -eq 1) "m: Tools.ps1 $how -> exactly one log line"

        $hMod = New-Home
        $r = Invoke-Hook $hMod (New-Payload 'sub-worker-main' (New-Repo @('App.sln'))) $null (New-HookCopy 'Conventions' $how)
        Assert ($r.code -eq 0 -and $r.lines.Count -eq 2 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r "- id: $sid") -and (Has $r '## CLI tools') -and -not (Has $r 'GENERAL-PACK-MARKER') -and ($r.progress -match 'skipped: conventions, instructions')) "m: Conventions.ps1 $how -> other sections emitted, both code-role sections skipped"
        Assert ((Get-LogLineCount $hMod) -eq 1) "m: Conventions.ps1 $how -> exactly one log line"

        $hMod = New-Home
        $r = Invoke-Hook $hMod (New-Payload 'sub-explorer-code') $null (New-HookCopy 'Session' $how)
        Assert ($r.code -eq 0 -and (Has $r 'COMMON-RULES-MARKER') -and (Has $r '## CLI tools') -and -not (Has $r "- id: $sid") -and ($r.progress -match 'skipped: session') -and (Get-LogLineCount $hMod) -eq 1) "m: Session.ps1 $how -> session skipped, one log line"

        $hMod = New-Home
        $r = Invoke-Hook $hMod (New-Payload 'sub-explorer-code') $null (New-HookCopy 'Shared' $how)
        Assert ($r.code -eq 0 -and (Has $r "- id: $sid") -and (Has $r '## CLI tools') -and -not (Has $r 'COMMON-RULES-MARKER') -and ($r.progress -match 'skipped: shared-rules') -and (Get-LogLineCount $hMod) -eq 1) "m: Shared.ps1 $how -> shared rules skipped, one log line"

        $hMod = New-Home
        $r = Invoke-Hook $hMod (New-Payload 'sub-explorer-code') $null (New-HookCopy 'Common' $how)
        Assert ($r.code -eq 0 -and $r.lines.Count -eq 0 -and (Get-LogLineCount $hMod) -eq 1) "m: Common.ps1 $how -> exit 0, no output, one fallback log line"
    }

    # (i) repo instruction files: an unreadable file is listed with a warning; files after the cap are listed unread
    $repoLock = New-Repo @()
    New-Item -ItemType Directory -Force -Path (Join-Path $repoLock '.github/instructions') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $repoLock 'AGENTS.md'), 'LOCKED-ROOT-CONTENT', $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $repoLock '.github/instructions/a.instructions.md'), 'READABLE-GITHUB-CONTENT', $utf8NoBom)
    $hLock = New-Home @{ rootFilesMode = 'inject'; githubMode = 'inject' }
    $lock = [System.IO.File]::Open((Join-Path $repoLock 'AGENTS.md'), 'Open', 'Read', 'None')
    try { $r = Invoke-Hook $hLock (New-Payload 'sub-worker-main' $repoLock) }
    finally { $lock.Dispose() }
    Assert ($r.code -eq 0 -and (Has $r 'READABLE-GITHUB-CONTENT') -and -not (Has $r 'LOCKED-ROOT-CONTENT') -and (Has $r (Join-Path $repoLock 'AGENTS.md'))) 'i: unreadable instruction file is listed by path, the section continues'
    Assert ((Get-LogLineCount $hLock) -eq 1 -and ((Get-Content -LiteralPath (Join-Path $hLock 'subagent-context/inject.log') -Raw) -match 'cannot read')) 'i: unreadable instruction file is warned about in the single log line'

    [System.IO.File]::WriteAllText((Join-Path $repoLock 'AGENTS.md'), ('BIG-ROOT-' + ('x' * 300)), $utf8NoBom)
    $hCapLock = New-Home @{ rootFilesMode = 'inject'; githubMode = 'inject'; maxBytes = 100 }
    $lock = [System.IO.File]::Open((Join-Path $repoLock '.github/instructions/a.instructions.md'), 'Open', 'Read', 'None')
    try { $r = Invoke-Hook $hCapLock (New-Payload 'sub-worker-main' $repoLock) }
    finally { $lock.Dispose() }
    Assert ((Has $r (Join-Path $repoLock '.github\instructions\a.instructions.md')) -and -not ((Get-Content -LiteralPath (Join-Path $hCapLock 'subagent-context/inject.log') -Raw) -match 'cannot read')) 'i: files after the first one over the cap are listed without being read'

    # (t) the log line names the tools that are not installed
    $hMissingTool = New-Home
    $null = Invoke-Hook $hMissingTool (New-Payload 'sub-explorer-code')
    Assert ((Get-Content -LiteralPath (Join-Path $hMissingTool 'subagent-context/inject.log') -Raw) -match 'tools not installed: definitely-not-installed-tool-xyz') 't: log line names the missing tools'
    $hClean = New-Home
    $null = Invoke-Hook $hClean (New-Payload 'sub-worker-main' (New-Repo @('App.sln')))
    Assert ((Get-LogLineCount $hClean) -eq 1 -and (Get-Content -LiteralPath (Join-Path $hClean 'subagent-context/inject.log') -Raw) -notmatch 'warning|skipped|ERROR') 't: a run without problems logs no warning'

    # (shim) temporary cli-tools/inject-cli.ps1 forwards stdin to the new entry script (sessions with the cached old registration)
    $shimScript = Join-Path (Split-Path -Parent $hookScript) '../cli-tools/inject-cli.ps1'
    Assert (Test-Path -LiteralPath $shimScript -PathType Leaf) 'shim: temporary cli-tools/inject-cli.ps1 exists (remove this test with the shim)'
    $env:COPILOT_HOME_OVERRIDE = $h
    $shimOldNoColor = $env:NO_COLOR; $env:NO_COLOR = '1'
    try { $shimOut = @((New-Payload 'sub-explorer-code') | & $pwshExe -NoProfile -File $shimScript 2>$null | Where-Object { $_ -ne '' }); $shimCode = $LASTEXITCODE }
    finally {
        Remove-Item Env:COPILOT_HOME_OVERRIDE
        if ($null -eq $shimOldNoColor) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = $shimOldNoColor }
    }
    $shimCtx = ''; $shimProgress = $null
    foreach ($l in $shimOut) { $o = $l | ConvertFrom-Json; if ($null -ne $o.additionalContext) { $shimCtx = [string]$o.additionalContext }; if ($o.type -eq 'progress') { $shimProgress = [string]$o.message } }
    Assert ($shimCode -eq 0 -and $shimOut.Count -eq 2 -and $shimProgress -and $shimCtx.Contains('COMMON-RULES-MARKER') -and $shimCtx.Contains("- id: $sid") -and $shimCtx.Contains('## CLI tools')) 'shim: cli-tools/inject-cli.ps1 emits the same progress and additionalContext lines'

    # (c) progress colour: one cyan line unless NO_COLOR is set (hook-ui/HookUi.ps1)
    $hCyan = New-Home
    $rCyan = Invoke-Hook $hCyan (New-Payload 'sub-explorer-code') -Color
    Assert ($rCyan.progress -match '^\x1b\[36mInjecting .+ for sub-explorer-code.*\x1b\[0m$') 'c1: NO_COLOR unset -> progress message wrapped in ESC[36m ... ESC[0m'

    $hPlainProgress = New-Home
    $rPlainProgress = Invoke-Hook $hPlainProgress (New-Payload 'sub-explorer-code')
    Assert ($rPlainProgress.progress -match '^Injecting ' -and $rPlainProgress.progress.IndexOf([char]27) -lt 0) 'c2: NO_COLOR=1 -> no escape character in the progress message'

    $hColorLog = New-Home
    $rColorRun = Invoke-Hook $hColorLog (New-Payload 'sub-explorer-code') -Color
    $colorLogText = Get-Content -LiteralPath (Join-Path $hColorLog 'subagent-context/inject.log') -Raw
    Assert ((($rColorRun.lines -join '') -match '^[\x00-\x7F]*$') -and ($rColorRun.lines[0] -imatch '\\u001b\[36m') -and ($colorLogText.IndexOf([char]27) -lt 0)) 'c3: colour run -> raw stdout is pure ASCII with the escaped cyan sequence, and the log line has no escape character'

    $noUiScript = New-HookCopy '' ''
    $hNoUiProgress = New-Home
    $rNoUiProgress = Invoke-Hook $hNoUiProgress (New-Payload 'sub-explorer-code') $null $noUiScript -Color
    $noUiLogText = Get-Content -LiteralPath (Join-Path $hNoUiProgress 'subagent-context/inject.log') -Raw
    Assert ($rNoUiProgress.code -eq 0 -and $rNoUiProgress.progress -match '^Injecting ' -and $rNoUiProgress.progress.IndexOf([char]27) -lt 0 -and $noUiLogText -match 'HookUi\.ps1') 'c4: hook-ui missing (hook copy) -> plain progress, exit 0, log names HookUi.ps1'

    # (9) runtime
    $r = Invoke-Hook $hBoth (New-Payload 'sub-worker-main' $repoInstr)
    Assert ($r.ms -lt 12000) "9: total runtime under 12 s, below the 15 s hook timeout, for a repo fixture (got $($r.ms) ms)"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$passed passed, $failures failed"
exit $failures
