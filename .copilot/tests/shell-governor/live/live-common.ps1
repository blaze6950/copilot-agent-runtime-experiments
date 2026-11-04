# Helpers of the live harness. Dot-sourced by run-live.ps1.
# Rules (R-7): never capture screens or windows. Read only the scratch project, the session folders this harness created
# and the governor logs of the scratch copy. Kill only process trees rooted at PIDs this harness started.
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:PidLog = [System.Collections.Generic.List[object]]::new()

function Get-ScratchRoot {
    return (Join-Path $env:TEMP 'shell-governor-live')
}

# The scratch root is deleted and recreated per run, so it is accepted only as one of two dedicated folders:
#   <TEMP>\shell-governor-live                      (default)
#   C:\code\governance-spike\live-scratch            (trusted-folder alternative, see ATTENDED.md section 0)
function Assert-ScratchRoot {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $leaf = Split-Path -Leaf $full
    $parent = Split-Path -Parent $full
    $temp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $spike = 'C:\code\governance-spike'
    if ($leaf -eq 'shell-governor-live' -and $parent -ieq $temp) { return $full }
    if ($leaf -eq 'live-scratch' -and $parent -ieq $spike) { return $full }
    throw "refusing to use '$full': the scratch root must be <TEMP>\shell-governor-live or $spike\live-scratch"
}


function Get-SessionStateRoot {
    $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
    return (Join-Path $copilotHome 'session-state')
}

function Read-JsonLines {
    param([Parameter(Mandatory)][string]$Path)
    $items = [System.Collections.Generic.List[object]]::new()
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        if ($line.Trim().Length -eq 0) { continue }
        try { $items.Add(($line | ConvertFrom-Json)) } catch { }
    }
    return $items.ToArray()
}

# Creates the scratch project: git repo, a copy of the governor under .github\extensions\shell-governor (runtime folders
# excluded), the one-line entry file that exists ONLY in this copy, and a fake .env used by the secret-read cases.
function New-ScratchProject {
    param([Parameter(Mandatory)][string]$ExtensionSource, [Parameter(Mandatory)][string]$Root)
    $root = Assert-ScratchRoot -Path $Root
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    $project = Join-Path $root 'project'
    $extDst = Join-Path $project '.github\extensions\shell-governor'
    New-Item -ItemType Directory -Force -Path $extDst | Out-Null
    $src = (Resolve-Path -LiteralPath $ExtensionSource).Path.TrimEnd('\')
    foreach ($file in @(Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {
        $rel = $file.FullName.Substring($src.Length).TrimStart('\')
        if ($rel -match '^(logs|reviews|\.local)\\') { continue }
        $dst = Join-Path $extDst $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $dst
    }
    [System.IO.File]::WriteAllText((Join-Path $extDst 'extension.mjs'), ('import "./main.mjs";' + "`n"), $script:Utf8NoBom)
    git -C $project init -q
    if ($LASTEXITCODE -ne 0) { throw 'git init failed in the scratch project' }
    [System.IO.File]::WriteAllText((Join-Path $project '.env'), ("FAKE_SECRET=fake-0000-not-a-secret`n"), $script:Utf8NoBom)
    return $project
}

function Write-RenderedPrompt {
    param([Parameter(Mandatory)][string]$TemplatePath, [Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$OutPath)
    $text = [System.IO.File]::ReadAllText($TemplatePath, $script:Utf8NoBom)
    $text = $text.Replace('{PROJECT}', $Project).Replace('{SECRET}', (Join-Path $Project '.env'))
    [System.IO.File]::WriteAllText($OutPath, $text, $script:Utf8NoBom)
}

# Process tree rooted at RootPid (root first, then descendants breadth-first). Only reads; never kills.
function Get-ProcessTree {
    param([Parameter(Mandatory)][int]$RootPid)
    $all = @(Get-CimInstance -ClassName Win32_Process)
    $rows = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $seen = @{}
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $row = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
        if ($row) { $rows.Add($row) }
        foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $id })) { $queue.Enqueue([int]$child.ProcessId) }
    }
    return $rows.ToArray()
}

# Stops ONLY the tree rooted at RootPid (descendants first, root last). Returns the PIDs seen, killed and still alive.
function Stop-OwnTree {
    param([Parameter(Mandatory)][int]$RootPid)
    $rows = @(Get-ProcessTree -RootPid $RootPid)
    $ids = @(@($RootPid) + @($rows | ForEach-Object { [int]$_.ProcessId }) | Select-Object -Unique)
    [array]::Reverse($ids)
    $killed = [System.Collections.Generic.List[int]]::new()
    foreach ($id in $ids) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            $killed.Add($id)
        }
    }
    Start-Sleep -Seconds 2
    $alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    return [pscustomobject]@{ Tree = $ids; Killed = $killed.ToArray(); Alive = $alive }
}

# True when the scratch project is inside (or equal to) a folder listed in the user's trustedFolders (read only; the file is never written).
# An untrusted folder shows the CLI's first-run folder-trust prompt, which stalls an interactive session before it writes events.
function Test-FolderTrusted {
    param([Parameter(Mandatory)][string]$Project)
    $configPath = Join-Path (Split-Path -Parent (Get-SessionStateRoot)) 'config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return $false }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $want = [System.IO.Path]::GetFullPath($Project).TrimEnd('\')
    foreach ($entry in @($config.trustedFolders)) {
        if (-not $entry) { continue }
        $trusted = [System.IO.Path]::GetFullPath([string]$entry).TrimEnd('\')
        if ($want -ieq $trusted -or $want.StartsWith($trusted + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# The new session folder whose workspace.yaml cwd is the scratch project (folders present before the launch are skipped).
function Find-SessionFolder {
    param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][hashtable]$Known)
    $want = [System.IO.Path]::GetFullPath($Project).TrimEnd('\')
    foreach ($dir in @(Get-ChildItem -LiteralPath (Get-SessionStateRoot) -Directory -ErrorAction SilentlyContinue)) {
        if ($Known.ContainsKey($dir.Name)) { continue }
        $yaml = Join-Path $dir.FullName 'workspace.yaml'
        if (-not (Test-Path -LiteralPath $yaml)) { continue }
        $cwdLine = @(Get-Content -LiteralPath $yaml -ErrorAction SilentlyContinue | Where-Object { $_ -match '^cwd:' }) | Select-Object -First 1
        if (-not $cwdLine) { continue }
        $cwd = ($cwdLine -replace '^cwd:\s*', '').Trim().Trim('"', "'").TrimEnd('\')
        if ($cwd -ieq $want) { return $dir.FullName }
    }
    return $null
}

# Waits until: the main agent said DONE and no tool call is pending (done); the launcher exited; the harness timeout passed;
# or no session folder appeared within 90 s. Records every copilot --acp process seen in the tree (the judge).
function Wait-LiveSession {
    param([Parameter(Mandatory)][int]$LauncherPid, [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][hashtable]$Known, [Parameter(Mandatory)][int]$TimeoutSec)
    $started = Get-Date
    $deadline = $started.AddSeconds($TimeoutSec)
    $sessionDir = $null
    $foundSec = $null
    $reason = 'timeout'
    $acp = @{}
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        foreach ($row in @(Get-ProcessTree -RootPid $LauncherPid)) {
            if ($row.CommandLine -and $row.CommandLine -match '--acp') { $acp[[int]$row.ProcessId] = [int]$row.ParentProcessId }
        }
        if (-not $sessionDir) {
            $sessionDir = Find-SessionFolder -Project $Project -Known $Known
            if ($sessionDir) { $foundSec = [math]::Round(((Get-Date) - $started).TotalSeconds, 1) }
        }
        $launcherAlive = [bool](Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue)
        if (-not $sessionDir -and ((Get-Date) - $started).TotalSeconds -ge 90) { $reason = 'no-session-folder'; break }
        if ($sessionDir) {
            $events = @(Read-JsonLines -Path (Join-Path $sessionDir 'events.jsonl'))
            $startIds = @($events | Where-Object { $_.type -eq 'tool.execution_start' } | ForEach-Object { $_.data.toolCallId })
            $endIds = @($events | Where-Object { $_.type -eq 'tool.execution_complete' } | ForEach-Object { $_.data.toolCallId })
            $pending = @($startIds | Where-Object { $endIds -notcontains $_ })
            $done = @($events | Where-Object { $_.type -eq 'assistant.message' -and -not $_.agentId -and $_.data.content -match '\bDONE\b' })
            if ($done.Count -gt 0 -and $pending.Count -eq 0) { $reason = 'done'; break }
        }
        if ($sessionDir -and -not (Test-Path -LiteralPath (Join-Path $sessionDir 'events.jsonl')) -and ((Get-Date) - $started).TotalSeconds -ge 75) { $reason = 'session-not-initialised'; break }
        if (-not $launcherAlive) { $reason = 'launcher-exited'; break }
    }
    return [pscustomobject]@{ SessionDir = $sessionDir; EndReason = $reason; SessionFoundSec = $foundSec; Acp = $acp }
}

# Runs one session end to end: launch, wait, stop the own tree (always), then read the evidence (keys and decisions only).
function Invoke-LiveSession {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][ValidateSet('interactive', 'headless')][string]$Mode,
        [Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$PromptFile, [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][int]$TimeoutSec, [Parameter(Mandatory)][string]$Launcher)
    $known = @{}
    foreach ($dir in @(Get-ChildItem -LiteralPath (Get-SessionStateRoot) -Directory -ErrorAction SilentlyContinue)) { $known[$dir.Name] = $true }
    $outFile = Join-Path $OutDir "$Name.out.txt"
    $launchArgs = "-NoProfile -File `"$Launcher`" -ProjectDir `"$Project`" -PromptFile `"$PromptFile`" -Mode $Mode"
    $style = 'Normal'
    if ($Mode -eq 'headless') { $launchArgs += " -OutFile `"$outFile`""; $style = 'Hidden' }
    $startUtc = (Get-Date).ToUniversalTime()
    $proc = Start-Process -FilePath 'pwsh' -ArgumentList $launchArgs -WorkingDirectory $Project -WindowStyle $style -PassThru
    $launcherPid = $proc.Id
    $watch = $null
    $stop = $null
    try {
        $watch = Wait-LiveSession -LauncherPid $launcherPid -Project $Project -Known $known -TimeoutSec $TimeoutSec
    }
    finally {
        $stop = Stop-OwnTree -RootPid $launcherPid
        $script:PidLog.Add([pscustomobject]@{ case = $Name; rootPid = $launcherPid; treePids = $stop.Tree; killed = $stop.Killed; alive = $stop.Alive })
    }
    $endUtc = (Get-Date).ToUniversalTime()
    $sessionDir = $watch.SessionDir
    $events = @()
    $prefix = ''
    if ($sessionDir) {
        $events = @(Read-JsonLines -Path (Join-Path $sessionDir 'events.jsonl'))
        $prefix = (Split-Path -Leaf $sessionDir).Substring(0, 8)
    }
    $logs = Join-Path $Project '.github\extensions\shell-governor\logs'
    $allAudit = @(Read-AuditRecords -LogsDir $logs)
    $audit = @()
    if ($prefix) { $audit = @($allAudit | Where-Object { $_.session -eq $prefix }) }
    $govLog = @(Read-GovernorLogSince -LogsDir $logs -SinceUtc $startUtc)
    $outText = ''
    if (Test-Path -LiteralPath $outFile) { $outText = Get-Content -LiteralPath $outFile -Raw }
    return [pscustomobject]@{
        Name = $Name; Mode = $Mode; Project = $Project
        SessionDir = $sessionDir; SessionFolder = $(if ($sessionDir) { Split-Path -Leaf $sessionDir } else { $null })
        SessionPrefix = $prefix; EndReason = $watch.EndReason; SessionFoundSec = $watch.SessionFoundSec
        DurationSec = [math]::Round(($endUtc - $startUtc).TotalSeconds, 1)
        Events = $events; Audit = $audit; GovLog = $govLog; OutText = $outText
        AcpPids = @($watch.Acp.Keys); LauncherPid = $launcherPid; Stop = $stop
    }
}

function Read-AuditRecords {
    param([Parameter(Mandatory)][string]$LogsDir)
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $LogsDir -Filter 'audit-*.jsonl' -File -ErrorAction SilentlyContinue)) {
        foreach ($record in @(Read-JsonLines -Path $file.FullName)) { $records.Add($record) }
    }
    return $records.ToArray()
}

# Governor diagnostics lines (governor.log: "<ISO time> <context> <text>") written at or after SinceUtc.
function Read-GovernorLogSince {
    param([Parameter(Mandatory)][string]$LogsDir, [Parameter(Mandatory)][datetime]$SinceUtc)
    $path = Join-Path $LogsDir 'governor.log'
    $keep = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    foreach ($line in @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
        if ($line -match '^(\S+)\s') {
            $stamp = [datetime]::MinValue
            $ok = [datetime]::TryParse($matches[1], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$stamp)
            if ($ok -and $stamp -ge $SinceUtc) { $keep.Add($line) }
        }
    }
    return $keep.ToArray()
}

# Tool calls of one tool name: start/complete pairing by toolCallId. Only key NAMES and outcomes are returned.
function Get-ToolCalls {
    param([Parameter(Mandatory)][object[]]$Events, [Parameter(Mandatory)][string]$ToolName)
    $calls = [System.Collections.Generic.List[object]]::new()
    foreach ($start in @($Events | Where-Object { $_.type -eq 'tool.execution_start' -and $_.data.toolName -eq $ToolName })) {
        $complete = @($Events | Where-Object { $_.type -eq 'tool.execution_complete' -and $_.data.toolCallId -eq $start.data.toolCallId }) | Select-Object -First 1
        $argObject = $null
        if ($null -ne $start.data.arguments) { $argObject = $start.data.arguments }
        elseif ($null -ne $start.data.toolArgs) { $argObject = $start.data.toolArgs }
        $argKeys = @()
        if ($null -ne $argObject) { $argKeys = @($argObject.PSObject.Properties.Name) }
        $success = $null
        $error = ''
        $result = ''
        if ($complete) {
            $success = $complete.data.success
            if ($complete.data.error) { $error = [string]$complete.data.error.message }
            if ($complete.data.result) { $result = [string]$complete.data.result.content }
        }
        $calls.Add([pscustomobject]@{
                ToolCallId = $start.data.toolCallId; AgentId = $start.agentId; DataKeys = @($start.data.PSObject.Properties.Name)
                ArgKeys = $argKeys; Success = $success; Error = $error; Result = $result
            })
    }
    return $calls.ToArray()
}

# Every string value inside an object tree, with its dotted path (used for leak and path checks).
function Get-StringLeaves {
    param($Node, [string]$Path = '')
    if ($null -eq $Node) { return }
    if ($Node -is [string]) { [pscustomobject]@{ Path = $Path; Value = $Node }; return }
    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [pscustomobject]) {
        $index = 0
        foreach ($item in $Node) { Get-StringLeaves -Node $item -Path "$Path[$index]"; $index++ }
        return
    }
    if ($Node -is [pscustomobject]) {
        foreach ($prop in $Node.PSObject.Properties) { Get-StringLeaves -Node $prop.Value -Path ($Path + '.' + $prop.Name) }
    }
}
