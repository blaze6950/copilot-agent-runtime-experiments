<#
.SYNOPSIS
    Self-contained tests for plan-check.ps1 (no Pester dependency).
    Run: pwsh -NoProfile -File plan-check.Tests.ps1   (exit code = number of failures)
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'plan-check.ps1'
$valid = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixtures/valid-plan.md')) -replace "`r`n", "`n"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("plan-check-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0

function Invoke-Check([string] $planText, [string[]] $extra = @()) {
    $p = Join-Path $tmp ([guid]::NewGuid().ToString('N') + '.md')
    [System.IO.File]::WriteAllText($p, $planText)
    $out = & pwsh -NoProfile -File $script -PlanPath $p @extra 2>&1
    $code = $LASTEXITCODE
    $json = $null
    try { $json = (($out -join "`n") | ConvertFrom-Json) } catch { $json = $null }
    return [pscustomobject]@{ code = $code; json = $json; path = $p }
}
function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

try {
    # 1. valid plan
    $r = Invoke-Check $valid
    Assert ($r.code -eq 0 -and $r.json.ok) 'valid plan passes'
    Assert ($r.json.revision -eq 2 -and $r.json.status -eq 'APPROVED') 'header fields parsed'
    Assert ((@($r.json.waves[0]) -join ',') -eq 'T1,T3' -and (@($r.json.waves[1]) -join ',') -eq 'T2') 'waves computed from dependencies'
    Assert (($r.json.tasks | Where-Object id -eq 'T2').model -eq 'claude-sonnet-5.5') 'per-task model override parsed'
    Assert (($r.json.tasks | Where-Object id -eq 'T1').model -eq 'default') 'model defaults to default'
    Assert (($r.json.tasks | Where-Object id -eq 'T3').review -eq 'per-task') 'review mode parsed'
    Assert (@($r.json.tasks).Count -eq 3) 'working memory section ignored'
    Assert (@($r.json.conflicts).Count -eq 0) 'dependency-ordered shared ownership allowed'

    # 1b. CRLF input parses identically
    $r2 = Invoke-Check ($valid -replace "`n", "`r`n")
    Assert ($r2.code -eq 0 -and $r2.json.requirementsHash -eq $r.json.requirementsHash) 'CRLF and LF produce same hashes'

    # 2. snapshot + volatile edits are not drift
    $snap = Join-Path $tmp 'snap.json'
    $null = Invoke-Check $valid @('-SnapshotOut', $snap)
    Assert (Test-Path $snap) 'snapshot written'
    $volatile = $valid.Replace('**Status:** APPROVED', '**Status:** IMPLEMENTING').Replace('wave noise', 'different noise').Replace('- r1 initial', "- r1 initial`n- r2 x")
    $r = Invoke-Check $volatile @('-Compare', $snap, '-FailOnDrift')
    Assert (-not $r.json.drift.requirementsChanged -and $r.code -eq 0) 'status/graph/history edits are not drift'
    Assert (@($r.json.drift.affectedTasks).Count -eq 0) 'no affected tasks without drift'

    # 3. task edit -> affected + downstream
    $r = Invoke-Check ($valid.Replace('`dotnet test --filter Greeter`', '`dotnet test --filter GreeterV2`')) @('-Compare', $snap, '-FailOnDrift')
    Assert ($r.json.drift.requirementsChanged) 'task edit detected as drift'
    Assert ((@($r.json.drift.affectedTasks) -join ',') -eq 'T1') 'changed task reported as affected'
    Assert ((@($r.json.drift.downstreamTasks) -join ',') -eq 'T2') 'dependent task reported downstream'
    Assert ($r.code -eq 1) '-FailOnDrift exits 1 on drift'

    # 4. AC edit -> tasks referencing it
    $r = Invoke-Check ($valid.Replace('CLI prints greeting.', 'CLI prints greeting in uppercase.')) @('-Compare', $snap)
    Assert ((@($r.json.drift.changedAcceptance) -join ',') -eq 'AC-2') 'changed AC detected'
    Assert ((@($r.json.drift.affectedTasks) -join ',') -eq 'T2,T3') 'tasks referencing changed AC affected'

    # 5. scope edit
    $r = Invoke-Check ($valid.Replace('In: greeter. Out: UI.', 'In: greeter and UI.')) @('-Compare', $snap)
    Assert ($r.json.drift.scopeChanged) 'scope change flagged'

    # 6. removed task
    $r = Invoke-Check ($valid -replace '(?s)### T3: Docs.*?- \*\*Review:\*\* per-task\n', '') @('-Compare', $snap)
    Assert ((@($r.json.drift.removedTasks) -join ',') -eq 'T3') 'removed task detected'

    # 7. ownership conflict between unordered tasks
    $r = Invoke-Check ($valid.Replace('- **Owns:** `README.md`', '- **Owns:** `README.md`, `src/Greeter.cs`'))
    Assert ($r.code -eq 1 -and @($r.json.conflicts).Count -eq 2) 'ownership conflicts with every unordered owner rejected (T1/T3, T2/T3)'
    Assert ((@($r.json.conflicts[0].tasks) -join ',') -eq 'T1,T3') 'conflict names the tasks'

    # 8. cycle
    $r = Invoke-Check ($valid.Replace("### T1: Greeter core`n- **Depends on:** none", "### T1: Greeter core`n- **Depends on:** T2"))
    Assert ($r.code -eq 1 -and @(@($r.json.errors) -match 'cycle').Count -gt 0) 'dependency cycle rejected'

    # 9. unknown dep, unknown AC, missing Verify
    $bad = $valid.Replace('- **Depends on:** T1', '- **Depends on:** T9').Replace('- **Acceptance:** AC-1', '- **Acceptance:** AC-7').Replace('- **Verify:** `dotnet test --filter Cli`', '')
    $r = Invoke-Check $bad
    $e = @($r.json.errors) -join "`n"
    Assert ($e -match 'unknown task T9') 'unknown dependency rejected'
    Assert ($e -match 'unknown acceptance criterion AC-7') 'unknown AC rejected'
    Assert ($e -match 'T2: missing .*Verify') 'missing Verify rejected'

    # 10. unresolved decisions listed
    $r = Invoke-Check ($valid.Replace("## Unresolved Decisions`n- none", "## Unresolved Decisions`n- Which logging library?`n- [x] Resolved one"))
    Assert ((@($r.json.unresolvedDecisions) -join '|') -eq 'Which logging library?') 'open decisions listed, checked ones ignored'

    # 10b. template hint comments in header are ignored
    $r = Invoke-Check ($valid.Replace('**Status:** APPROVED', '**Status:** DRAFT   <!-- DRAFT | IMPLEMENTING -->'))
    Assert ($r.json.status -eq 'DRAFT') 'HTML comment stripped from header value'

    # 12. workspace + target branch
    $r = Invoke-Check $valid
    Assert ($r.json.targetBranch -eq 'feature/greeting') 'target branch parsed'
    Assert ((($r.json.tasks | ForEach-Object workspace) -join ',') -eq 'worktree,main,worktree') 'workspace parsed per task'
    $r = Invoke-Check ($valid.Replace('- **Workspace:** main', '- **Workspace:** somewhere'))
    Assert ($r.code -eq 1 -and (@($r.json.errors) -join "`n") -match "T2: '\*\*Workspace:\*\*' must be") 'invalid workspace rejected'
    $r = Invoke-Check ($valid.Replace("- **Workspace:** main`n", ''))
    Assert ((@($r.json.errors) -join "`n") -match 'T2: missing .*Workspace') 'missing workspace rejected'
    $r = Invoke-Check ($valid.Replace("**Target branch:** feature/greeting`n", ''))
    Assert ((@($r.json.errors) -join "`n") -match 'Target branch') 'missing target branch rejected'

    # 13. wildcard ownership
    $wild = $valid.Replace('- **Owns:** `README.md`', '- **Owns:** `**`')
    $r = Invoke-Check $wild
    Assert ($r.code -eq 1 -and @($r.json.conflicts).Count -eq 2) 'solution-wide owner conflicts with every unordered task'
    $r = Invoke-Check ($wild.Replace("### T3: Docs`n- **Depends on:** none", "### T3: Docs`n- **Depends on:** T2"))
    Assert ($r.code -eq 0 -and @($r.json.conflicts).Count -eq 0) 'solution-wide owner allowed when ordered after all overlapping tasks'
    $r = Invoke-Check ($valid.Replace('- **Owns:** `README.md`', '- **Owns:** `src/*.cs`'))
    Assert (@($r.json.conflicts).Count -eq 2) 'glob matches literal paths of unordered tasks'
    $r = Invoke-Check ($valid.Replace('- **Owns:** `README.md`', '- **Owns:** `docs/**`'))
    Assert ($r.code -eq 0) 'disjoint glob does not conflict'

    # 14. Method field (AC-1)
    $r = Invoke-Check ($valid -replace '(?s)(### T2:.*?)- \*\*Method:\*\* tdd\n', '$1')
    Assert ($r.code -eq 1 -and ((@($r.json.errors) -join "`n") -match 'T2: missing .*Method')) 'task without Method rejected and named'
    $r = Invoke-Check ($valid -replace '(?s)(### T2:.*?- \*\*Method:\*\* )tdd', '${1}banana')
    Assert ($r.code -eq 1 -and ((@($r.json.errors) -join "`n") -match "T2: .*Method.*banana")) 'invalid Method value rejected and named'
    foreach ($m in 'tdd', 'refactor', 'mechanical', 'git-ops', 'verify') {
        $r = Invoke-Check ($valid -replace '(?s)(### T2:.*?- \*\*Method:\*\* )tdd', ('${1}' + $m))
        Assert ($r.code -eq 0 -and $r.json.ok -and ($r.json.tasks | Where-Object id -eq 'T2').method -eq $m) "Method '$m' accepted and emitted in task JSON"
    }
    $r = Invoke-Check ($valid -replace '(?s)(### T2:.*?- \*\*Method:\*\* )tdd', '${1}TDD')
    Assert ($r.code -eq 0 -and $r.json.ok) 'Method value is case-insensitive'

    # 15. task list edge cases (AC-1)
    $noTasks = $valid -replace '(?s)## Tasks\n.*?(?=## Execution Graph)', "## Tasks`nnone yet.`n`n"
    $r = Invoke-Check $noTasks
    Assert ($null -ne $r.json) 'no task headings: stdout parses as JSON'
    Assert ($r.code -eq 1 -and ((@($r.json.errors) -join "`n") -match 'no tasks found')) "no task headings: exit 1 with 'no tasks found'"
    $emptyTasks = $valid -replace '(?s)## Tasks\n.*?(?=## Execution Graph)', "## Tasks`n`n"
    $r = Invoke-Check $emptyTasks
    Assert ($null -ne $r.json -and $r.code -eq 1 -and ((@($r.json.errors) -join "`n") -match 'no tasks found')) "empty ## Tasks section: exit 1 with JSON 'no tasks found'"
    $noSection = $valid -replace '(?s)## Tasks\n.*?(?=## Execution Graph)', ''
    $r = Invoke-Check $noSection
    Assert ($null -ne $r.json -and $r.code -eq 1 -and ((@($r.json.errors) -join "`n") -match "section '## Tasks' missing")) "plan without ## Tasks: exit 1 with JSON error"

    # 11. parse failure
    $r = Invoke-Check "# Working Memory`nnothing"
    Assert ($r.code -eq 2 -and -not $r.json.ok) 'missing # Plan heading -> exit 2'
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "`n$passed passed, $failures failed"
exit $failures
