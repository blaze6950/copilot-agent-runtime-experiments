<#
.SYNOPSIS
    Validates the "# Plan" section of a workflow plan.md and detects requirement drift.

.DESCRIPTION
    Used by the `1main` agent (/make-plan and /implement skills).
    - Parses header fields, acceptance criteria, unresolved decisions and tasks (### T<n>: ...).
    - Validates dependencies (unknown, self, cycles), required task fields, and file-ownership
      conflicts between tasks that are not ordered by dependencies (i.e. could run in parallel).
    - Computes execution waves (topological levels) and stable SHA-256 hashes per task / AC.
    - With -Compare, diffs against a previous snapshot and reports affected tasks.

.PARAMETER PlanPath
    Path to plan.md.
.PARAMETER SnapshotOut
    Optional path; writes the JSON result there (used as the baseline for later -Compare).
.PARAMETER Compare
    Optional path to a previous snapshot JSON; adds a "drift" object to the result.

.OUTPUTS
    JSON on stdout. Exit code: 0 = valid, 1 = validation errors (or drift when -FailOnDrift), 2 = parse failure.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PlanPath,
    [string] $SnapshotOut,
    [string] $Compare,
    [switch] $FailOnDrift
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([string] $text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant().Substring(0, 16)
    } finally { $sha.Dispose() }
}

function Normalize([string[]] $lines) {
    $trimmed = @($lines | ForEach-Object { $_.TrimEnd() })
    return (($trimmed -join "`n").Trim())
}

function Fail-Parse([string] $message) {
    [pscustomobject]@{ ok = $false; parseError = $message } | ConvertTo-Json -Depth 8
    exit 2
}

if (-not (Test-Path -LiteralPath $PlanPath)) { Fail-Parse "plan file not found: $PlanPath" }
$all = [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $PlanPath))

# --- Extract the "# Plan" section (stops at "# Working Memory") ---------------------------
$start = -1
for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i] -match '^#\s+Plan\s*$') { $start = $i; break } }
if ($start -lt 0) { Fail-Parse "no '# Plan' heading found" }
$end = $all.Count
for ($i = $start + 1; $i -lt $all.Count; $i++) { if ($all[$i] -match '^#\s+Working Memory\s*$') { $end = $i; break } }
$plan = @($all[$start..($end - 1)])
while ($plan.Count -gt 0 -and ($plan[-1].Trim() -eq '' -or $plan[-1].Trim() -eq '---')) { $plan = @($plan[0..($plan.Count - 2)]) }

function Get-HeaderField([string] $name) {
    foreach ($l in $plan) { if ($l -match "^\s*\*\*$([regex]::Escape($name)):\*\*\s*(.*?)\s*$") { return ($Matches[1] -replace '<!--.*?-->', '').Trim() } }
    return $null
}

# --- Split into "## " sections -------------------------------------------------------------
$sections = [ordered]@{}
$current = '_header'; $sections[$current] = New-Object System.Collections.Generic.List[string]
foreach ($l in $plan) {
    if ($l -match '^##\s+(.+?)\s*$' -and $l -notmatch '^###') {
        $current = $Matches[1].Trim()
        if (-not $sections.Contains($current)) { $sections[$current] = New-Object System.Collections.Generic.List[string] }
        continue
    }
    $sections[$current].Add($l)
}
function Get-Section([string] $name) {
    foreach ($k in $sections.Keys) { if ($k -ieq $name) { return @($sections[$k]) } }
    return $null
}

$errors = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$revisionRaw = Get-HeaderField 'Revision'
$revision = $null
if ($revisionRaw -match '^\d+$') { $revision = [int]$revisionRaw } else { $errors.Add("header: '**Revision:**' missing or not an integer") }
$status = Get-HeaderField 'Status'
if (-not $status) { $errors.Add("header: '**Status:**' missing") }
$targetBranch = Get-HeaderField 'Target branch'
if (-not $targetBranch) { $errors.Add("header: '**Target branch:**' missing") }

# --- Acceptance criteria -------------------------------------------------------------------
$acs = [ordered]@{}
$acSection = Get-Section 'Acceptance Criteria'
if ($null -eq $acSection) { $errors.Add("section '## Acceptance Criteria' missing") }
else {
    foreach ($l in $acSection) {
        if ($l -match '^\s*[-*]\s*(?:\*\*)?(AC-\d+)(?:\*\*)?\s*[:\u2014-]\s*(.+?)\s*$') {
            if ($acs.Contains($Matches[1])) { $errors.Add("duplicate acceptance criterion $($Matches[1])") }
            $acs[$Matches[1]] = Get-Sha256 ($Matches[2].Trim())
        }
    }
    if ($acs.Count -eq 0) { $errors.Add("no acceptance criteria found (expected lines like '- AC-1: ...')") }
}

# --- Unresolved decisions -------------------------------------------------------------------
$unresolved = @()
$udSection = Get-Section 'Unresolved Decisions'
if ($null -eq $udSection) { $errors.Add("section '## Unresolved Decisions' missing (write '- none' when empty)") }
else {
    foreach ($l in $udSection) {
        if ($l -match '^\s*[-*]\s*(?:\[[ xX]?\]\s*)?(.+?)\s*$') {
            $item = $Matches[1]
            if ($l -match '^\s*[-*]\s*\[[xX]\]') { continue }
            if ($item -notmatch '^(none|n/a|-)\.?$') { $unresolved += $item }
        }
    }
}

# --- Tasks ---------------------------------------------------------------------------------
$taskSection = Get-Section 'Tasks'
$hasTasksSection = [bool](@($sections.Keys | Where-Object { $_ -ieq 'Tasks' }).Count)
$tasks = [ordered]@{}
if (-not $hasTasksSection) { $errors.Add("section '## Tasks' missing") }
else {
    if ($null -eq $taskSection) { $taskSection = @() }  # empty section -> reported as 'no tasks found' below
    $cur = $null; $buf = $null
    $flush = {
        if ($null -ne $cur) { $cur.block = $buf.ToArray(); $tasks[$cur.id] = $cur }
    }
    foreach ($l in $taskSection) {
        if ($l -match '^###\s+(T\d+[a-z]?)\s*[:\u2014-]\s*(.+?)\s*$') {
            & $flush
            if ($tasks.Contains($Matches[1])) { $errors.Add("duplicate task id $($Matches[1])") }
            $cur = [ordered]@{ id = $Matches[1]; title = $Matches[2]; block = @() }
            $buf = New-Object System.Collections.Generic.List[string]
            $buf.Add($l)
            continue
        }
        if ($l -match '^###\s+') { $warnings.Add("ignored heading in Tasks (expected '### T<n>: Title'): $l") }
        if ($null -ne $buf) { $buf.Add($l) }
    }
    & $flush
    if ($tasks.Count -eq 0) { $errors.Add("no tasks found (expected headings like '### T1: Title')") }
}

function Get-Field($block, [string] $name) {
    foreach ($l in $block) { if ($l -match "^\s*[-*]\s*\*\*$([regex]::Escape($name)):\*\*\s*(.*?)\s*$") { return $Matches[1] } }
    return $null
}

$taskList = New-Object System.Collections.Generic.List[object]
foreach ($id in $tasks.Keys) {
    $t = $tasks[$id]; $b = $t.block
    $depsRaw = Get-Field $b 'Depends on'
    $ownsRaw = Get-Field $b 'Owns'
    $accRaw = Get-Field $b 'Acceptance'
    $verify = Get-Field $b 'Verify'
    $model = Get-Field $b 'Model'
    $review = Get-Field $b 'Review'
    $workspace = Get-Field $b 'Workspace'
    $method = Get-Field $b 'Method'
    if ([string]::IsNullOrWhiteSpace($workspace)) { $errors.Add("${id}: missing '- **Workspace:**' (main | worktree)") }
    elseif ($workspace -notmatch '^(main|worktree)\b') { $errors.Add("${id}: '**Workspace:**' must be 'main' or 'worktree' (got '$workspace')") }
    if ([string]::IsNullOrWhiteSpace($method)) { $errors.Add("${id}: missing '- **Method:**' (tdd | refactor | mechanical | git-ops | verify)") }
    elseif ($method -notmatch '^(tdd|refactor|mechanical|git-ops|verify)$') { $errors.Add("${id}: '**Method:**' must be one of tdd | refactor | mechanical | git-ops | verify (got '$method')") }
    $workspaceValue = $(if ($workspace -match '^(main|worktree)\b') { $Matches[1] } else { $workspace })
    if ($null -eq $depsRaw) { $errors.Add("${id}: missing '- **Depends on:**' (use 'none')") }
    if ([string]::IsNullOrWhiteSpace($ownsRaw)) { $errors.Add("${id}: missing '- **Owns:**' with backticked paths") }
    if ([string]::IsNullOrWhiteSpace($accRaw)) { $errors.Add("${id}: missing '- **Acceptance:**' (AC ids)") }
    if ([string]::IsNullOrWhiteSpace($verify)) { $errors.Add("${id}: missing '- **Verify:**' (test command)") }
    $deps = @(); if ($depsRaw) { $deps = @([regex]::Matches($depsRaw, 'T\d+[a-z]?') | ForEach-Object { $_.Value } | Select-Object -Unique) }
    $owns = @(); if ($ownsRaw) { $owns = @([regex]::Matches($ownsRaw, '`([^`]+)`') | ForEach-Object { ($_.Groups[1].Value -replace '\\', '/').Trim().TrimStart('./') } | Select-Object -Unique) }
    if ($ownsRaw -and $owns.Count -eq 0) { $errors.Add("${id}: '**Owns:**' has no backticked paths") }
    $accIds = @(); if ($accRaw) { $accIds = @([regex]::Matches($accRaw, 'AC-\d+') | ForEach-Object { $_.Value } | Select-Object -Unique) }
    foreach ($a in $accIds) { if (-not $acs.Contains($a)) { $errors.Add("${id}: references unknown acceptance criterion $a") } }
    foreach ($d in $deps) {
        if ($d -eq $id) { $errors.Add("${id}: depends on itself") }
        elseif (-not $tasks.Contains($d)) { $errors.Add("${id}: depends on unknown task $d") }
    }
    $taskList.Add([pscustomobject][ordered]@{
        id = $id; title = $t.title; dependsOn = $deps; owns = $owns; acceptance = $accIds
        verify = $verify; workspace = $workspaceValue; method = $method; model = ($(if ($model) { $model } else { 'default' })); review = ($(if ($review) { $review } else { 'final' }))
        hash = Get-Sha256 (Normalize $b); wave = $null
    })
}

# ACs not covered by any task
foreach ($a in $acs.Keys) {
    if (-not ($taskList | Where-Object { $_.acceptance -contains $a })) { $warnings.Add("$a is not referenced by any task") }
}

# --- Waves (Kahn levels) + cycle detection --------------------------------------------------
$byId = @{}; foreach ($t in $taskList) { $byId[$t.id] = $t }
$remaining = New-Object System.Collections.Generic.List[string]; foreach ($t in $taskList) { $remaining.Add($t.id) }
$level = 1
while ($remaining.Count -gt 0) {
    $ready = @()
    foreach ($candidate in $remaining) {
        $blocked = $false
        foreach ($dep in $byId[$candidate].dependsOn) {
            if (-not $byId.ContainsKey($dep) -or $dep -eq $candidate) { continue }
            if ($null -eq $byId[$dep].wave -or $byId[$dep].wave -ge $level) { $blocked = $true; break }
        }
        if (-not $blocked) { $ready += $candidate }
    }
    if ($ready.Count -eq 0) { $errors.Add("dependency cycle among: $($remaining -join ', ')"); break }
    foreach ($r in $ready) { $byId[$r].wave = $level; [void]$remaining.Remove($r) }
    $level++
}

# --- Ownership conflicts between tasks that are not dependency-ordered ----------------------
$ancestors = @{}
function Get-Ancestors([string] $id, [hashtable] $seen) {
    if ($ancestors.ContainsKey($id)) { return $ancestors[$id] }
    $set = New-Object System.Collections.Generic.HashSet[string]
    if ($seen.ContainsKey($id)) { return $set }
    $seen[$id] = $true
    foreach ($d in $byId[$id].dependsOn) {
        if (-not $byId.ContainsKey($d)) { continue }
        [void]$set.Add($d)
        foreach ($x in (Get-Ancestors $d $seen)) { [void]$set.Add($x) }
    }
    $ancestors[$id] = $set
    return $set
}
foreach ($t in $taskList) { [void](Get-Ancestors $t.id @{}) }
function Test-Wildcard([string] $p) { return $p -match '[\*\?\[]' }
function Get-LiteralPrefix([string] $p) { $i = $p.IndexOfAny([char[]]'*?['); if ($i -lt 0) { return $p } return $p.Substring(0, $i) }
function Test-Overlap([string] $a, [string] $b) {
    $wa = Test-Wildcard $a; $wb = Test-Wildcard $b
    if (-not $wa -and -not $wb) { return $a -ieq $b }
    if ($wa -and -not $wb) { return $b -like ($a -replace '\*\*', '*') }
    if (-not $wa -and $wb) { return $a -like ($b -replace '\*\*', '*') }
    # both patterns: conservative - overlap when their literal prefixes are nested
    $pa = (Get-LiteralPrefix $a).ToLowerInvariant(); $pb = (Get-LiteralPrefix $b).ToLowerInvariant()
    return $pa.StartsWith($pb) -or $pb.StartsWith($pa)
}
$conflicts = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $taskList.Count; $i++) {
    for ($j = $i + 1; $j -lt $taskList.Count; $j++) {
        $a = $taskList[$i]; $b = $taskList[$j]
        $ordered = $ancestors[$a.id].Contains($b.id) -or $ancestors[$b.id].Contains($a.id)
        $shared = @(foreach ($x in $a.owns) { foreach ($y in $b.owns) { if (Test-Overlap $x $y) { if ($x -eq $y) { $x } else { "$x ~ $y" } } } })
        if ($shared.Count -gt 0 -and -not $ordered) {
            $conflicts.Add([pscustomobject]@{ tasks = @($a.id, $b.id); files = $shared })
            $errors.Add("ownership conflict: $($a.id) and $($b.id) both own $($shared -join ', ') but are not ordered by dependencies")
        }
    }
}

$waves = @()
$assigned = @($taskList | Where-Object { $null -ne $_.wave })
if ($assigned.Count -gt 0) {
    $maxWave = ($assigned | Measure-Object -Property wave -Maximum).Maximum
    for ($w = 1; $w -le $maxWave; $w++) { $waves += , @($taskList | Where-Object { $_.wave -eq $w } | ForEach-Object { $_.id }) }
}

# --- Requirements hash (ignores volatile header fields and bookkeeping sections) -------------
$volatileSections = @('Execution Graph', 'Revision History', 'Progress')
$reqLines = New-Object System.Collections.Generic.List[string]
$skip = $false
foreach ($l in $plan) {
    if ($l -match '^##\s+(.+?)\s*$' -and $l -notmatch '^###') { $skip = ($volatileSections -icontains $Matches[1].Trim()) }
    if ($skip) { continue }
    if ($l -match '^\s*\*\*(Status|Updated|Revision):\*\*') { continue }
    $reqLines.Add($l)
}
$scopeLines = New-Object System.Collections.Generic.List[string]
foreach ($name in @('Goal', 'Scope', 'Constraints')) { $s = Get-Section $name; if ($s) { $scopeLines.AddRange([string[]]$s) } }

$result = [ordered]@{
    ok               = ($errors.Count -eq 0)
    planPath         = (Resolve-Path -LiteralPath $PlanPath).Path
    revision         = $revision
    status           = $status
    targetBranch     = $targetBranch
    requirementsHash = Get-Sha256 (Normalize $reqLines.ToArray())
    scopeHash        = Get-Sha256 (Normalize $scopeLines.ToArray())
    unresolvedDecisions = $unresolved
    acceptanceCriteria  = $acs
    tasks            = $taskList
    waves            = $waves
    conflicts        = $conflicts
    errors           = $errors
    warnings         = $warnings
}

# --- Drift against a previous snapshot ------------------------------------------------------
$drift = $null
if ($Compare) {
    if (-not (Test-Path -LiteralPath $Compare)) { Fail-Parse "snapshot not found: $Compare" }
    $prev = Get-Content -LiteralPath $Compare -Raw | ConvertFrom-Json
    $prevTasks = @{}; foreach ($t in @($prev.tasks)) { $prevTasks[$t.id] = $t }
    $prevAcs = @{}; if ($prev.acceptanceCriteria) { foreach ($p in $prev.acceptanceCriteria.PSObject.Properties) { $prevAcs[$p.Name] = $p.Value } }
    $changedAcs = @(); foreach ($k in $acs.Keys) { if (-not $prevAcs.ContainsKey($k) -or $prevAcs[$k] -ne $acs[$k]) { $changedAcs += $k } }
    $removedAcs = @($prevAcs.Keys | Where-Object { -not $acs.Contains($_) })
    $changed = @(); $added = @()
    foreach ($t in $taskList) {
        if (-not $prevTasks.ContainsKey($t.id)) { $added += $t.id }
        elseif ($prevTasks[$t.id].hash -ne $t.hash) { $changed += $t.id }
    }
    $removed = @($prevTasks.Keys | Where-Object { -not $byId.ContainsKey($_) })
    $touchedAcs = @($changedAcs + $removedAcs)
    $direct = New-Object System.Collections.Generic.HashSet[string]
    foreach ($x in $changed) { [void]$direct.Add($x) }
    foreach ($t in $taskList) { if (@($t.acceptance | Where-Object { $touchedAcs -contains $_ }).Count -gt 0) { [void]$direct.Add($t.id) } }
    foreach ($t in @($prev.tasks)) { if ($byId.ContainsKey($t.id) -and @($t.acceptance | Where-Object { $removedAcs -contains $_ }).Count -gt 0) { [void]$direct.Add($t.id) } }
    $downstream = New-Object System.Collections.Generic.HashSet[string]
    foreach ($t in $taskList) {
        if ($direct.Contains($t.id)) { continue }
        foreach ($d in $direct) { if ($ancestors[$t.id].Contains($d)) { [void]$downstream.Add($t.id); break } }
    }
    $scopeChanged = ($prev.scopeHash -ne $result.scopeHash)
    $drift = [ordered]@{
        previousRevision   = $prev.revision
        requirementsChanged = ($prev.requirementsHash -ne $result.requirementsHash)
        revisionBumped     = ($prev.revision -ne $revision)
        scopeChanged       = $scopeChanged
        changedTasks       = $changed
        addedTasks         = $added
        removedTasks       = $removed
        changedAcceptance  = $changedAcs
        removedAcceptance  = $removedAcs
        affectedTasks      = @($direct | Sort-Object)
        downstreamTasks    = @($downstream | Sort-Object)
    }
    $result['drift'] = $drift
}

$json = $result | ConvertTo-Json -Depth 8
if ($SnapshotOut) { [System.IO.File]::WriteAllText($SnapshotOut, $json, (New-Object System.Text.UTF8Encoding($false))) }
$json
if ($errors.Count -gt 0) { exit 1 }
if ($FailOnDrift -and $drift -and $drift.requirementsChanged) { exit 1 }
exit 0
