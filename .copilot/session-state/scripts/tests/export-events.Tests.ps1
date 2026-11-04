<#
.SYNOPSIS
    Black-box tests for session-state/scripts/export-events.csx and analyze-events.csx (AC-17): requests, tokens and
    cost come from the per-request session.usage_record events plus compaction cost, never from summed
    session.shutdown modelMetrics. No Pester dependency.
    Run: pwsh -NoProfile -File export-events.Tests.ps1   (exit code = number of failures)
#>
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $PSScriptRoot
$exportCsx = Join-Path $scripts 'export-events.csx'
$analyzeCsx = Join-Path $scripts 'analyze-events.csx'
$fixtures = Join-Path $PSScriptRoot 'fixtures' 'export'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("export-events-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0

$opus = 'claude-opus-5.5'
$haiku = 'claude-haiku-5.5'
# Legacy keys that the fixtures fill (the exporter omits null values, so sessionStartTime, codeChanges, currentModel,
# currentTokens, systemTokens, conversationTokens and toolDefinitionsTokens are absent for these synthetic sessions).
$legacyExportKeys = @('sessionId', 'sessionStart', 'sessionEnd', 'durationMs', 'shutdownType', 'segmentCount', 'totalPremiumRequests',
    'totalApiDurationMs', 'cwd', 'copilotVersion', 'eventTypeCounts', 'graphStats', 'hookPairs', 'modelChanges', 'compactionEvents',
    'segments', 'modelMetrics', 'toolStats', 'errorCount', 'errors', 'subagentDispatches', 'timeline')
$newExportKeys = @('requests', 'hookWindows', 'costUsd', 'compactionCostUsd', 'sourceEventCount')
$requestKeys = @('timestamp', 'agentId', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'durationMs', 'totalNanoAiu', 'kind')
$hookWindowKeys = @('hookInvocationId', 'agentId', 'startTs', 'endTs', 'durationMs')

function Assert([bool] $cond, [string] $name, [string] $detail = '') {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name $detail" -ForegroundColor Red }
}

function Near($actual, [double] $expected) {
    return ($null -ne $actual) -and ([math]::Abs([double]$actual - $expected) -lt 1e-9)
}

# Prints the last 40 lines of a script's output when it exits non-zero, so a rare failure can be diagnosed.
function Show-ScriptOutputOnFailure([string] $label, [int] $code, $output) {
    if ($code -eq 0) { return }
    $lines = @(($output | Out-String) -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    Write-Host "--- $label exited $code; last 40 lines of its output:" -ForegroundColor Yellow
    $lines | Select-Object -Last 40 | ForEach-Object { Write-Host "    $_" }
}

function Get-Excerpt([string] $text, [string] $pattern) {
    return (@($text -split "`r?`n" | Where-Object { $_ -match $pattern }) | Select-Object -First 3) -join ' | '
}

function Invoke-Export([string] $fixtureName) {
    $outFile = Join-Path $tmp "$fixtureName.json"
    $output = & dotnet script $exportCsx (Join-Path $fixtures $fixtureName) --out $outFile 2>&1
    $code = $LASTEXITCODE
    Show-ScriptOutputOnFailure "export $fixtureName" $code $output
    $doc = if (Test-Path -LiteralPath $outFile) { Get-Content -Raw -LiteralPath $outFile | ConvertFrom-Json -DateKind String } else { $null }
    return [pscustomobject]@{ code = $code; doc = $doc }
}

function Get-LineCount([string] $fixtureName) {
    return @(Get-Content -LiteralPath (Join-Path $fixtures $fixtureName 'events.jsonl') | Where-Object { $_.Trim() -ne '' }).Count
}

try {
    # (1) two shutdowns with CUMULATIVE modelMetrics: counts and tokens equal the usage records, not the shutdown sum
    $r = Invoke-Export 'cumulative-shutdowns'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'cumulative: export runs and writes JSON' "exit=$($r.code)"
    $mm = $doc.modelMetrics
    Assert ($mm.$opus.requests -eq 2) 'cumulative: opus requests = number of opus usage records (2, not the shutdown sum 3)' "got=$($mm.$opus.requests)"
    Assert ($mm.$opus.inputTokens -eq 3000 -and $mm.$opus.outputTokens -eq 300) 'cumulative: opus input/output tokens are the record sums (3000/300, not 4000/400)' "got=$($mm.$opus.inputTokens)/$($mm.$opus.outputTokens)"
    Assert ($mm.$opus.cacheReadTokens -eq 2100 -and $mm.$opus.cacheWriteTokens -eq 700) 'cumulative: opus cache tokens are the record sums (2100/700)' "got=$($mm.$opus.cacheReadTokens)/$($mm.$opus.cacheWriteTokens)"
    Assert ($mm.$haiku.requests -eq 1 -and $mm.$haiku.inputTokens -eq 500) 'cumulative: haiku (sub-agent) request counted once' "got=$($mm.$haiku.requests)/$($mm.$haiku.inputTokens)"
    Assert ($doc.requests.Count -eq 3) 'cumulative: one per-request record per usage record' "count=$($doc.requests.Count)"
    Assert ($doc.segmentCount -eq 2) 'cumulative: segmentCount still counts the shutdowns' "got=$($doc.segmentCount)"
    # Cumulative shutdown counters (premium 3 then 6; API 2800 then 5800) must not be summed (9 and 8600).
    Assert (Near $doc.totalPremiumRequests 6) 'cumulative: totalPremiumRequests = sum of the record premium units (6), not the shutdown sum (9)' "got=$($doc.totalPremiumRequests)"
    Assert (Near $doc.totalApiDurationMs 5800) 'cumulative: totalApiDurationMs = sum of the record durations (5800), not the shutdown sum (8600)' "got=$($doc.totalApiDurationMs)"

    # (3) cost = sum(totalNanoAiu) / 1e11 per request; opus per-model cost
    Assert (Near $doc.costUsd 0.55) 'cumulative: costUsd = sum of record totalNanoAiu / 1e11' "got=$($doc.costUsd)"
    Assert (Near $doc.compactionCostUsd 0) 'cumulative: compactionCostUsd is 0 without compaction events' "got=$($doc.compactionCostUsd)"
    Assert (Near $mm.$opus.costUsd 0.5) 'cumulative: opus costUsd from its records' "got=$($mm.$opus.costUsd)"

    # (4) staleness marker
    Assert ($doc.sourceEventCount -eq (Get-LineCount 'cumulative-shutdowns')) 'cumulative: sourceEventCount equals the number of lines read' "got=$($doc.sourceEventCount)"

    # additive keys: every legacy key stays, the new keys are present
    $names = @($doc.PSObject.Properties.Name)
    $missing = @($legacyExportKeys | Where-Object { $names -notcontains $_ })
    Assert ($missing.Count -eq 0) 'cumulative: all legacy export.json keys are kept' ("missing=" + ($missing -join ','))
    $missingNew = @($newExportKeys | Where-Object { $names -notcontains $_ })
    Assert ($missingNew.Count -eq 0) 'cumulative: new keys requests/hookWindows/costUsd/compactionCostUsd/sourceEventCount exist' ("missing=" + ($missingNew -join ','))

    # (2) usage records after the last session.shutdown are included
    $r = Invoke-Export 'after-last-shutdown'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'after-shutdown: export runs and writes JSON' "exit=$($r.code)"
    Assert ($doc.modelMetrics.$opus.requests -eq 3) 'after-shutdown: requests after the last shutdown are included (3, shutdown total is 1)' "got=$($doc.modelMetrics.$opus.requests)"
    Assert ($doc.modelMetrics.$opus.inputTokens -eq 600) 'after-shutdown: tokens after the last shutdown are included (600)' "got=$($doc.modelMetrics.$opus.inputTokens)"
    Assert (Near $doc.costUsd 0.6) 'after-shutdown: costUsd includes the records after the last shutdown' "got=$($doc.costUsd)"
    Assert ($doc.sourceEventCount -eq (Get-LineCount 'after-last-shutdown')) 'after-shutdown: sourceEventCount equals the number of lines read' "got=$($doc.sourceEventCount)"

    # (3) compaction cost, (5) per-request records and kinds, (6) preToolUse hook windows
    $r = Invoke-Export 'kinds-hooks-compaction'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'kinds: export runs and writes JSON' "exit=$($r.code)"
    Assert (Near $doc.compactionCostUsd 0.5) 'kinds: compactionCostUsd from session.compaction_complete copilotUsage' "got=$($doc.compactionCostUsd)"
    Assert (Near $doc.costUsd 1.15) 'kinds: costUsd = records (0.65) + compaction (0.50)' "got=$($doc.costUsd)"
    Assert ($doc.sourceEventCount -eq (Get-LineCount 'kinds-hooks-compaction')) 'kinds: sourceEventCount equals the number of lines read' "got=$($doc.sourceEventCount)"
    $reqs = @($doc.requests)
    Assert ($reqs.Count -eq 4) 'kinds: four request records' "count=$($reqs.Count)"
    $first = $reqs[0]
    $keyDiff = @($first.PSObject.Properties.Name | Sort-Object) -join ','
    Assert ($keyDiff -ceq (($requestKeys | Sort-Object) -join ',')) 'kinds: a request record has exactly the contract keys' "keys=$keyDiff"
    Assert ($first.timestamp -ceq '2026-10-03T10:00:01.000Z' -and $first.model -ceq $opus -and $null -eq $first.agentId) 'kinds: root record has timestamp, model and agentId null' "ts=$($first.timestamp) model=$($first.model) agent=$($first.agentId)"
    Assert ($first.inputTokens -eq 100 -and $first.outputTokens -eq 10 -and $first.cacheReadTokens -eq 40 -and $first.cacheWriteTokens -eq 50) 'kinds: record tokens are copied (input already includes cache)' "got=$($first.inputTokens)/$($first.outputTokens)/$($first.cacheReadTokens)/$($first.cacheWriteTokens)"
    Assert ($first.durationMs -eq 1000 -and $first.totalNanoAiu -eq 10000000000) 'kinds: record duration (ms) and totalNanoAiu are copied' "got=$($first.durationMs)/$($first.totalNanoAiu)"
    Assert ($reqs[0].kind -ceq 'notice') 'kinds: root request without a preceding root user message is a notice' "got=$($reqs[0].kind)"
    Assert ($reqs[1].kind -ceq 'user') 'kinds: root request after a normal user message is user' "got=$($reqs[1].kind)"
    Assert ($reqs[2].agentId -ceq 'agent-7' -and $null -eq $reqs[2].kind) 'kinds: sub-agent request carries its agentId and no kind' "agent=$($reqs[2].agentId) kind=$($reqs[2].kind)"
    Assert ($reqs[3].kind -ceq 'keepalive') 'kinds: root request after a [keepalive] message is keepalive (a sub-agent prompt in between is ignored)' "got=$($reqs[3].kind)"
    Assert (@($doc.hookWindows).Count -eq 2) 'hooks: only paired preToolUse windows are exported (postToolUse and unpaired start excluded)' "count=$(@($doc.hookWindows).Count)"
    $w1 = $doc.hookWindows | Where-Object { $_.hookInvocationId -ceq 'h1' }
    $w2 = $doc.hookWindows | Where-Object { $_.hookInvocationId -ceq 'h2' }
    $wKeys = @($w1.PSObject.Properties.Name | Sort-Object) -join ','
    Assert ($wKeys -ceq (($hookWindowKeys | Sort-Object) -join ',')) 'hooks: a window has exactly the contract keys' "keys=$wKeys"
    Assert ($null -eq $w1.agentId -and (Near $w1.durationMs 250) -and $w1.startTs -ceq '2026-10-03T10:00:03.000Z' -and $w1.endTs -ceq '2026-10-03T10:00:03.250Z') 'hooks: root window start/end/duration' "got=$($w1.startTs)..$($w1.endTs) $($w1.durationMs) agent=$($w1.agentId)"
    Assert ($w2.agentId -ceq 'agent-7' -and (Near $w2.durationMs 100)) 'hooks: sub-agent window carries its agentId' "got=$($w2.agentId) $($w2.durationMs)"

    # sessions without usage records (older CLI) keep the shutdown-based aggregate
    $r = Invoke-Export 'legacy-no-usage-records'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'legacy: export runs and writes JSON' "exit=$($r.code)"
    Assert (@($doc.requests).Count -eq 0 -and $null -eq $doc.costUsd) 'legacy: no request records and costUsd null (unknown, not 0)' "count=$(@($doc.requests).Count) cost=$($doc.costUsd)"
    $legacyModels = @($doc.modelMetrics.PSObject.Properties.Value)
    $legacyKnownCosts = @($legacyModels | Where-Object { $null -ne $_.costUsd })
    Assert ($legacyModels.Count -gt 0 -and $legacyKnownCosts.Count -eq 0) 'legacy: no model has a costUsd (fallback has no USD per model)' "models=$($legacyModels.Count) withCost=$($legacyKnownCosts.Count)"
    Assert (Near $doc.totalPremiumRequests 3) 'legacy: totalPremiumRequests keeps the per-segment shutdown sum (2 + 1 = 3)' "got=$($doc.totalPremiumRequests)"
    Assert (Near $doc.totalApiDurationMs 3000) 'legacy: totalApiDurationMs keeps the per-segment shutdown sum (2000 + 1000 = 3000)' "got=$($doc.totalApiDurationMs)"
    Assert ($doc.modelMetrics.$opus.requests -eq 3 -and $doc.modelMetrics.$opus.inputTokens -eq 500) 'legacy: modelMetrics falls back to the per-segment shutdown sums' "got=$($doc.modelMetrics.$opus.requests)/$($doc.modelMetrics.$opus.inputTokens)"

    # sub-agent dispatches carry the agentId of their subagent.started envelope (links usage records to a dispatch)
    $r = Invoke-Export 'overlapping-subagents'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'overlap: export runs and writes JSON' "exit=$($r.code)"
    $dispatches = if ($null -ne $doc) { @($doc.subagentDispatches) } else { @() }
    Assert ($dispatches.Count -eq 2) 'overlap: two dispatches' "count=$($dispatches.Count)"
    $dispA = $dispatches | Where-Object { $_.callId -ceq 'call-A' }
    $dispB = $dispatches | Where-Object { $_.callId -ceq 'call-B' }
    Assert ($null -ne $dispA -and $dispA.agentId -ceq 'agent-A' -and $dispA.agentName -ceq 'sub-explorer-code') 'overlap: dispatch call-A carries agentId agent-A' "got=$($dispA.agentId)"
    Assert ($null -ne $dispB -and $dispB.agentId -ceq 'agent-B' -and $dispB.agentName -ceq 'sub-expert-ado') 'overlap: dispatch call-B carries agentId agent-B' "got=$($dispB.agentId)"
    $reqAgents = if ($null -ne $doc) { (@($doc.requests) | ForEach-Object { $_.agentId }) -join ',' } else { '' }
    Assert ($reqAgents -ceq 'agent-B,agent-A') 'overlap: request agentIds are the same ids as the dispatches' "got=$reqAgents"

    # (7) analyze-events reports the same request counts and cost
    $analyzeOutput = & dotnet script $analyzeCsx (Join-Path $fixtures 'cumulative-shutdowns') 2>&1
    $text = ($analyzeOutput | Out-String)
    Show-ScriptOutputOnFailure 'analyze cumulative' $LASTEXITCODE $analyzeOutput
    Assert ($LASTEXITCODE -eq 0) 'analyze: runs on the cumulative fixture' "exit=$LASTEXITCODE"
    Assert ($text -match 'Total premium reqs\s*:\s*6\b') 'analyze: total premium reqs is the record sum (6), not the shutdown sum (9)' (Get-Excerpt $text 'Total premium')
    Assert ($text -match 'Total API duration\s*:\s*5800ms') 'analyze: total API duration is the record sum (5800), not the shutdown sum (8600)' (Get-Excerpt $text 'Total API')
    Assert ($text -match 'claude-opus-5\.5\s+2\s') 'analyze: opus request count is 2 (the usage records), not 3' ($text -replace "`r?`n", ' | ')
    # The model column is cut at 80 columns when the output is redirected, so match the prefix only.
    Assert ($text -match 'claude-haiku-5\S*\s+1\s') 'analyze: haiku request count is 1' ($text -replace "`r?`n", ' | ')
    Assert ($text -match '\$0\.55') 'analyze: total cost $0.55 from the records' ($text -replace "`r?`n", ' | ')

    # analyze on a legacy session (no usage records): the premium column is labelled as premium units, and the USD total is n/a
    $legacyAnalyzeOutput = & dotnet script $analyzeCsx (Join-Path $fixtures 'legacy-no-usage-records') 2>&1
    $legacyText = ($legacyAnalyzeOutput | Out-String)
    Show-ScriptOutputOnFailure 'analyze legacy' $LASTEXITCODE $legacyAnalyzeOutput
    Assert ($legacyText -match 'Premium units') 'analyze legacy: the model table column is labelled Premium units' (Get-Excerpt $legacyText 'Reqs|Premium')
    Assert ($legacyText -cnotmatch '\bCost\b') 'analyze legacy: no column is labelled Cost' (Get-Excerpt $legacyText 'Cost')
    Assert ($legacyText -match 'Total cost\s*:\s*n/a') 'analyze legacy: total cost is n/a, not 0, without usage records' (Get-Excerpt $legacyText 'Total cost')

    # (8) premium units = user-initiated records only (T27). Fixture: opus user 2.0, opus agent 3.0, haiku sub-agent 4.0,
    # haiku user 0.5, haiku without initiator 0.25 (unknown kept). Premium = 2.0 + 0.5 + 0.25; requests, API time and USD count all five.
    $r = Invoke-Export 'premium-initiator'
    $doc = $r.doc
    Assert ($r.code -eq 0 -and $null -ne $doc) 'initiator: export runs and writes JSON' "exit=$($r.code)"
    Assert (Near $doc.totalPremiumRequests 2.75) 'initiator: totalPremiumRequests = user and missing-initiator units only (2.0 + 0.5 + 0.25 = 2.75)' "got=$($doc.totalPremiumRequests)"
    Assert (Near $doc.modelMetrics.$opus.cost 2.0) 'initiator: opus cost = its user record only (2.0; the agent record 3.0 is excluded)' "got=$($doc.modelMetrics.$opus.cost)"
    Assert (Near $doc.modelMetrics.$haiku.cost 0.75) 'initiator: haiku cost = user and missing records (0.75; the sub-agent record 4.0 is excluded)' "got=$($doc.modelMetrics.$haiku.cost)"
    Assert ($doc.modelMetrics.$opus.requests -eq 2 -and $doc.modelMetrics.$haiku.requests -eq 3) 'initiator: request counts still include every record (opus 2, haiku 3)' "got=$($doc.modelMetrics.$opus.requests)/$($doc.modelMetrics.$haiku.requests)"
    Assert (@($doc.requests).Count -eq 5) 'initiator: all five records are request records' "count=$(@($doc.requests).Count)"
    Assert (Near $doc.totalApiDurationMs 3850) 'initiator: totalApiDurationMs still sums all records (3850)' "got=$($doc.totalApiDurationMs)"
    Assert (Near $doc.costUsd 0.975) 'initiator: costUsd still sums all records totalNanoAiu (0.975 USD)' "got=$($doc.costUsd)"
    # The shutdown event (cumulative premium 99, API 99999 ms) must not change the record totals.
    Assert (Near $doc.totalPremiumRequests 2.75) 'initiator: a shutdown with premium 99 does not replace the record total' "got=$($doc.totalPremiumRequests)"
    $premiumAnalyzeOutput = & dotnet script $analyzeCsx (Join-Path $fixtures 'premium-initiator') 2>&1
    $premiumAnalyzeText = ($premiumAnalyzeOutput | Out-String)
    Show-ScriptOutputOnFailure 'analyze premium-initiator' $LASTEXITCODE $premiumAnalyzeOutput
    Assert ($premiumAnalyzeText -match 'Total premium reqs\s*:\s*2\.75\b') 'analyze: total premium reqs = user and missing-initiator units (2.75), not the shutdown 99' (Get-Excerpt $premiumAnalyzeText 'Total premium')
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ("`n{0} passed, {1} failed" -f $passed, $failures)
exit $failures
