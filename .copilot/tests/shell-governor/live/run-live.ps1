# Live harness for the shell governor (T11). Runs real copilot sessions in a scratch project under %TEMP%\shell-governor-live.
# Usage:
#   pwsh -NoProfile -File tests/shell-governor/live/run-live.ps1 -Cases auto
#   pwsh -NoProfile -File tests/shell-governor/live/run-live.ps1 -Cases Live_SafeCommand_NoDialog,Live_NoUi_AskBecomesDeny
#   pwsh -NoProfile -File tests/shell-governor/live/run-live.ps1 -Prepare     (only builds the scratch project; for ATTENDED.md)
#   pwsh -NoProfile -File tests/shell-governor/live/run-live.ps1 -Cases auto -ScratchRoot C:\code\governance-spike\live-scratch
#     (default scratch root: <TEMP>\shell-governor-live; the alternative is only accepted at C:\code\governance-spike\live-scratch)
#   add -KeepScratch to keep the scratch root after the run (by default it is removed at the end of every run except -Prepare)
# Exit codes: 0 all selected cases PASS and the judge budget holds; 1 a case FAILED or the budget was exceeded; 2 harness error.
# Results (results.json, results.md, raw headless output) are copied to <TEMP>\shell-governor-live-results\<timestamp>\ (never committed)
# before the scratch root is removed; with -KeepScratch they also stay in <scratch root>\results.
# No screen or window is ever captured. Only PIDs started by this run are stopped (by tree, from the launcher PID).
param(
    [string]$Cases = 'auto',
    [switch]$Prepare,
    [switch]$KeepScratch,
    [string]$ScratchRoot = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'live-common.ps1')

$MaxSessions = 8
$MaxJudgments = 6
$SecretValue = 'fake-0000-not-a-secret'

# Unattended cases (run by -Cases auto). Interactive sessions use allow-all and never wait for a human (DONE or timeout).
$CaseTable = @(
    [pscustomobject]@{ Name = 'Live_Discovery_ScratchExtensionLoaded_AndUserFolderNotLoaded'; Mode = 'interactive'; Prompt = 'discovery'; TimeoutSec = 150; Evaluate = 'Test-Discovery' }
    [pscustomobject]@{ Name = 'Live_SyntaxError_Denied'; Mode = 'interactive'; Prompt = 'syntax-error'; TimeoutSec = 150; Evaluate = 'Test-SyntaxError' }
    [pscustomobject]@{ Name = 'Live_SafeCommand_NoDialog'; Mode = 'interactive'; Prompt = 'safe-command'; TimeoutSec = 150; Evaluate = 'Test-SafeCommand' }
    [pscustomobject]@{ Name = 'Live_NoUi_AskBecomesDeny'; Mode = 'headless'; Prompt = 'noui-secret'; TimeoutSec = 150; Evaluate = 'Test-NoUi' }
    [pscustomobject]@{ Name = 'Live_Judge_UnclearCommand_JudgedViaAcp'; Mode = 'headless'; Prompt = 'judge-inline'; TimeoutSec = 170; Evaluate = 'Test-Judge' }
    [pscustomobject]@{ Name = 'Live_Subagent_HookInputCarriesAgentId'; Mode = 'interactive'; Prompt = 'subagent-hook'; TimeoutSec = 210; Evaluate = 'Test-Subagent' }
    [pscustomobject]@{ Name = 'Live_FileTools_ArgumentNames'; Mode = 'interactive'; Prompt = 'file-tools'; TimeoutSec = 210; Evaluate = 'Test-FileTools' }
)
# Folder trust: the governor is only activated in a trusted folder. In an untrusted scratch folder the interactive session never
# initialises and a headless -p run does not load the governor (observed), so while the scratch folder is untrusted every case is
# reported BLOCKED and nothing is launched. The user trusts the scratch folder once (live/ATTENDED.md section 0); this script never edits trust.
# Attended cases: documented in live/ATTENDED.md for the user; never started by this script.
$AttendedCases = @('Live_SecretRead_DialogWithLink', 'Live_DefaultOption_ReShows', 'Live_Decline_DeniesWithReason', 'Live_Subagent_NameShown')

function Get-Short {
    param([string]$Text, [int]$Max = 160)
    if ($null -eq $Text) { return '' }
    $one = ($Text -replace '\s+', ' ').Trim()
    if ($one.Length -gt $Max) { return $one.Substring(0, $Max) + '...' }
    return $one
}

function Get-ToolText {
    param($Call)
    if ($Call.Error) { return $Call.Error }
    return $Call.Result
}

function Test-RatingsValid {
    param($Record)
    if ($null -eq $Record.ratings) { return $false }
    $props = @($Record.ratings.PSObject.Properties)
    if ($props.Count -ne 9) { return $false }
    $bad = @($props | Where-Object { $v = $_.Value; ($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 3 })
    return ($bad.Count -eq 0)
}

# ---- evaluators: each returns Pass (bool) and Evidence (lines with names, counts and decisions only) ----

function Test-Discovery {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $callOk = @($calls | Where-Object { $_.Success -eq $true }).Count
    $ev.Add("powershell Get-Location: success=true in $callOk of $($calls.Count) calls")
    $ev.Add("governor audit records of this session: $($C.Audit.Count) (verdicts: $((@($C.Audit | ForEach-Object { $_.verdict })) -join ','))")
    $loaded = @($C.Events | Where-Object { $_.type -eq 'session.extensions_loaded' })
    if ($loaded.Count -eq 0) {
        $ev.Add('no session.extensions_loaded event in this interactive session; fallback: governor audit used as the loaded evidence')
        $ev.Add('user-folder check and cache-keeper positive control NOT verifiable without that event')
        return [pscustomobject]@{ Pass = ($C.Audit.Count -ge 1 -and $callOk -ge 1); Evidence = $ev.ToArray() }
    }
    $ext = @($loaded[-1].data.extensions)
    $names = @($ext | ForEach-Object { $_.name })
    $fieldNames = @($ext | Select-Object -First 1 | ForEach-Object { $_.PSObject.Properties.Name })
    $ev.Add("session.extensions_loaded: data.extensions[].name = [$($names -join ', ')]; entry fields = [$($fieldNames -join ', ')]")
    $govCount = @($names | Where-Object { $_ -eq 'shell-governor' }).Count
    $cacheListed = ($names -contains 'cache-keeper')
    $userHits = @($C.Events | ForEach-Object { Get-StringLeaves -Node $_ } | Where-Object { $_.Value -imatch 'copilot[\\/]+extensions[\\/]+shell-governor' })
    $scratchHits = @($C.Events | ForEach-Object { Get-StringLeaves -Node $_ } | Where-Object { $_.Value -imatch 'shell-governor-live' })
    $ev.Add("shell-governor listed: $govCount; cache-keeper listed (positive control): $cacheListed")
    $ev.Add("string values naming the user-folder shell-governor: $($userHits.Count); values naming the scratch copy: $($scratchHits.Count) (paths: $((@($scratchHits | ForEach-Object { $_.Path } | Select-Object -Unique)) -join ', '))")
    $pass = ($govCount -eq 1 -and $cacheListed -and $userHits.Count -eq 0 -and $callOk -ge 1)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

function Test-SyntaxError {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $denied = @($calls | Where-Object { $_.Success -ne $true -and ((Get-ToolText $_) -match '(?i)syntax error') })
    $syntaxAudit = @($C.Audit | Where-Object { $_.tool -eq 'powershell' -and $_.verdict -eq 'SYNTAX' })
    $ev.Add("powershell calls: $($calls.Count); success=false with parser message: $($denied.Count)")
    if ($denied.Count -ge 1) { $ev.Add("parser message (first 160 chars): $(Get-Short (Get-ToolText $denied[0]))") }
    $ev.Add("audit verdicts for powershell: $((@($C.Audit | Where-Object { $_.tool -eq 'powershell' } | ForEach-Object { $_.verdict })) -join ',') ; SYNTAX records: $($syntaxAudit.Count)")
    return [pscustomobject]@{ Pass = ($denied.Count -ge 1 -and $syntaxAudit.Count -ge 1); Evidence = $ev.ToArray() }
}

function Test-SafeCommand {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $okCalls = @($calls | Where-Object { $_.Success -eq $true })
    $rec = @($C.Audit | Where-Object { $_.tool -eq 'powershell' })
    $safeRec = @($rec | Where-Object { $_.verdict -eq 'SAFE' })
    $dialogRec = @($C.Audit | Where-Object { $null -ne $_.dialogOutcome })
    $hookAsks = @($C.Events | Where-Object { $_.type -eq 'permission.requested' -and $_.data.permissionRequest.kind -eq 'hook' })
    $ev.Add("powershell calls: $($calls.Count); success=true: $($okCalls.Count)")
    $ev.Add("audit verdicts for powershell: $((@($rec | ForEach-Object { $_.verdict })) -join ','); audit records with a dialog outcome: $($dialogRec.Count)")
    $ev.Add("permission.requested of kind hook: $($hookAsks.Count); governor dialog log lines: $(@($C.GovLog | Where-Object { $_ -match '(?i)dialog' }).Count)")
    $pass = ($okCalls.Count -ge 1 -and $safeRec.Count -ge 1 -and $dialogRec.Count -eq 0 -and $hookAsks.Count -eq 0)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

function Test-NoUi {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $notOk = @($calls | Where-Object { $_.Success -ne $true })
    $askRec = @($C.Audit | Where-Object { $_.tool -eq 'powershell' -and $_.verdict -eq 'ASK' -and $_.dialogOutcome -in @('ask', 'hook-ask') })
    $leakEvents = @($C.Events | ForEach-Object { Get-StringLeaves -Node $_ } | Where-Object { $_.Value -like "*$SecretValue*" }).Count
    $leakOut = [bool]($C.OutText -like "*$SecretValue*")
    $resultKinds = @($C.Events | Where-Object { $_.type -eq 'permission.completed' } | ForEach-Object { $_.data.result.kind })
    $ev.Add("powershell calls: $($calls.Count); not successful: $($notOk.Count)")
    if ($notOk.Count -ge 1) { $ev.Add("tool result (first 160 chars): $(Get-Short (Get-ToolText $notOk[0]))") }
    $ev.Add("audit records verdict=ASK with dialogOutcome ask/hook-ask (no UI): $($askRec.Count); other audit outcomes: $((@($C.Audit | Where-Object { $_.tool -eq 'powershell' } | ForEach-Object { "$($_.verdict)/$($_.dialogOutcome)" })) -join ',')")
    $ev.Add("permission.completed result kinds: [$($resultKinds -join ', ')]; secret value seen in events: $leakEvents string(s); in -p output: $leakOut (values not printed)")
    $pass = ($askRec.Count -ge 1 -and $notOk.Count -ge 1 -and $leakEvents -eq 0 -and -not $leakOut)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

function Test-Judge {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $judged = @($C.Audit | Where-Object { $null -ne $_.judgeLatencyMs })
    $ratingRec = $judged | Select-Object -First 1
    $ratingsOk = [bool]($ratingRec -and (Test-RatingsValid -Record $ratingRec))
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $ev.Add("audit records with judge latency: $($judged.Count)")
    if ($ratingRec) {
        $pairs = @($ratingRec.ratings.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" })
        $ev.Add("verdict=$($ratingRec.verdict); judgeLatencyMs=$($ratingRec.judgeLatencyMs); ratings valid (9 ints 0-3): $ratingsOk; ratings: $($pairs -join ' ')")
    }
    $ev.Add("copilot --acp processes seen in the case tree: $($C.AcpPids.Count) (pids: $($C.AcpPids -join ', ')); judge log lines: $(@($C.GovLog | Where-Object { $_ -match '^\S+ judge ' }).Count)")
    $ev.Add("powershell call success=true: $(@($calls | Where-Object { $_.Success -eq $true }).Count) of $($calls.Count) (either outcome is valid when a verdict was parsed)")
    $pass = ($judged.Count -ge 1 -and $ratingsOk -and $C.AcpPids.Count -eq 1)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

function Test-Subagent {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $subs = @($C.Events | Where-Object { $_.type -eq 'subagent.started' } | ForEach-Object { [pscustomobject]@{ Name = $_.data.agentName; AgentId = $_.agentId; ToolCallId = $_.data.toolCallId } })
    $targets = @($subs | Where-Object { $_.Name -eq 'sub-explorer-code' })
    $ids = @($targets | ForEach-Object { $_.AgentId })
    $calls = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $subCalls = @($calls | Where-Object { $ids -contains $_.AgentId })
    $subOk = @($subCalls | Where-Object { $_.Success -eq $true }).Count
    $subAudit = @($C.Audit | Where-Object { $_.tool -eq 'powershell' -and $_.agent -eq 'sub-explorer-code' })
    $agentNames = @($C.Audit | ForEach-Object { $_.agent } | Select-Object -Unique)
    $ev.Add("subagent.started (data.agentName, top-level agentId): $(@($subs | ForEach-Object { "$($_.Name)/$(if ($_.AgentId) { 'agentId-set' } else { 'no-agentId' })" }) -join ', ')")
    $ev.Add("powershell calls whose top-level agentId equals the subagent's: $($subCalls.Count); success=true: $subOk")
    $ev.Add("governor audit agent names (main shows the main agent name): [$($agentNames -join ', ')]; audit records agent=sub-explorer-code: $($subAudit.Count)")
    $ev.Add('hook agentId is non-null when the audit names the subagent (a null agentId would be attributed to the main agent)')
    $pass = ($targets.Count -ge 1 -and $subOk -ge 1 -and $subAudit.Count -ge 1)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

function Test-FileTools {
    param($C)
    $ev = [System.Collections.Generic.List[string]]::new()
    $create = @(Get-ToolCalls -Events $C.Events -ToolName 'create')
    $edit = @(Get-ToolCalls -Events $C.Events -ToolName 'edit')
    $shell = @(Get-ToolCalls -Events $C.Events -ToolName 'powershell')
    $file = Join-Path $C.Project 'live-file.txt'
    $content = ''
    if (Test-Path -LiteralPath $file) { $content = (Get-Content -LiteralPath $file -Raw).Trim() }
    $createOk = @($create | Where-Object { $_.Success -eq $true }).Count
    $editOk = @($edit | Where-Object { $_.Success -eq $true }).Count
    $shellOk = @($shell | Where-Object { $_.Success -eq $true }).Count
    foreach ($group in @(@('create', $create), @('edit', $edit), @('powershell', $shell))) {
        $first = @($group[1]) | Select-Object -First 1
        if ($first) { $ev.Add("argument keys [$($group[0])]: start data fields = [$($first.DataKeys -join ', ')]; arguments = [$($first.ArgKeys -join ', ')]") }
        else { $ev.Add("argument keys [$($group[0])]: no call observed") }
    }
    $ev.Add("calls success=true: create $createOk/$($create.Count), edit $editOk/$($edit.Count), powershell $shellOk/$($shell.Count)")
    $ev.Add("file content after edit equals 'hello two': $($content -eq 'hello two')")
    $risky = @($C.Audit | Where-Object { $_.tool -in @('create', 'edit', 'powershell') -and ($_.verdict -in @('ASK', 'SYNTAX') -or $null -ne $_.dialogOutcome) })
    $unknown = @($C.GovLog | Where-Object { $_ -match '(?i)unknown shape' })
    $ev.Add("audit verdicts: $((@($C.Audit | Where-Object { $_.tool -in @('create', 'edit', 'powershell') } | ForEach-Object { "$($_.tool)=$($_.verdict)" })) -join ', '); ASK/SYNTAX/dialog records: $($risky.Count); 'unknown shape' log lines: $($unknown.Count)")
    $ev.Add("apply_patch: not exercised (the prompt asked only for the self-report of availability in the final reply)")
    $pass = ($createOk -ge 1 -and $editOk -ge 1 -and $content -eq 'hello two' -and $risky.Count -eq 0 -and $unknown.Count -eq 0)
    return [pscustomobject]@{ Pass = $pass; Evidence = $ev.ToArray() }
}

# End of a run: copies the results out of the scratch root to <TEMP>\shell-governor-live-results\<timestamp>\ and then removes
# the scratch root (unless -KeepScratch). Only a root that Assert-ScratchRoot accepts is ever deleted. Returns where the results are.
function Complete-Run {
    param([string]$Root)
    $where = $null
    try {
        $safe = Assert-ScratchRoot -Path $Root
        $from = Join-Path $safe 'results'
        $where = $from
        if (Test-Path -LiteralPath $from) {
            $dest = Join-Path (Join-Path $env:TEMP 'shell-governor-live-results') (Get-Date -Format 'yyyyMMdd-HHmmss')
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            Copy-Item -Path (Join-Path $from '*') -Destination $dest -Recurse -Force
            $where = $dest
        }
        if ($KeepScratch) { Write-Host "scratch root kept: $safe" }
        elseif (Test-Path -LiteralPath $safe) {
            Remove-Item -LiteralPath $safe -Recurse -Force
            Write-Host "scratch root removed: $safe"
        }
    }
    catch {
        Write-Host "cleanup warning: $($_.Exception.Message)"
    }
    return $where
}

# ---- main ----
$root = $null
try {
    $extSource = Join-Path (Resolve-Path (Join-Path $here '..\..\..')).Path 'extensions\shell-governor'
    $rootPath = if ($ScratchRoot) { $ScratchRoot } else { Get-ScratchRoot }
    $root = Assert-ScratchRoot -Path $rootPath
    $project = New-ScratchProject -ExtensionSource $extSource -Root $root
    $promptsDir = Join-Path $root 'prompts'
    $resultsDir = Join-Path $root 'results'
    New-Item -ItemType Directory -Force -Path $promptsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
    foreach ($case in $CaseTable) {
        Write-RenderedPrompt -TemplatePath (Join-Path $here "prompts\$($case.Prompt).txt") -Project $project -OutPath (Join-Path $promptsDir "$($case.Prompt).txt")
    }
    if ($Cases -in @('auto', 'all')) {
        $selected = @($CaseTable)
    }
    else {
        $wanted = @($Cases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($name in $wanted) {
            if ($AttendedCases -contains $name) { throw "$name is attended: follow live\ATTENDED.md (not started by this script)" }
            if (-not ($CaseTable.Name -contains $name)) { throw "unknown case '$name'" }
        }
        $selected = @($CaseTable | Where-Object { $wanted -contains $_.Name })
    }
    if ($selected.Count -gt $MaxSessions) { throw "more than $MaxSessions live sessions selected" }
    Write-Output "scratch project: $project"
    Write-Output "cases: $($selected.Count)"

    $trusted = Test-FolderTrusted -Project $project
    Write-Output "scratch folder trusted in user trustedFolders: $trusted (read only)"
    if ($Prepare) {
        Write-Output "scratch project ready: $project"
        if (-not $trusted) { Write-Output 'next: trust the scratch folder once (live/ATTENDED.md section 0); until then every live case is BLOCKED' }
        exit 0
    }
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($case in $selected) {
        $ctx = $null
        $verdict = $null
        $errorText = ''
        if (-not $trusted) {
            $results.Add([pscustomobject]@{
                    Case = $case.Name; Mode = $case.Mode; Status = 'BLOCKED'; EndReason = 'not-launched'; DurationSec = 0
                    SessionFolder = ''; LauncherPid = $null; KilledPids = @(); AlivePids = @()
                    Evidence = @('not launched: the scratch folder is not in the user trustedFolders, so the governor is not activated (folder-trust gate)',
                        'observed: interactive session wrote no events.jsonl (control: the same command wrote events in 45 s in the trusted C:\code\governance-spike); headless -p with GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true in the untrusted folder made no governor decision (no audit, no logs, no .local) and its powershell call never completed in 156 s',
                        'run after the user trusts the scratch folder once (live/ATTENDED.md section 0)')
                })
            Write-Output ("[BLOCKED] {0} (scratch folder not trusted; not launched)" -f $case.Name)
            continue
        }
        try {
            $ctx = Invoke-LiveSession -Name $case.Name -Mode $case.Mode -Project $project `
                -PromptFile (Join-Path $promptsDir "$($case.Prompt).txt") -OutDir $resultsDir `
                -TimeoutSec $case.TimeoutSec -Launcher (Join-Path $here 'launch-case.ps1')
            $verdict = & $case.Evaluate $ctx
        }
        catch {
            $errorText = $_.Exception.Message
        }
        $pass = ($null -ne $verdict) -and [bool]$verdict.Pass
        $status = if ($pass) { 'PASS' } else { 'FAIL' }
        $evidence = @()
        if ($verdict) { $evidence = @($verdict.Evidence) }
        if ($errorText) { $evidence += "harness error: $errorText" }
        $endReason = ''
        $session = ''
        $duration = $null
        $treeAlive = @()
        $treeKilled = @()
        if ($ctx) {
            $endReason = $ctx.EndReason
            $session = $ctx.SessionFolder
            $duration = $ctx.DurationSec
            $treeAlive = @($ctx.Stop.Alive)
            $treeKilled = @($ctx.Stop.Killed)
        }
        $results.Add([pscustomobject]@{
                Case = $case.Name; Mode = $case.Mode; Status = $status; EndReason = $endReason; DurationSec = $duration
                SessionFolder = $session; LauncherPid = $(if ($ctx) { $ctx.LauncherPid } else { $null })
                KilledPids = $treeKilled; AlivePids = $treeAlive; Evidence = $evidence
            })
        Write-Output ("[{0}] {1} (mode: {2}, end: {3}, {4}s)" -f $status, $case.Name, $case.Mode, $endReason, $duration)
    }

    $allAudit = @(Read-AuditRecords -LogsDir (Join-Path $project '.github\extensions\shell-governor\logs'))
    $judged = @($allAudit | Where-Object { $null -ne $_.judgeLatencyMs }).Count
    $budgetOk = ($judged -le $MaxJudgments)
    $allPass = (@($results | Where-Object { $_.Status -ne 'PASS' }).Count -eq 0)
    $leftAlive = @($script:PidLog | ForEach-Object { $_.alive } | Where-Object { $_ })
    $summary = [pscustomobject]@{
        Scratch = $root; Project = $project
        MaxSessions = $MaxSessions; SessionsLaunched = @($results | Where-Object { $_.Status -ne 'BLOCKED' }).Count
        Trusted = $trusted; JudgmentsInRun = $judged; JudgeBudgetOk = $budgetOk
        AllPass = $allPass; PidLog = @($script:PidLog); AliveAfterStop = $leftAlive; Results = $results.ToArray()
    }
    [System.IO.File]::WriteAllText((Join-Path $resultsDir 'results.json'), ($summary | ConvertTo-Json -Depth 8), $script:Utf8NoBom)
    $md = [System.Collections.Generic.List[string]]::new()
    $md.Add('| Case | Mode | Result | End | Seconds | Session | Evidence |')
    $md.Add('|---|---|---|---|---|---|---|')
    foreach ($r in $results) {
        $md.Add("| $($r.Case) | $($r.Mode) | $($r.Status) | $($r.EndReason) | $($r.DurationSec) | $($r.SessionFolder) | $((@($r.Evidence) -join ' / ')) |")
    }
    $md.Add('')
    $md.Add("judge judgments in run: $judged (budget $MaxJudgments, ok: $budgetOk); processes still alive after stop: $($leftAlive.Count)")
    [System.IO.File]::WriteAllText((Join-Path $resultsDir 'results.md'), ($md -join "`n"), $script:Utf8NoBom)
    Write-Output "judge judgments in run: $judged (budget $MaxJudgments, ok: $budgetOk); alive after stop: $($leftAlive.Count)"
    $where = Complete-Run -Root $root
    Write-Output "results: $where"
    if ($allPass -and $budgetOk) { exit 0 }
    exit 1
}
catch {
    Write-Output "harness error: $($_.Exception.Message)"
    if ($root -and -not $Prepare) { $null = Complete-Run -Root $root }
    exit 2
}
