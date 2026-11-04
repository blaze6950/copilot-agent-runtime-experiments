# Live probe for AC-2 (T1): which repository instruction files reach a sub-agent dispatched with
# `include-custom-instructions: true`. Starts one real headless CLI session in a scratch git repo under %TEMP%,
# parses that session's events.jsonl (sub-agent answer and sub-agent tool calls only) and writes tests/hooks/live/RESULTS.md.
# Usage: pwsh -NoProfile -File tests/hooks/live/probe-instructions.ps1 [-KeepScratch]
# Exit codes: 0 RESULTS.md written; 2 infrastructure failure (folder trusted, but session or sub-agent dispatch not observed);
#             3 BLOCKED (session did not start/dispatch and the scratch folder is not in the user's trustedFolders; no RESULTS.md).
# Trust is recorded in RESULTS.md, not used as a gate: a headless session starts in an untrusted folder, so a "yes" is valid evidence.
# Never touches ~\.copilot\agents, settings.json or other user config; the probe agent exists only in the scratch repo.
param([switch]$KeepScratch)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$utf8 = [System.Text.UTF8Encoding]::new($false)
$model = 'claude-haiku-5.5'
$timeoutSec = 180
$userPrompt = 'Dispatch the probe-reader agent and print its answer verbatim.'
$markers = [ordered]@{
    'AGENTS.md'                                  = 'PROBE-AGENTS-7F3A'
    '.github/copilot-instructions.md'            = 'PROBE-COPILOT-2B9C'
    '.github/instructions/probe.instructions.md' = 'PROBE-INSTR-5D1E'
}
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
$configPath = Join-Path $copilotHome 'config.json'
$sessionRoot = Join-Path $copilotHome 'session-state'
$scratchRoot = Join-Path $env:TEMP 'hooks-instructions-probe'
$project = Join-Path $scratchRoot 'project'
$resultsDir = Join-Path $scratchRoot 'results'
$resultsFile = Join-Path $here 'RESULTS.md'
$cmdLine = "copilot --model $model --allow-all-tools --no-ask-user -p ""$userPrompt"""

function Write-Text {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

# True when the folder is inside (or equal to) a trustedFolders entry of the user's config.json (read only).
function Test-FolderTrusted {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $configPath)) { return $false }
    $want = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($entry in @((Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).trustedFolders)) {
        if (-not $entry) { continue }
        $trustedPath = [System.IO.Path]::GetFullPath([string]$entry).TrimEnd('\')
        if ($want -ieq $trustedPath -or $want.StartsWith($trustedPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# Process ids of the tree rooted at RootPid (root first). Only reads; the caller stops them.
function Get-TreeIds {
    param([Parameter(Mandatory)][int]$RootPid)
    $all = @(Get-CimInstance -ClassName Win32_Process)
    $ids = [System.Collections.Generic.List[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($ids.Contains($id)) { continue }
        $ids.Add($id)
        foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $id })) { $queue.Enqueue([int]$child.ProcessId) }
    }
    return $ids.ToArray()
}

$code = 2
$trusted = $false
try {
    # 1. Scratch git repo with the four probe sources (scratch root is deleted and recreated per run).
    if (Test-Path -LiteralPath $scratchRoot) { Remove-Item -LiteralPath $scratchRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $project, $resultsDir | Out-Null
    Write-Text (Join-Path $project 'AGENTS.md') ("# Probe repo instructions (AGENTS.md)`n`nMarker: " + $markers['AGENTS.md'] + "`n")
    Write-Text (Join-Path $project '.github/copilot-instructions.md') ("# Probe repo instructions (copilot-instructions)`n`nMarker: " + $markers['.github/copilot-instructions.md'] + "`n")
    Write-Text (Join-Path $project '.github/instructions/probe.instructions.md') ("---`napplyTo: `"**`"`n---`n`n# Probe path instructions`n`nMarker: " + $markers['.github/instructions/probe.instructions.md'] + "`n")
    Write-Text (Join-Path $project '.github/agents/probe-reader.agent.md') ("---`nname: probe-reader`ndescription: Reports the PROBE- lines it already has in its context. Reads no files.`ntools: [`"view`"]`nuser-invocable: false`ninclude-custom-instructions: true`n---`n`nList every line containing the text PROBE- that appears in your instructions or context, verbatim; do not read files.`n")
    git -C $project init -q
    if ($LASTEXITCODE -ne 0) { throw 'git init failed in the scratch project' }

    # 2. Folder trust (read only) and CLI version.
    $trusted = Test-FolderTrusted -Path $project
    $exe = (Get-Command copilot -ErrorAction Stop).Source
    $version = (& $exe --version 2>$null | Select-Object -First 1)

    # 3. One headless session in the scratch repo; extensions stay off; hard timeout; the process tree is stopped on timeout.
    $stdinFile = Join-Path $resultsDir 'stdin.txt'
    Write-Text $stdinFile ''
    $known = @{}
    foreach ($dir in @(Get-ChildItem -LiteralPath $sessionRoot -Directory -ErrorAction SilentlyContinue)) { $known[$dir.Name] = $true }
    $savedExt = $env:GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS
    $env:GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS = $null
    $exitInfo = 'not started'
    try {
        # One pre-quoted string: Start-Process does not quote array elements with spaces, and the CLI then rejects the prompt.
        $argLine = "--model $model --allow-all-tools --no-ask-user -p ""$userPrompt"""
        $proc = Start-Process -FilePath $exe -ArgumentList $argLine `
            -WorkingDirectory $project -RedirectStandardInput $stdinFile `
            -RedirectStandardOutput (Join-Path $resultsDir 'cli-stdout.txt') -RedirectStandardError (Join-Path $resultsDir 'cli-stderr.txt') `
            -WindowStyle Hidden -PassThru
        if ($proc.WaitForExit($timeoutSec * 1000)) { $exitInfo = "exit $($proc.ExitCode)" }
        else {
            $exitInfo = "timed out after $timeoutSec s (process tree stopped)"
            $tree = @(Get-TreeIds -RootPid $proc.Id)
            [array]::Reverse($tree)
            foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        }
    }
    finally { $env:GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS = $savedExt }

    # 4. The new session folder of this scratch project (workspace.yaml cwd only; other sessions are not read).
    $sessionDir = $null
    foreach ($dir in @(Get-ChildItem -LiteralPath $sessionRoot -Directory -ErrorAction SilentlyContinue)) {
        if ($known.ContainsKey($dir.Name)) { continue }
        $yaml = Join-Path $dir.FullName 'workspace.yaml'
        if (-not (Test-Path -LiteralPath $yaml)) { continue }
        $cwdLine = Get-Content -LiteralPath $yaml | Where-Object { $_ -match '^cwd:' } | Select-Object -First 1
        if (-not $cwdLine) { continue }
        $cwd = ($cwdLine -replace '^cwd:\s*', '').Trim().Trim('"', "'").TrimEnd('\')
        if ($cwd -ieq $project) { $sessionDir = $dir.FullName; break }
    }
    $events = @()
    if ($sessionDir -and (Test-Path -LiteralPath (Join-Path $sessionDir 'events.jsonl'))) {
        $events = @(Get-Content -LiteralPath (Join-Path $sessionDir 'events.jsonl') | Where-Object { $_.Trim() } |
            ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
    }

    # 5. Evidence: the probe-reader sub-agent's own answer and tool calls (by agentId / its task toolCallId).
    $starts = @($events | Where-Object { $_.type -eq 'subagent.started' -and "$($_.data.agentName)" -match 'probe-reader' })
    $probeAgentIds = @($starts | ForEach-Object { [string]$_.agentId } | Where-Object { $_ })
    $probeCallIds = @($starts | ForEach-Object { [string]$_.data.toolCallId } | Where-Object { $_ })
    $subEvents = @($events | Where-Object { $_.agentId -and ($probeAgentIds -contains [string]$_.agentId) })
    $subAnswers = @($subEvents | Where-Object { $_.type -eq 'assistant.message' } | ForEach-Object { [string]$_.data.content })
    $taskResults = @($events | Where-Object { $_.type -eq 'tool.execution_complete' -and ($probeCallIds -contains [string]$_.data.toolCallId) } |
        ForEach-Object { [string]$_.data.result.content })
    $answer = (@($subAnswers) + @($taskResults)) -join "`n"
    $subTools = @($subEvents | Where-Object { $_.type -like 'tool.*' })
    $subToolText = (@($subTools | ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress })) -join "`n"
    $subToolNames = @($subTools | Where-Object { $_.type -eq 'tool.execution_start' } | ForEach-Object { [string]$_.data.toolName })
    # The sub-agent's own system context (where repository instructions arrive) and the prompt it was given.
    $subSystemText = (@($subEvents | Where-Object { $_.type -eq 'system.message' } | ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress })) -join "`n"
    $subUserText = (@($subEvents | Where-Object { $_.type -eq 'user.message' } | ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress })) -join "`n"

    # 6. Top-level prompt, every top-level task-tool dispatch and the sub-agent's prompt (the parent also loads AGENTS.md, so it may copy markers).
    $dispatch = [System.Collections.Generic.List[string]]::new()
    $dispatch.Add($userPrompt)
    $dispatch.Add($subUserText)
    foreach ($e in @($events | Where-Object { -not $_.agentId -and $_.type -eq 'tool.execution_start' -and $_.data.toolName -eq 'task' })) {
        $argObj = if ($null -ne $e.data.arguments) { $e.data.arguments } else { $e.data.toolArgs }
        $dispatch.Add(($argObj | ConvertTo-Json -Depth 20 -Compress))
    }
    $dispatchText = $dispatch -join "`n"

    # 7. Per marker: yes only when it is in the sub-agent answer and not in the dispatch or in a sub-agent tool call.
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($src in $markers.Keys) {
        $m = $markers[$src]
        $note = ''
        if ($dispatchText.Contains($m)) { $state = 'inconclusive'; $note = 'marker in the top-level dispatch prompt or the sub-agent prompt; treated as not delivered' }
        elseif ($subToolText.Contains($m)) { $state = 'inconclusive'; $note = 'marker seen in a sub-agent tool call (read from disk, not native loading); treated as not delivered' }
        elseif ($answer.Contains($m)) { $state = 'yes' }
        else { $state = 'no' }
        $inSystem = if ($subSystemText.Contains($m)) { 'yes' } else { 'no' }
        $rows.Add([pscustomobject]@{ Source = $src; Marker = $m; Delivered = $state; InSystem = $inSystem; Note = $note })
    }
    $deliveredOf = { param($src) (@($rows | Where-Object { $_.Source -eq $src })[0]).Delivered }
    $agentsOk = (& $deliveredOf 'AGENTS.md') -eq 'yes'
    $copilotOk = (& $deliveredOf '.github/copilot-instructions.md') -eq 'yes'
    $instrOk = (& $deliveredOf '.github/instructions/probe.instructions.md') -eq 'yes'
    $repoSwitch = if ($agentsOk -and $copilotOk) { 'native' } else { 'inject' }
    $ghSwitch = if ($instrOk) { 'native' } else { 'inject' }
    $dispatchHit = @($markers.Values | Where-Object { $dispatchText.Contains($_) }).Count -gt 0
    $dispatched = $starts.Count -ge 1
    $answered = ($subAnswers.Count + $taskResults.Count) -ge 1
    $eventSummary = (@($events | Group-Object -Property type | ForEach-Object { "$($_.Name)=$($_.Count)" }) | Select-Object -First 30) -join ', '
    $diag = "session folder found=$([bool]$sessionDir); events=$($events.Count); process: $exitInfo; probe-reader dispatches=$($starts.Count); sub-agent answers=$($subAnswers.Count + $taskResults.Count); event types: $eventSummary"

    # A session that never dispatched and answered is not evidence. Only an untrusted folder can explain it as BLOCKED.
    if (-not $dispatched -or -not $answered) {
        if (-not $trusted) {
            $code = 3
            Write-Output "BLOCKED: the probe session did not dispatch and answer, and scratch folder $project is not in trustedFolders of $configPath. Trust it once (run copilot inside that folder and choose 'trust this folder'), then re-run. $diag"
        }
        else {
            $code = 2
            Write-Output "infrastructure failure: sub-agent dispatch or answer not observed in a trusted folder. $diag"
        }
    }
    else {
        $trustText = if ($trusted) { 'yes' } else { 'no (not in trustedFolders; the headless session still started and dispatched)' }
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add('# Live probe: instruction loading for sub-agents (AC-2)')
        $lines.Add('')
        $lines.Add('Written by `tests/hooks/live/probe-instructions.ps1` from one real headless session. Re-run the script to refresh; do not edit by hand.')
        $lines.Add('')
        $lines.Add("- CLI version: $version")
        $lines.Add("- date: $(Get-Date -Format 'yyyy-MM-dd HH:mm zzz')")
        $lines.Add("- command: $cmdLine")
        $lines.Add('- cwd: scratch git repo under %TEMP%\hooks-instructions-probe\project (removed after the run)')
        $lines.Add("- extensions: off (GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS unset); scratch folder trusted: $trustText")
        $lines.Add("- session: $(Split-Path -Leaf $sessionDir) (events.jsonl stays in session-state, not copied)")
        $lines.Add("- sub-agent: probe-reader (include-custom-instructions: true, user-invocable: false, tools: view); dispatches observed: $($starts.Count); sub-agent tool calls: $(if ($subToolNames.Count -gt 0) { $subToolNames -join ', ' } else { 'none' })")
        $lines.Add("- top-level dispatch prompt or sub-agent prompt contains a marker: $(if ($dispatchHit) { 'yes' } else { 'no' })")
        $lines.Add("- process: $exitInfo")
        $lines.Add('')
        $lines.Add('| Source in scratch repo | Marker | Delivered to sub-agent | In sub-agent system context | Note |')
        $lines.Add('|---|---|---|---|---|')
        foreach ($r in $rows) { $lines.Add("| $($r.Source) | $($r.Marker) | $($r.Delivered) | $($r.InSystem) | $($r.Note) |") }
        $lines.Add('')
        $lines.Add('Sub-agent answer lines containing PROBE- (verbatim, first 20):')
        foreach ($l in @(($answer -split "`n") | Where-Object { $_ -match 'PROBE-' } | ForEach-Object { $_.Trim() } | Select-Object -Unique -First 20)) { $lines.Add("    $l") }
        $lines.Add('')
        $lines.Add('## Derived switches')
        $lines.Add('')
        $lines.Add("- repoRootInstructions: $repoSwitch (native only when AGENTS.md and copilot-instructions.md are both delivered)")
        $lines.Add("- githubInstructions: $ghSwitch (native only when the .github/instructions marker is delivered)")
        if (-not $trusted) {
            $lines.Add('')
            $lines.Add('Caveat: the scratch folder was not trusted. A "yes" is valid evidence; a "no" could be caused by the untrusted folder and must be re-checked after trusting it.')
        }
        Write-Text $resultsFile (($lines -join "`n") + "`n")
        Write-Output "RESULTS.md written: AGENTS=$(& $deliveredOf 'AGENTS.md'); copilot-instructions=$(& $deliveredOf '.github/copilot-instructions.md'); instructions=$(& $deliveredOf '.github/instructions/probe.instructions.md'); repoRootInstructions=$repoSwitch; githubInstructions=$ghSwitch; trusted=$trusted"
        $code = 0
    }
}
catch {
    Write-Output "infrastructure failure: $($_.Exception.Message)"
    $code = 2
}
finally {
    # Results are copied out of the scratch root before it is removed; the scratch root is removed unless -KeepScratch.
    if (Test-Path -LiteralPath $resultsDir) {
        $dest = Join-Path $env:TEMP ('hooks-instructions-probe-results\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -Path (Join-Path $resultsDir '*') -Destination $dest -Recurse -Force
        Write-Output "results copied to $dest"
    }
    if ($KeepScratch) { Write-Output "scratch kept: $scratchRoot" }
    elseif (Test-Path -LiteralPath $scratchRoot) { Remove-Item -LiteralPath $scratchRoot -Recurse -Force; Write-Output 'scratch removed' }
}
exit $code
