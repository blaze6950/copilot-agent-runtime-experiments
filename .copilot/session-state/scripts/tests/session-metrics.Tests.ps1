<#
.SYNOPSIS
    Black-box tests for session-state/scripts/session-metrics.csx (AC-3). No Pester dependency.
    Run: pwsh -NoProfile -File session-metrics.Tests.ps1   (exit code = number of failures)
#>
$ErrorActionPreference = 'Stop'
$csx = Join-Path (Split-Path -Parent $PSScriptRoot) 'session-metrics.csx'
$fixtures = Join-Path $PSScriptRoot 'fixtures' 'metrics' 'sessions'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("session-metrics-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0

$rootKeys = @('schemaVersion', 'generatedAt', 'source', 'sessions', 'skipped')
$sessionKeys = @('sessionId', 'startTime', 'endTime', 'cwd', 'gitRoot', 'copilotVersion', 'durationMs', 'userTurns',
    'premiumRequests', 'models', 'cacheReadRatio', 'compactions', 'peakContextTokens', 'errors', 'toolCalls',
    'toolFailures', 'dispatches', 'dispatchFailures', 'repeatDispatches', 'writeAgentCalls', 'builtinAgentDispatches',
    'readOnlyAgentWriteCalls', 'mainPowershellCalls', 'agents',
    # schema v2 additions
    'costUsd', 'compactionCostUsd', 'agentUsage', 'keepAlive', 'hookLatency')
$modelKeys = @('model', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd')
$agentKeys = @('agentName', 'dispatches', 'failures', 'repeatDispatches', 'totalTokens', 'medianTokens', 'medianDurationMs', 'toolCalls')
$agentUsageKeys = @('agent', 'requests', 'costUsd', 'llmMs', 'toolMs', 'wallMs', 'otherMs')
$keepAliveKeys = @('pings', 'costUsd', 'chains', 'wastedChains')
$hookLatencyKeys = @('count', 'totalMs', 'p50Ms', 'p90Ms')
$v2Fixtures = Join-Path $PSScriptRoot 'fixtures' 'metrics' 'v2'
$staleMessage = 'export.json is stale for {0}: run export-events.csx first'

function Assert([bool] $cond, [string] $name, [string] $detail = '') {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name $detail" -ForegroundColor Red }
}

function Show-ScriptOutputOnFailure([string] $label, [int] $code, $output) {
    if ($code -eq 0) { return }
    $lines = @(($output | Out-String) -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    Write-Host "--- $label exited $code; last 40 lines of its output:" -ForegroundColor Yellow
    $lines | Select-Object -Last 40 | ForEach-Object { Write-Host "    $_" }
}

function Invoke-Metrics([string[]] $arguments) {
    $out = & dotnet script $csx @arguments 2>&1
    $code = $LASTEXITCODE
    Show-ScriptOutputOnFailure ("session-metrics " + ($arguments -join ' ')) $code $out
    return [pscustomobject]@{ code = $code; text = ($out | Out-String) }
}

function Test-KeySet($obj, [string[]] $expected) {
    if ($null -eq $obj) { return $false }
    $actual = @($obj.PSObject.Properties.Name | Sort-Object)
    return (($actual -join ',') -ceq (@($expected | Sort-Object) -join ','))
}

# Compares a scalar actual value with an expected value ($null means JSON null).
function Same($actual, $expected) {
    if ($null -eq $expected) { return $null -eq $actual }
    if ($null -eq $actual) { return $false }
    if ($expected -is [string]) { return ($actual -is [string]) -and ($actual -ceq $expected) }
    return [math]::Abs([double]$actual - [double]$expected) -lt 1e-9
}

function Get-ScalarMismatches($obj, [hashtable] $expected) {
    $bad = @()
    foreach ($k in $expected.Keys) {
        if (-not (Same $obj.$k $expected[$k])) { $bad += "$k=[$($obj.$k)] want [$($expected[$k])]" }
    }
    return $bad
}

try {
    $outFile = Join-Path $tmp 'm.json'
    $run = Invoke-Metrics @($fixtures, '--out', $outFile)
    Assert ($run.code -eq 0) 'fixtures run exits 0 (malformed export does not abort)' "exit=$($run.code) $($run.text)"
    # -DateKind String keeps ISO timestamps as the exact strings the contract specifies.
    $doc = if (Test-Path -LiteralPath $outFile) { Get-Content -Raw -LiteralPath $outFile | ConvertFrom-Json -DateKind String } else { $null }
    Assert ($null -ne $doc) 'output file is written and parses as JSON'
    Assert (Test-KeySet $doc $rootKeys) 'root has exactly the contract keys' ("keys=" + (@($doc.PSObject.Properties.Name) -join ','))
    Assert ($doc.schemaVersion -eq 2) 'schemaVersion is 2' "got=$($doc.schemaVersion)"
    Assert ($doc.sessions.Count -eq 3) 'three sessions reported' "count=$($doc.sessions.Count)"

    $expectedSessions = @{
        'sess-a-repeat' = @{
            scalars = @{ sessionId = 'sess-a-repeat'; startTime = '2026-05-01T10:00:00Z'; endTime = '2026-05-01T11:00:00Z'
                cwd = 'C:\synthetic\project-a'; gitRoot = $null; copilotVersion = '1.0.0-test'; durationMs = 3600000
                userTurns = 2; premiumRequests = 3; cacheReadRatio = (1000 / 1500); compactions = 1; peakContextTokens = 150000
                errors = 1; toolCalls = 6; toolFailures = 1; dispatches = 4; dispatchFailures = 1; repeatDispatches = 1
                writeAgentCalls = 0; builtinAgentDispatches = 0; readOnlyAgentWriteCalls = 0; mainPowershellCalls = 0 }
            models = @(
                @{ model = 'claude-sonnet-4.6'; requests = 5; inputTokens = 1000; outputTokens = 300; cacheReadTokens = 900; cacheWriteTokens = 100 },
                @{ model = 'claude-haiku-4.5'; requests = 2; inputTokens = 500; outputTokens = 50; cacheReadTokens = 100; cacheWriteTokens = 0 })
            agents = @(
                @{ agentName = 'sub-explorer-code'; dispatches = 3; failures = 0; repeatDispatches = 1; totalTokens = 4500; medianTokens = 1500; medianDurationMs = 2000; toolCalls = 9 },
                @{ agentName = 'sub-worker-wt'; dispatches = 1; failures = 1; repeatDispatches = 0; totalTokens = 300; medianTokens = 300; medianDurationMs = 500; toolCalls = 1 })
        }
        'sess-b-builtin' = @{
            scalars = @{ sessionId = 'sess-b-builtin'; startTime = '2026-05-02T09:00:00Z'; endTime = '2026-05-02T09:30:00Z'
                cwd = 'C:\synthetic\project-b'; gitRoot = $null; copilotVersion = '1.0.1-test'; durationMs = 1800000
                userTurns = 1; premiumRequests = 1; cacheReadRatio = 0.9; compactions = 0; peakContextTokens = 52000
                errors = 0; toolCalls = 7; toolFailures = 0; dispatches = 7; dispatchFailures = 0; repeatDispatches = 0
                writeAgentCalls = 2; builtinAgentDispatches = 1; readOnlyAgentWriteCalls = 4; mainPowershellCalls = 0 }
            models = @(
                @{ model = 'claude-opus-4.6'; requests = 3; inputTokens = 1000; outputTokens = 900; cacheReadTokens = 900; cacheWriteTokens = 100 })
            agents = @(
                @{ agentName = 'explore'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 2000; medianTokens = 2000; medianDurationMs = 4000; toolCalls = 4 },
                @{ agentName = 'sub-debugger'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 300; medianTokens = 300; medianDurationMs = 3000; toolCalls = 2 },
                @{ agentName = 'sub-expert-ado-writer'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 500; medianTokens = 500; medianDurationMs = 1000; toolCalls = 1 },
                @{ agentName = 'sub-explorer'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 150; medianTokens = 150; medianDurationMs = 2000; toolCalls = 1 },
                @{ agentName = 'sub-explorer-code'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 3000; medianTokens = 3000; medianDurationMs = 6000; toolCalls = 5 },
                @{ agentName = 'sub-researcher-ado'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 150; medianTokens = 150; medianDurationMs = 1000; toolCalls = 1 },
                @{ agentName = 'sub-writer-ado'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = 150; medianTokens = 150; medianDurationMs = 1000; toolCalls = 1 })
        }
        'sess-c-powershell' = @{
            scalars = @{ sessionId = 'sess-c-powershell'; startTime = '2026-05-03T14:00:00Z'; endTime = '2026-05-03T16:00:00Z'
                cwd = 'C:\synthetic\project-c'; gitRoot = $null; copilotVersion = '1.0.2-test'; durationMs = 7200000
                userTurns = 3; premiumRequests = 4; cacheReadRatio = $null; compactions = 1; peakContextTokens = 90000
                errors = 2; toolCalls = 7; toolFailures = 1; dispatches = 1; dispatchFailures = 0; repeatDispatches = 0
                writeAgentCalls = 0; builtinAgentDispatches = 0; readOnlyAgentWriteCalls = 0; mainPowershellCalls = 2 }
            models = @(
                @{ model = 'claude-sonnet-4.6'; requests = 4; inputTokens = 4000; outputTokens = 1000; cacheReadTokens = 6000; cacheWriteTokens = 0 },
                @{ model = 'claude-haiku-4.5'; requests = 1; inputTokens = 200; outputTokens = 10; cacheReadTokens = $null; cacheWriteTokens = 0 })
            agents = @(
                @{ agentName = 'sub-reviewer-code'; dispatches = 1; failures = 0; repeatDispatches = 0; totalTokens = $null; medianTokens = $null; medianDurationMs = 800; toolCalls = 2 })
        }
    }

    foreach ($id in $expectedSessions.Keys) {
        $exp = $expectedSessions[$id]
        $s = @($doc.sessions | Where-Object { $_.sessionId -eq $id })[0]
        Assert ($null -ne $s) "session $id present"
        if ($null -eq $s) { continue }
        Assert (Test-KeySet $s $sessionKeys) "$id has exactly the contract session keys" ("keys=" + (@($s.PSObject.Properties.Name) -join ','))
        $bad = Get-ScalarMismatches $s $exp.scalars
        Assert ($bad.Count -eq 0) "$id scalar fields match fixture" ($bad -join '; ')
        # v1 exports have no per-request records: every v2 field is null, never a guess.
        $v2Nulls = @('costUsd', 'compactionCostUsd', 'agentUsage', 'keepAlive', 'hookLatency') | Where-Object { $null -ne $s.$_ }
        Assert (@($v2Nulls).Count -eq 0) "$id v2 fields are null without per-request records" ($v2Nulls -join ',')
        $modelCosts = @($s.models | Where-Object { $null -ne $_.costUsd })
        Assert ($modelCosts.Count -eq 0) "$id model costUsd is null without per-request records"

        $badModels = @()
        Assert ($s.models.Count -eq $exp.models.Count) "$id has $($exp.models.Count) models" "count=$($s.models.Count)"
        foreach ($em in $exp.models) {
            $m = @($s.models | Where-Object { $_.model -eq $em.model })[0]
            if ($null -eq $m) { $badModels += "missing $($em.model)"; continue }
            if (-not (Test-KeySet $m $modelKeys)) { $badModels += "$($em.model) keys" }
            $badModels += Get-ScalarMismatches $m $em | ForEach-Object { "$($em.model): $_" }
        }
        Assert ($badModels.Count -eq 0) "$id models match fixture" ($badModels -join '; ')

        $badAgents = @()
        Assert ($s.agents.Count -eq $exp.agents.Count) "$id has $($exp.agents.Count) agents" "count=$($s.agents.Count)"
        $expectedOrder = @($exp.agents | ForEach-Object { $_.agentName })
        $actualOrder = @($s.agents | ForEach-Object { $_.agentName })
        Assert (($actualOrder -join ',') -ceq ($expectedOrder -join ',')) "$id agents sorted by agentName" ($actualOrder -join ',')
        foreach ($ea in $exp.agents) {
            $a = @($s.agents | Where-Object { $_.agentName -eq $ea.agentName })[0]
            if ($null -eq $a) { $badAgents += "missing $($ea.agentName)"; continue }
            if (-not (Test-KeySet $a $agentKeys)) { $badAgents += "$($ea.agentName) keys" }
            $badAgents += Get-ScalarMismatches $a $ea | ForEach-Object { "$($ea.agentName): $_" }
        }
        Assert ($badAgents.Count -eq 0) "$id agents match fixture" ($badAgents -join '; ')
    }

    $skip = if ($null -ne $doc) { @($doc.skipped) } else { @() }
    Assert ($skip.Count -eq 1) 'exactly one skipped entry' "count=$($skip.Count)"
    Assert (@($skip | Where-Object { $_.sessionId -eq 'sess-malformed' -and $_.reason -is [string] -and $_.reason.Length -gt 0 }).Count -eq 1) 'malformed export listed in skipped with a reason'

    # Date filter: --from/--to are inclusive UTC dates of sessionStart.
    $filtered = Join-Path $tmp 'filtered.json'
    $run = Invoke-Metrics @($fixtures, '--out', $filtered, '--from', '2026-05-02', '--to', '2026-05-02')
    Assert ($run.code -eq 0) 'date-filtered run exits 0' "exit=$($run.code) $($run.text)"
    $fdoc = if (Test-Path -LiteralPath $filtered) { Get-Content -Raw -LiteralPath $filtered | ConvertFrom-Json -DateKind String } else { $null }
    $ids = @($fdoc.sessions | ForEach-Object { $_.sessionId })
    Assert (($ids -join ',') -ceq 'sess-b-builtin') 'date filter keeps only sessions starting on that day' ($ids -join ',')

    # ── schema v2: cost, time split, hook latency from the per-request records ──
    function Read-Doc([string] $path) {
        if (Test-Path -LiteralPath $path) { return (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -DateKind String) }
        return $null
    }
    $usageOut = Join-Path $tmp 'usage.json'
    $run = Invoke-Metrics @((Join-Path $v2Fixtures 'usage'), '--out', $usageOut)
    Assert ($run.code -eq 0) 'v2 usage fixture exits 0' "exit=$($run.code) $($run.text)"
    $usageDoc = Read-Doc $usageOut
    $u = if ($null -ne $usageDoc) { @($usageDoc.sessions)[0] } else { $null }
    Assert ($null -ne $u -and $u.sessionId -eq 'sess-v2-usage') 'v2 usage session present'
    if ($null -ne $u) {
        Assert (Test-KeySet $u $sessionKeys) 'v2 session has exactly the v2 session keys' ("keys=" + (@($u.PSObject.Properties.Name) -join ','))
        $bad = Get-ScalarMismatches $u @{ costUsd = 0.36; compactionCostUsd = 0.05 }
        Assert ($bad.Count -eq 0) 'session cost = export costUsd (records + compaction)' ($bad -join '; ')

        $opus = @($u.models | Where-Object { $_.model -eq 'claude-opus-5.5' })[0]
        $haiku = @($u.models | Where-Object { $_.model -eq 'claude-haiku-5.5' })[0]
        Assert ($null -ne $opus -and (Same $opus.costUsd 0.30)) 'cost per model: opus = sum of its request costs (nano-AIU / 1e11)' "got=$($opus.costUsd)"
        Assert ($null -ne $haiku -and (Same $haiku.costUsd 0.01)) 'cost per model: haiku = sum of its request costs' "got=$($haiku.costUsd)"

        $usage = @($u.agentUsage)
        Assert ((($usage | ForEach-Object { $_.agent }) -join ',') -ceq 'main,sub-explorer-code') 'agentUsage has main and the sub-agent, sorted by name' (($usage | ForEach-Object { $_.agent }) -join ',')
        $main = @($usage | Where-Object { $_.agent -eq 'main' })[0]
        $sub = @($usage | Where-Object { $_.agent -eq 'sub-explorer-code' })[0]
        Assert ($null -ne $main -and (Test-KeySet $main $agentUsageKeys)) 'agentUsage rows have exactly the contract keys'
        $bad = if ($null -ne $main) { Get-ScalarMismatches $main @{ requests = 3; costUsd = 0.30; llmMs = 200000; toolMs = 50000; wallMs = 600000; otherMs = 350000 } } else { 'missing' }
        Assert ($bad.Count -eq 0) 'main: llm = request durations, tools = timeline tool durations, other = wall - llm - tools' ($bad -join '; ')
        $bad = if ($null -ne $sub) { Get-ScalarMismatches $sub @{ requests = 2; costUsd = 0.01; llmMs = 30000; toolMs = 35000; wallMs = 60000; otherMs = 0 } } else { 'missing' }
        Assert ($bad.Count -eq 0) 'sub-agent: requests matched by dispatch window; other is clamped at 0 (llm + tools > wall)' ($bad -join '; ')

        Assert (Test-KeySet $u.hookLatency $hookLatencyKeys) 'hookLatency has exactly the contract keys'
        $bad = Get-ScalarMismatches $u.hookLatency @{ count = 10; totalMs = 550; p50Ms = 50; p90Ms = 90 }
        Assert ($bad.Count -eq 0) 'hook latency: count, total, p50, p90 (nearest rank) over preToolUse windows' ($bad -join '; ')
        Assert ($u.keepAlive.pings -eq 0) 'usage session without keep-alive messages has no pings' "pings=$($u.keepAlive.pings)"
    }

    # ── schema v2: keep-alive chains ──
    $chainsOut = Join-Path $tmp 'chains.json'
    $run = Invoke-Metrics @((Join-Path $v2Fixtures 'chains'), '--out', $chainsOut)
    Assert ($run.code -eq 0) 'v2 chains fixture exits 0' "exit=$($run.code) $($run.text)"
    $chainsDoc = Read-Doc $chainsOut
    $c = if ($null -ne $chainsDoc) { @($chainsDoc.sessions)[0] } else { $null }
    if ($null -ne $c) {
        Assert (Test-KeySet $c.keepAlive $keepAliveKeys) 'keepAlive has exactly the contract keys'
        # A ping is only the FIRST root request after each keep-alive message: the two follow-up requests of the
        # first keep-alive (notice work, 2 x $0.50) and the sub-agent request ($0.10) are not keep-alive cost.
        Assert ($c.keepAlive.pings -eq 5) 'pings = first root request after each of the 5 keep-alive messages' "pings=$($c.keepAlive.pings)"
        Assert (Same $c.keepAlive.costUsd 0.15) 'keep-alive cost = the ping requests only (0.01+0.02+0.03+0.04+0.05)' "cost=$($c.keepAlive.costUsd)"
        Assert ($c.keepAlive.chains -eq 4) 'chains = runs of keep-alive messages between real turns' "chains=$($c.keepAlive.chains)"
        Assert ($c.keepAlive.wastedChains -eq 1) 'wasted = next real request is a miss (context >= 20000 and cache write > 0.5 x context)' "wasted=$($c.keepAlive.wastedChains)"
    }
    else { Assert $false 'v2 chains session present' }

    # ── exact attribution: concurrent sub-agents (same time window, same model) matched by agentId ──
    $overlapOut = Join-Path $tmp 'overlap.json'
    $run = Invoke-Metrics @((Join-Path $v2Fixtures 'overlap'), '--out', $overlapOut)
    Assert ($run.code -eq 0) 'v2 overlap fixture exits 0' "exit=$($run.code) $($run.text)"
    $overlapDoc = Read-Doc $overlapOut
    $o = if ($null -ne $overlapDoc) { @($overlapDoc.sessions)[0] } else { $null }
    if ($null -ne $o) {
        $names = (@($o.agentUsage | Where-Object { $_.agent -ne 'main' }) | ForEach-Object { $_.agent }) -join ','
        Assert ($names -ceq 'sub-expert-ado,sub-explorer-code') 'overlapping sub-agents are attributed by agentId (no unattributed)' "agents=$names"
        $ado = @($o.agentUsage | Where-Object { $_.agent -eq 'sub-expert-ado' })[0]
        $exp = @($o.agentUsage | Where-Object { $_.agent -eq 'sub-explorer-code' })[0]
        $bad = if ($null -ne $ado) { Get-ScalarMismatches $ado @{ requests = 1; costUsd = 0.05; llmMs = 500; wallMs = 4000; otherMs = 3500 } } else { 'missing' }
        Assert ($bad.Count -eq 0) 'sub-expert-ado gets exactly its own request (agent-B)' ($bad -join '; ')
        $bad = if ($null -ne $exp) { Get-ScalarMismatches $exp @{ requests = 1; costUsd = 0.06; llmMs = 600; wallMs = 4000; otherMs = 3400 } } else { 'missing' }
        Assert ($bad.Count -eq 0) 'sub-explorer-code gets exactly its own request (agent-A)' ($bad -join '; ')
    }
    else { Assert $false 'v2 overlap session present' }

    # Old export without agentId on the dispatches: the time-window fallback cannot tell two concurrent
    # sub-agents apart and reports their requests as unattributed (never a guess).
    $oldRoot = Join-Path $tmp 'overlap-old'
    $oldDir = Join-Path $oldRoot 'sess-v2-overlap'
    New-Item -ItemType Directory -Path $oldDir -Force | Out-Null
    $oldText = (Get-Content -Raw -LiteralPath (Join-Path $v2Fixtures 'overlap' 'sess-v2-overlap' 'export.json')).Replace('"agentId": "agent-A", "status"', '"status"').Replace('"agentId": "agent-B", "status"', '"status"')
    Set-Content -LiteralPath (Join-Path $oldDir 'export.json') -Value $oldText -NoNewline
    $oldOut = Join-Path $tmp 'overlap-old.json'
    $run = Invoke-Metrics @($oldRoot, '--out', $oldOut)
    $oldDoc = Read-Doc $oldOut
    $unattributed = if ($null -ne $oldDoc) { @(@($oldDoc.sessions)[0].agentUsage | Where-Object { $_.agent -eq 'unattributed' })[0] } else { $null }
    Assert ($run.code -eq 0 -and $null -ne $unattributed -and $unattributed.requests -eq 2) 'dispatches without agentId fall back to the time window: concurrent sub-agents stay unattributed' "exit=$($run.code) un=$($unattributed.requests)"

    # ── unknown cost: a shutdown-fallback export (requests: []) has no per-request USD, so every cost is null, never 0 ──
    $fallbackRoot = Join-Path $tmp 'fallback'
    $fallbackDir = Join-Path $fallbackRoot 'sess-v2-fallback'
    New-Item -ItemType Directory -Path $fallbackDir -Force | Out-Null
    $fallbackExport = Get-Content -Raw -LiteralPath (Join-Path $v2Fixtures 'usage' 'sess-v2-usage' 'export.json') | ConvertFrom-Json -DateKind String
    $fallbackExport.sessionId = 'sess-v2-fallback'
    $fallbackExport.requests = @()
    $fallbackExport.costUsd = 0
    $fallbackExport.compactionCostUsd = 0
    foreach ($fallbackModel in @($fallbackExport.modelMetrics.PSObject.Properties)) { $fallbackModel.Value.PSObject.Properties.Remove('costUsd') }
    Set-Content -LiteralPath (Join-Path $fallbackDir 'export.json') -Value ($fallbackExport | ConvertTo-Json -Depth 30) -NoNewline
    $fallbackOut = Join-Path $tmp 'fallback.json'
    $run = Invoke-Metrics @($fallbackRoot, '--out', $fallbackOut)
    Assert ($run.code -eq 0) 'shutdown-fallback export (no per-request records) exits 0' "exit=$($run.code) $($run.text)"
    $fallbackDoc = Read-Doc $fallbackOut
    $f = if ($null -ne $fallbackDoc) { @($fallbackDoc.sessions)[0] } else { $null }
    if ($null -ne $f) {
        Assert ($null -eq $f.costUsd) 'session cost is null without per-request records (unknown, not 0)' "got=$($f.costUsd)"
        $knownModelCosts = @($f.models | Where-Object { $null -ne $_.costUsd })
        Assert (@($f.models).Count -gt 0 -and $knownModelCosts.Count -eq 0) 'every model costUsd is null without per-request records' "models=$(@($f.models).Count) non-null=$($knownModelCosts.Count)"
        $knownAgentCosts = @($f.agentUsage | Where-Object { $null -ne $_.costUsd })
        Assert ($knownAgentCosts.Count -eq 0) 'every agentUsage costUsd is null without per-request records' "non-null=$($knownAgentCosts.Count)"
        Assert ($null -eq $f.keepAlive.costUsd) 'keep-alive cost is null without per-request records' "got=$($f.keepAlive.costUsd)"
    }
    else { Assert $false 'shutdown-fallback session present' }


    function New-StaleCase([string] $name, [int] $eventLines, [int] $blankLines, [bool] $dropSourceEventCount) {
        $root = Join-Path $tmp "stale-$name"
        $dir = Join-Path $root 'sess-v2-usage'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $exportText = Get-Content -Raw -LiteralPath (Join-Path $v2Fixtures 'usage' 'sess-v2-usage' 'export.json')
        if ($dropSourceEventCount) { $exportText = $exportText.Replace('"sourceEventCount": 5,', '') }
        Set-Content -LiteralPath (Join-Path $dir 'export.json') -Value $exportText -NoNewline
        $lines = @(1..$eventLines | ForEach-Object { '{"type":"synthetic.event","n":' + $_ + '}' }) + @(1..$blankLines | ForEach-Object { '' })
        Set-Content -LiteralPath (Join-Path $dir 'events.jsonl') -Value $lines
        $outPath = Join-Path $tmp "stale-$name.json"
        $r = Invoke-Metrics @($root, '--out', $outPath)
        return [pscustomobject]@{ code = $r.code; text = $r.text; wrote = (Test-Path -LiteralPath $outPath) }
    }
    $expectedStale = $staleMessage -f 'sess-v2-usage'
    $stale = New-StaleCase 'behind' 9 0 $false
    Assert ($stale.code -ne 0) 'stale export (sourceEventCount < events.jsonl lines) exits non-zero' "exit=$($stale.code)"
    Assert ($stale.text.Contains($expectedStale)) 'stale export prints the clear message' $stale.text
    Assert (-not $stale.wrote) 'stale export writes no output file'
    $stale = New-StaleCase 'missing' 5 0 $true
    Assert ($stale.code -ne 0 -and $stale.text.Contains($expectedStale)) 'old export without sourceEventCount prints the same message and exits non-zero' "exit=$($stale.code) $($stale.text)"
    $fresh = New-StaleCase 'fresh' 5 2 $false
    Assert ($fresh.code -eq 0 -and $fresh.wrote) 'fresh export (blank lines are not counted) is accepted' "exit=$($fresh.code) $($fresh.text)"

    # Two stale exports: one message lists both session ids, exits 2 and writes no output.
    $twoRoot = Join-Path $tmp 'stale-two'
    foreach ($name in @('sess-stale-a', 'sess-stale-b')) {
        $dir = Join-Path $twoRoot $name
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $v2Fixtures 'usage' 'sess-v2-usage' 'export.json') -Destination $dir
        Set-Content -LiteralPath (Join-Path $dir 'events.jsonl') -Value @(1..9 | ForEach-Object { '{"type":"synthetic.event","n":' + $_ + '}' })
    }
    $twoOut = Join-Path $tmp 'stale-two.json'
    $two = Invoke-Metrics @($twoRoot, '--out', $twoOut)
    Assert ($two.code -eq 2) 'two stale exports exit 2' "exit=$($two.code)"
    Assert ($two.text.Contains('sess-stale-a') -and $two.text.Contains('sess-stale-b')) 'two stale exports: the message lists both session ids' $two.text
    Assert ([regex]::Matches($two.text, 'export\.json is stale').Count -eq 1) 'two stale exports: the message is printed once' $two.text
    Assert (-not (Test-Path -LiteralPath $twoOut)) 'two stale exports write no output file'

    # Missing input directory is a usage error.
    $missing = Invoke-Metrics @((Join-Path $tmp 'does-not-exist'), '--out', (Join-Path $tmp 'x.json'))
    Assert ($missing.code -ne 0) 'missing input directory exits non-zero' "exit=$($missing.code)"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "`n$passed passed, $failures failed"
exit $failures
