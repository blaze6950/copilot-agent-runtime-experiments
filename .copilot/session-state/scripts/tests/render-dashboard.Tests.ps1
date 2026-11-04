<#
.SYNOPSIS
    Black-box tests for render-dashboard.csx (no Pester dependency).
    Run: pwsh -NoProfile -File render-dashboard.Tests.ps1   (exit code = number of failures)
#>
$ErrorActionPreference = 'Stop'
$csx = Join-Path $PSScriptRoot '..\render-dashboard.csx'
$fixtures = Join-Path $PSScriptRoot 'fixtures\dashboard'
$metrics = Join-Path $fixtures 'metrics.json'
$pricing = Join-Path $fixtures 'pricing.json'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("render-dashboard-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0

# Runs the csx with the given arguments; returns exit code, stdout+stderr text and the output file text (if any).
function Invoke-Dashboard([string[]] $arguments, [string] $outName = ([guid]::NewGuid().ToString('N') + '.html'), [string] $metricsPath = $metrics) {
    $out = Join-Path $tmp $outName
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = (& dotnet script $csx $metricsPath --out $out @arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
    } finally {
        $ErrorActionPreference = $prev
    }
    $code = $LASTEXITCODE
    $html = if (Test-Path -LiteralPath $out) { [System.IO.File]::ReadAllText($out) } else { '' }
    return [pscustomobject]@{ code = $code; text = $text; html = $html; out = $out }
}
function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}
function Count-Svg([string] $html) { ([regex]::Matches($html, '<svg')).Count }

try {
    # 1. Full run: exit 0, one inline SVG per series, focus-vs-baseline section, self-contained.
    $full = Invoke-Dashboard @('--pricing', $pricing, '--from', '2026-09-07', '--to', '2026-10-11', '--group', 'all', '--focus', 's04') 'full.html'
    Assert ($full.code -eq 0) "full run exits 0 (got $($full.code); $($full.text))"
    Assert ((Count-Svg $full.html) -eq 7) "full run contains exactly 7 <svg charts (got $(Count-Svg $full.html))"
    foreach ($title in @('Cost per bucket (USD)', 'Cache read ratio', 'Compactions per session', 'Dispatch failure rate', 'Repeat-dispatch rate', 'Errors per session', 'User turns per session')) {
        Assert ($full.html.Contains($title)) "full run has chart titled '$title'"
    }
    Assert ($full.html.Contains('Focus vs baseline')) "full run has 'Focus vs baseline' section"
    $focusIdx = $full.html.IndexOf('Focus vs baseline')
    $focusPart = if ($focusIdx -ge 0) { $full.html.Substring($focusIdx) } else { '' }
    if ($focusPart.Length -gt 20) {
        $nextH2 = $focusPart.IndexOf('<h2', 20)
        if ($nextH2 -gt 0) { $focusPart = $focusPart.Substring(0, $nextH2) }
    }
    # Focus s04 user turns = 20. Baseline (11 sessions in window minus s04, 10 non-null user turns):
    # sorted 5,6,7,8,9,10,11,12,14,15 -> median 9.5, p25 (type 7) 7.25, p75 (type 7) 11.75.
    Assert ($focusPart -match '(?<![\d.])20(?![\d.])') "focus section shows focus user turns 20"
    Assert ($focusPart -match '9\.5') "focus section shows baseline median 9.5"
    Assert ($focusPart -match '7\.25') "focus section shows baseline p25 7.25"
    Assert ($focusPart -match '11\.75') "focus section shows baseline p75 11.75"
    Assert (($focusPart -match 'p25') -and ($focusPart -match 'p75') -and ($focusPart -match 'median')) "focus section names median/p25/p75"
    Assert ($full.html.Length -gt 0) "full run writes the HTML file"
    Assert (-not ($full.html -match 'https?://')) "full run has no http:// or https:// references"
    Assert (-not ($full.html -match '(?i)<script')) "full run has no <script> element"
    Assert (-not ($full.html -match '(?i)<link')) "full run has no <link> element"
    Assert (-not ($full.html -match '(?i)<img')) "full run has no external <img>"
    Assert ($full.html.Contains('Sessions: 12')) "full run header reports Sessions: 12"
    Assert ($full.html.Contains('model-unpriced')) "full run notes the unpriced model"
    Assert ($full.html.Contains('fixture: synthetic prices')) "full run header shows pricing source"

    # 2. Group by cwd: only alpha sessions (7 of 12) are counted.
    $grp = Invoke-Dashboard @('--pricing', $pricing, '--from', '2026-09-07', '--to', '2026-10-11', '--group', 'cwd:C:\repos\alpha') 'group.html'
    Assert ($grp.code -eq 0) "cwd group run exits 0 (got $($grp.code); $($grp.text))"
    Assert ($grp.html.Contains('Sessions: 7')) "cwd group counts only the 7 alpha sessions"
    Assert (-not $grp.html.Contains('Sessions: 12')) "cwd group does not report all 12 sessions"

    # 3. No pricing: cost series replaced by total tokens, still 7 charts.
    $nop = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-10-11', '--group', 'all') 'nopricing.html'
    Assert ($nop.code -eq 0) "no-pricing run exits 0 (got $($nop.code); $($nop.text))"
    Assert ($nop.html.Contains('Total tokens per bucket')) "no-pricing run shows total tokens series"
    Assert (-not $nop.html.Contains('Cost per bucket')) "no-pricing run has no cost series"
    Assert ((Count-Svg $nop.html) -eq 7) "no-pricing run still has 7 <svg charts (got $(Count-Svg $nop.html))"

    # 3b. Sessions without model data (models: []) are n/a, never 0: a bucket with only such sessions shows n/a,
    # a mixed bucket sums only the sessions with data, the focus-vs-baseline statistics skip them, and the
    # header/notes count them. Fixture: 4 sessions; nm02, nm03 (09-08) and nm04 (09-07) have no model data.
    $nm = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-09-08', '--group', 'all', '--focus', 'nm02') 'nomodels.html' (Join-Path $fixtures 'metrics-nomodels.json')
    Assert ($nm.code -eq 0) "no-model-data run exits 0 (got $($nm.code); $($nm.text))"
    Assert ($nm.html.Contains('2026-09-07: 1,100</title>')) "mixed bucket total is the sum of the session with data only (1,100)"
    $tokFig = [regex]::Match($nm.html, '(?s)<figure[^>]*><figcaption>Total tokens per bucket</figcaption>.*?</figure>').Value
    Assert ($tokFig.Contains('2026-09-08: n/a</title>')) "Total tokens chart: bucket with only no-model sessions shows n/a"
    Assert (-not $tokFig.Contains('2026-09-08: 0</title>')) "Total tokens chart: bucket with only no-model sessions does not show 0"
    Assert ($nm.html.Contains('3 of 4 session(s) in the window have no model data')) "header/notes state how many sessions have no model data (3 of 4)"
    Assert ($nm.html -match 'Total tokens</td><td>n/a</td><td>1,100</td><td>1,100</td><td>1,100</td><td>1</td>') "focus without model data shows n/a; baseline stats use only the non-null session (n=1)"

    # 3c. v1 files keep the price-table cost (AC-18: fallback only for v1).
    $v1Cost = [regex]::Match($full.html, '(?s)<figure[^>]*><figcaption>Cost per bucket \(USD\)</figcaption>.*?</figure>').Value
    Assert ($v1Cost -match '2026-09-07: \$\d+\.\d\d</title>') "v1 file with --pricing keeps the price-table cost series"
    Assert (-not $full.html.Contains('Keep-alive and hook latency')) "v1 file has no keep-alive and hook latency section"

    # 3c2. Cache counted once (T22-fix1): inputTokens already includes cache read and cache write.
    # Fixture metrics-cache.json: model-a, one session on 2026-09-07: input 1,000,000 (cache read 600,000,
    # cache write 200,000), output 100,000. Total tokens = input + output = 1,100,000.
    # v1 cost (pricing.json model-a: input 3.00, output 15.00, cacheRead 0.30, cacheWrite 3.75 USD per M):
    # uncached input 200,000 x 3.00 + output 100,000 x 15.00 + cacheRead 600,000 x 0.30 + cacheWrite 200,000 x 3.75
    # = $3.03. Counting the cache a second time at the input rate would give $5.43.
    $cacheFixture = Join-Path $fixtures 'metrics-cache.json'
    $cacheTok = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-09-08', '--group', 'all') 'cache-tokens.html' $cacheFixture
    Assert ($cacheTok.code -eq 0) "cache fixture without pricing exits 0 (got $($cacheTok.code); $($cacheTok.text))"
    Assert ($cacheTok.html.Contains('2026-09-07: 1,100,000</title>')) "total tokens count the cache inside input once (input + output = 1,100,000)"
    $cacheCost = Invoke-Dashboard @('--pricing', $pricing, '--from', '2026-09-07', '--to', '2026-09-08', '--group', 'all') 'cache-cost.html' $cacheFixture
    Assert ($cacheCost.code -eq 0) "cache fixture with pricing exits 0 (got $($cacheCost.code); $($cacheCost.text))"
    $cacheCostFig = [regex]::Match($cacheCost.html, '(?s)<figure[^>]*><figcaption>Cost per bucket \(USD\)</figcaption>.*?</figure>').Value
    Assert ($cacheCostFig.Contains('2026-09-07: $3.03</title>')) "v1 cost bills uncached input once, plus cache read and cache write (`$3.03, not `$5.43)"

    # 3d. Schema v2 (AC-18): cost comes from the v2 cost fields; no price table is needed or used.
    # Fixture: v2-a 09-07 costUsd 1.25 (incl. compaction 0.25), v2-b 09-07 costUsd 0.75, v2-c 09-08 costUsd null.
    # Keep-alive: pings 2+1=3 over 2 sessions, cost 0.40+0.10=0.50, chains 1+1=2, wasted 1+0=1.
    # Hook windows: count 10+4=14, total 5000+2000 ms, p50 median(400,300)=350 ms, p90 median(900,700)=800 ms.
    $v2Path = Join-Path $fixtures 'metrics-v2.json'
    $v2 = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-09-08', '--group', 'all') 'v2-nopricing.html' $v2Path
    Assert ($v2.code -eq 0) "v2 run without pricing exits 0 (got $($v2.code); $($v2.text))"
    Assert ((Count-Svg $v2.html) -eq 7) "v2 run has 7 <svg charts (got $(Count-Svg $v2.html))"
    Assert ($v2.html.Contains('Cost source: schema v2 cost fields')) "v2 header names the v2 cost source"
    Assert (-not $v2.html.Contains('Total tokens per bucket')) "v2 run without pricing shows the cost series, not total tokens"
    $v2CostFig = [regex]::Match($v2.html, '(?s)<figure[^>]*><figcaption>Cost per bucket \(USD\)</figcaption>.*?</figure>').Value
    Assert ($v2CostFig.Contains('2026-09-07: $2.00</title>')) "v2 cost chart sums session costUsd per bucket (1.25 + 0.75 = 2.00)"
    Assert ($v2CostFig.Contains('2026-09-08: n/a</title>')) "v2 cost chart: null costUsd is n/a"

    $v2p = Invoke-Dashboard @('--pricing', $pricing, '--from', '2026-09-07', '--to', '2026-09-08') 'v2-pricing.html' $v2Path
    Assert ($v2p.code -eq 0) "v2 run with --pricing exits 0 (got $($v2p.code); $($v2p.text))"
    $v2pCostFig = [regex]::Match($v2p.html, '(?s)<figure[^>]*><figcaption>Cost per bucket \(USD\)</figcaption>.*?</figure>').Value
    Assert ($v2pCostFig.Contains('2026-09-07: $2.00</title>')) "v2 cost ignores --pricing: bucket stays 2.00"
    Assert ($v2pCostFig.Contains('2026-09-08: n/a</title>')) "v2 cost does not fall back to the price table for null costUsd (model-a is priced)"
    Assert ($v2p.html.Contains('--pricing is ignored')) "v2 run with --pricing notes that the price table is ignored"

    $v2Ka = [regex]::Match($v2.html, '(?s)<h2>Keep-alive and hook latency</h2>.*?</table>').Value
    Assert ($v2Ka.Length -gt 0) "v2 run has a 'Keep-alive and hook latency' section"
    Assert ($v2Ka -match 'Keep-alive pings</td><td>3</td><td>2</td>') "keep-alive pings sum to 3 over 2 sessions with data"
    Assert ($v2Ka -match 'Keep-alive cost</td><td>\$0\.50</td><td>2</td>') "keep-alive cost sums to `$0.50"
    Assert ($v2Ka -match 'Wasted chain share</td><td>50\.0%</td>') "wasted chain share is pooled: 1 of 2 chains"
    Assert ($v2Ka -match 'Hook windows</td><td>14</td>') "hook windows sum to 14"
    Assert ($v2Ka -match 'Hook latency total</td><td>7\.0 s</td>') "hook latency total sums to 7.0 s"
    Assert ($v2Ka -match 'Hook p50, median of sessions</td><td>350 ms</td>') "hook p50 is the median of the session p50 values (350 ms)"
    Assert ($v2Ka -match 'Hook p90, median of sessions</td><td>800 ms</td>') "hook p90 is the median of the session p90 values (800 ms)"

    # 3e. Schema v2 with unknown cost (costUsd null, e.g. no per-request records): n/a, never $0.00, never a
    # price-table value, even with --pricing. Fixture: v2n-1 (09-07, models with costUsd null, keep-alive pings 2
    # with cost null), v2n-2 (09-07, models, no keep-alive), v2n-3 (09-08, no models).
    $v2nPath = Join-Path $fixtures 'metrics-v2-nullcost.json'
    $v2n = Invoke-Dashboard @('--pricing', $pricing, '--from', '2026-09-07', '--to', '2026-09-08', '--group', 'all', '--focus', 'v2n-1') 'v2-nullcost.html' $v2nPath
    Assert ($v2n.code -eq 0) "v2 null-cost run exits 0 (got $($v2n.code); $($v2n.text))"
    $v2nCostFig = [regex]::Match($v2n.html, '(?s)<figure[^>]*><figcaption>Cost per bucket \(USD\)</figcaption>.*?</figure>').Value
    Assert ($v2nCostFig.Contains('2026-09-07: n/a</title>') -and $v2nCostFig.Contains('2026-09-08: n/a</title>')) "v2 null cost: both cost buckets are n/a"
    Assert (-not ($v2nCostFig -match '\$\d')) "v2 null cost: the cost chart shows no dollar figure (no tick, no price-table value)"
    Assert (-not $v2n.html.Contains('$0.00')) 'v2 null cost: $0.00 appears nowhere on the page'
    Assert ($v2n.html.Contains('3 of 3 session(s) in the window have no cost (schema v2 costUsd is null)')) "v2 cost note counts the sessions whose costUsd is null (3 of 3)"
    Assert ($v2n.html.Contains('1 of 3 session(s) in the window have no model data; their token values are n/a')) "v2 model-data note names token values, not cost (1 of 3)"
    $v2nKa = [regex]::Match($v2n.html, '(?s)<h2>Keep-alive and hook latency</h2>.*?</table>').Value
    Assert ($v2nKa -match 'Keep-alive cost</td><td>n/a</td><td>0</td>') "v2 null keep-alive cost shows n/a with n 0"
    Assert ($v2nKa -match 'Keep-alive pings</td><td>2</td><td>1</td>') "keep-alive pings are still summed when only the cost is unknown"
    Assert ($v2n.html.Contains('Cost (USD)</td><td>n/a</td><td>n/a</td><td>n/a</td><td>n/a</td><td>0</td>')) "focus cost row is n/a with no baseline cost data"

    # 4. Empty window: exit 0, explicit message, no charts.
    $empty = Invoke-Dashboard @('--pricing', $pricing, '--from', '2025-01-01', '--to', '2025-01-31') 'empty.html'
    Assert ($empty.code -eq 0) "empty window exits 0 (got $($empty.code); $($empty.text))"
    Assert ($empty.html.Contains('No sessions in window')) "empty window shows 'No sessions in window'"
    Assert ((Count-Svg $empty.html) -eq 0) "empty window renders no <svg charts"

    # 5. Bucketing: daily for windows <= 45 days, ISO weeks otherwise.
    $daily = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-10-11') 'daily.html'
    Assert ($daily.html.Contains('<title>2026-09-09')) "35-day window buckets per day"
    Assert (-not $daily.html.Contains('week of')) "35-day window has no weekly labels"
    $weekly = Invoke-Dashboard @('--from', '2026-08-01', '--to', '2026-10-31') 'weekly.html'
    Assert ($weekly.code -eq 0) "91-day window exits 0 (got $($weekly.code); $($weekly.text))"
    Assert ($weekly.html.Contains('week of 2026-09-07')) "91-day window buckets per ISO week (Monday start)"

    # 6. HTML encoding of data values (cwd containing markup and ampersand).
    $raw = [System.IO.File]::ReadAllText($metrics)
    $hostile = $raw.Replace('C:\\repos\\alpha', 'C:\\<i>&x\\alpha')
    $hostilePath = Join-Path $tmp 'hostile-metrics.json'
    [System.IO.File]::WriteAllText($hostilePath, $hostile)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $enc = (& dotnet script $csx $hostilePath --out (Join-Path $tmp 'enc.html') --group 'cwd:C:\<i>&x\alpha' 2>&1 | ForEach-Object { "$_" }) -join "`n"
    } finally { $ErrorActionPreference = $prev }
    $encCode = $LASTEXITCODE
    $encHtml = if (Test-Path -LiteralPath (Join-Path $tmp 'enc.html')) { [System.IO.File]::ReadAllText((Join-Path $tmp 'enc.html')) } else { '' }
    Assert ($encCode -eq 0) "hostile cwd run exits 0 (got $encCode; $enc)"
    Assert ($encHtml.Contains('&lt;i&gt;&amp;x')) "hostile cwd is HTML-encoded in output"
    Assert (-not $encHtml.Contains('<i>')) "hostile cwd markup is not emitted raw"
    Assert ($encHtml.Contains('Sessions: 7')) "hostile cwd group still matches its 7 sessions"

    # 7. Usage and lookup errors.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $noOut = (& dotnet script $csx $metrics 2>&1 | ForEach-Object { "$_" }) -join "`n"
        $noOutCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    Assert ($noOutCode -eq 2) "missing --out exits 2 (got $noOutCode)"
    $nofocus = Invoke-Dashboard @('--from', '2026-09-07', '--to', '2026-10-11', '--focus', 'nope') 'nofocus.html'
    Assert ($nofocus.code -eq 0) "unknown focus session exits 0 (got $($nofocus.code))"
    Assert ($nofocus.html.Contains('was not found')) "unknown focus session reports 'was not found'"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$passed passed, $failures failed"
exit $failures
