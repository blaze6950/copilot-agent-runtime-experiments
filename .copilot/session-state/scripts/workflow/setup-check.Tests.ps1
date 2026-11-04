<#
.SYNOPSIS
    Self-contained tests for setup-check.ps1 (no Pester dependency).
    Run: pwsh -NoProfile -File setup-check.Tests.ps1   (exit code = number of failures)
    Fixtures are synthetic; each test copies a fixture to a temp folder, runs git init/add there
    and deletes the temp folders at the end.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'setup-check.ps1'
$fixtures = Join-Path $PSScriptRoot 'fixtures/setup'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("setup-check-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0
$marker = 'SECRET-MARKER-DO-NOT-PRINT'
$expectedIds = @(
    'AGT-FRONTMATTER', 'AGT-NAME-FILE', 'AGT-MODEL-DESC', 'AGT-AGENT-TOOL', 'AGT-SHELL-DISCIPLINE', 'AGT-CLITOOLS',
    'REF-AGENT-NAMES', 'REF-SKIPLIST', 'HOOK-SCRIPT', 'SKILL-FOLDER', 'SKILL-ORPHAN', 'SET-EXT', 'JSON-VALID',
    'GIT-IGNORE', 'GIT-TRACKED-SENSITIVE')

function New-TempRepo([string] $Name) {
    $dir = Join-Path $tmp ($Name + '-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    Copy-Item -Path (Join-Path $fixtures "$Name/*") -Destination $dir -Recurse -Force
    git -C $dir init -q | Out-Null
    git -C $dir add -A | Out-Null
    return $dir
}

function Invoke-SetupCheck([string] $Root) {
    $out = & pwsh -NoProfile -File $script -Root $Root 2>$null
    $code = $LASTEXITCODE
    $raw = ($out -join "`n")
    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch { $json = $null }
    return [pscustomobject]@{ code = $code; raw = $raw; json = $json }
}

function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

try {
    Assert (Test-Path -LiteralPath $script -PathType Leaf) 'setup-check.ps1 exists'

    $goodRepo = New-TempRepo 'good'
    $badRepo = New-TempRepo 'bad'

    # AC-1 good fixture: exit 0, ok true, every check passes, all IDs reported
    $good = Invoke-SetupCheck $goodRepo
    Assert ($good.code -eq 0) "good fixture exits 0 (got $($good.code))"
    Assert ($null -ne $good.json -and $good.json.ok -eq $true) 'good fixture: ok is true'
    $goodNotPass = @($good.json.checks | Where-Object { $_.status -ne 'pass' })
    Assert ($goodNotPass.Count -eq 0) "good fixture: every check passes (non-pass: $(($goodNotPass | ForEach-Object id) -join ','))"
    $goodIds = @($good.json.checks | ForEach-Object { $_.id } | Sort-Object -Unique)
    Assert ((Compare-Object $goodIds ($expectedIds | Sort-Object)).Count -eq 0) 'good fixture: reports exactly the 15 stable check IDs'
    Assert ($good.json.summary.fail -eq 0) 'good fixture: summary.fail is 0'
    $goodExt = @($good.json.checks | Where-Object { $_.id -eq 'SET-EXT' -and $_.status -eq 'pass' })
    Assert ($goodExt.Count -eq 1) 'good fixture: SET-EXT passes with a .mjs statusLine target'
    $goodRefs = @($good.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'pass' })
    Assert ($goodRefs.Count -eq 1) 'good fixture: generic tokens (sub-worker, sub-agents) and _shell.json do not fail REF-AGENT-NAMES'

    # AC-1 bad fixture: exit 1, ok false, exactly one fail per check ID
    $bad = Invoke-SetupCheck $badRepo
    Assert ($bad.code -eq 1) "bad fixture exits 1 (got $($bad.code))"
    Assert ($null -ne $bad.json -and $bad.json.ok -eq $false) 'bad fixture: ok is false'
    foreach ($id in $expectedIds) {
        $fails = @($bad.json.checks | Where-Object { $_.id -eq $id -and $_.status -eq 'fail' })
        Assert ($fails.Count -eq 1) "bad fixture: $id fails exactly once (got $($fails.Count))"
    }
    # REF-AGENT-NAMES: the single real stale name is still reported (one violation, not masked by the generic rule)
    $badRefs = @($bad.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($badRefs.Count -eq 1 -and $badRefs[0].evidence.Count -eq 1 -and $badRefs[0].message -match 'util-missing-agent') 'bad fixture: REF-AGENT-NAMES keeps exactly one violation (util-missing-agent)'

    # AC-2 secrets: marker never printed; tracked secret file listed by path only
    Assert (-not $bad.raw.Contains($marker)) 'bad fixture: output never contains the mcp-secrets marker'
    Assert (-not $good.raw.Contains($marker)) 'good fixture: output never contains the mcp-secrets marker'
    $sens = @($bad.json.checks | Where-Object { $_.id -eq 'GIT-TRACKED-SENSITIVE' -and $_.status -eq 'fail' })
    $sensPaths = @($sens[0].evidence | ForEach-Object { $_.path })
    Assert ($sensPaths.Count -eq 1 -and $sensPaths[0] -eq 'mcp-secrets/token.txt') 'GIT-TRACKED-SENSITIVE evidence lists mcp-secrets/token.txt by path only'

    # Missing root -> exit 2
    $missing = Invoke-SetupCheck (Join-Path $tmp 'does-not-exist')
    Assert ($missing.code -eq 2) "missing -Root folder exits 2 (got $($missing.code))"

    # Info-level: disabledSkills entry without a folder is reported as info and does not change exit code
    $infoRepo = New-TempRepo 'good'
    $settingsPath = Join-Path $infoRepo 'settings.json'
    $settingsText = [System.IO.File]::ReadAllText($settingsPath)
    [System.IO.File]::WriteAllText($settingsPath, $settingsText.Replace('"disabledSkills": ["diagrams"]', '"disabledSkills": ["diagrams", "ghost-skill"]'))
    git -C $infoRepo add -A | Out-Null
    $info = Invoke-SetupCheck $infoRepo
    $infoChecks = @($info.json.checks | Where-Object { $_.id -eq 'SKILL-ORPHAN' -and $_.severity -eq 'info' })
    Assert ($info.code -eq 0 -and $infoChecks.Count -eq 1 -and $infoChecks[0].status -eq 'fail') 'orphan disabledSkills entry: SKILL-ORPHAN info finding, exit 0'
    $infoFolder = @($info.json.checks | Where-Object { $_.id -eq 'SKILL-FOLDER' -and $_.status -eq 'fail' })
    Assert ($infoFolder.Count -eq 0) 'orphan disabledSkills entry: SKILL-FOLDER has no info result (ID is not reused)'

    # --agent / /agent targets are strict: a generic prefix (sub-worker of sub-worker-main) cannot resolve at runtime,
    # so it is reported. The same token in prose (no flag) stays tolerated (good fixture guide.md).
    $flagRepo = New-TempRepo 'good'
    $guide = Join-Path $flagRepo 'docs/guide.md'
    [System.IO.File]::AppendAllText($guide, "`nRun it with ``--agent sub-worker``.`nOr ``/agent sub-worker``.`n")
    $flag = Invoke-SetupCheck $flagRepo
    $flagRefs = @($flag.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($flagRefs.Count -eq 1 -and $flagRefs[0].evidence.Count -eq 2 -and @($flagRefs[0].evidence | Where-Object { $_.path -eq 'docs/guide.md' }).Count -eq 2) 'flag target --agent/ /agent sub-worker: REF-AGENT-NAMES fails at docs/guide.md (2 flag lines, prose line still tolerated)'
    Assert ($null -ne $flagRefs[0] -and $flagRefs[0].message -match "unresolved agent 'sub-worker' at docs/guide\.md") 'flag target: message names the unresolved token and path'

    # Config refs are exact agent names (cli-tools/<agent>.json is looked up by name), so a generic prefix is reported
    $cfgRepo = New-TempRepo 'good'
    [System.IO.File]::WriteAllText((Join-Path $cfgRepo 'cli-tools/sub-worker.json'), "{}`n")
    $cfg = Invoke-SetupCheck $cfgRepo
    $cfgRefs = @($cfg.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($cfgRefs.Count -eq 1 -and @($cfgRefs[0].evidence | Where-Object { $_.path -eq 'cli-tools/sub-worker.json' }).Count -eq 1) 'config ref cli-tools/sub-worker.json (prefix of sub-worker-main): REF-AGENT-NAMES fails at that file'
    Assert ($null -ne $cfgRefs[0] -and $cfgRefs[0].message -match "unresolved agent 'sub-worker' at cli-tools/sub-worker\.json") 'config ref: message names the unresolved agent and path'

    # AGT-CLITOOLS exemption: disable-model-invocation: true agents run only as top-level agents (--agent X), so the
    # subagentStart hook never injects a cli-tools file for them. The good fixture has such an agent without one.
    Assert ((Test-Path -LiteralPath (Join-Path $goodRepo 'agents/util-toponly.agent.md') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $goodRepo 'cli-tools/util-toponly.json'))) 'good fixture: top-level-only agent util-toponly has powershell and no cli-tools file'
    $goodCli = @($good.json.checks | Where-Object { $_.id -eq 'AGT-CLITOOLS' -and $_.status -eq 'pass' })
    Assert ($goodCli.Count -eq 1) 'good fixture: top-level-only agent with powershell and no cli-tools file passes AGT-CLITOOLS'

    $modelRepo = New-TempRepo 'good'
    $toponlyPath = Join-Path $modelRepo 'agents/util-toponly.agent.md'
    [System.IO.File]::WriteAllText($toponlyPath, [System.IO.File]::ReadAllText($toponlyPath).Replace('disable-model-invocation: true', 'disable-model-invocation: false'))
    git -C $modelRepo add -A | Out-Null
    $model = Invoke-SetupCheck $modelRepo
    $modelCli = @($model.json.checks | Where-Object { $_.id -eq 'AGT-CLITOOLS' -and $_.status -eq 'fail' })
    Assert ($modelCli.Count -eq 1 -and @($modelCli[0].evidence | Where-Object { $_.path -eq 'agents/util-toponly.agent.md' }).Count -eq 1) 'model-invocable agent with powershell and no cli-tools file fails AGT-CLITOOLS (the flag is the only exemption)'

    $badCli = @($bad.json.checks | Where-Object { $_.id -eq 'AGT-CLITOOLS' -and $_.status -eq 'fail' })
    Assert ($badCli.Count -eq 1 -and $badCli[0].evidence.Count -eq 1 -and $badCli[0].evidence[0].path -eq 'agents/util-nocli.agent.md') 'bad fixture: AGT-CLITOOLS keeps exactly one violation, from model-invocable util-nocli'

    # AC-7 AGT-SHELL-DISCIPLINE: only top-level agents (disable-model-invocation: true) with powershell need their own
    # heading. Sub-agents get the shell rules by injection, so a sub-agent with powershell and no heading passes.
    $shellSubPath = Join-Path $goodRepo 'agents/util-shellsub.agent.md'
    Assert ((Test-Path -LiteralPath $shellSubPath -PathType Leaf) -and ([IO.File]::ReadAllText($shellSubPath) -notmatch 'Shell discipline')) 'good fixture: sub-agent util-shellsub has powershell and no shell heading'
    $goodShell = @($good.json.checks | Where-Object { $_.id -eq 'AGT-SHELL-DISCIPLINE' -and $_.status -eq 'pass' })
    Assert ($goodShell.Count -eq 1) 'good fixture: AGT-SHELL-DISCIPLINE passes with a sub-agent that has no shell heading'
    $badShell = @($bad.json.checks | Where-Object { $_.id -eq 'AGT-SHELL-DISCIPLINE' -and $_.status -eq 'fail' })
    Assert ($badShell.Count -eq 1 -and $badShell[0].evidence.Count -eq 1 -and $badShell[0].evidence[0].path -eq 'agents/util-noshell.agent.md') 'bad fixture: AGT-SHELL-DISCIPLINE keeps exactly one violation, from top-level util-noshell'

    # AC-7 shared rules: cli-tools/_shell.json needs a 'Shell discipline:' rule and subagent-context/shared-rules.md needs the four AC-6 headings
    $ruleRepo = New-TempRepo 'good'
    $ruleShell = Join-Path $ruleRepo 'cli-tools/_shell.json'
    [System.IO.File]::WriteAllText($ruleShell, [System.IO.File]::ReadAllText($ruleShell).Replace('Shell discipline:', 'Shell rules:'))
    git -C $ruleRepo add -A | Out-Null
    $rule = Invoke-SetupCheck $ruleRepo
    $ruleFails = @($rule.json.checks | Where-Object { $_.id -eq 'AGT-SHELL-DISCIPLINE' -and $_.status -eq 'fail' })
    Assert ($ruleFails.Count -eq 1 -and @($ruleFails[0].evidence | Where-Object { $_.path -eq 'cli-tools/_shell.json' }).Count -eq 1) 'shared rules: _shell.json without a Shell discipline: rule fails AGT-SHELL-DISCIPLINE at cli-tools/_shell.json'

    $headRepo = New-TempRepo 'good'
    $headCommon = Join-Path $headRepo 'subagent-context/shared-rules.md'
    [System.IO.File]::WriteAllText($headCommon, [System.IO.File]::ReadAllText($headCommon).Replace('## Secrets', '## Secret notes'))
    git -C $headRepo add -A | Out-Null
    $head = Invoke-SetupCheck $headRepo
    $headFails = @($head.json.checks | Where-Object { $_.id -eq 'AGT-SHELL-DISCIPLINE' -and $_.status -eq 'fail' })
    Assert ($headFails.Count -eq 1 -and $headFails[0].message -match 'Secrets' -and @($headFails[0].evidence | Where-Object { $_.path -eq 'subagent-context/shared-rules.md' }).Count -eq 1) 'shared rules: shared-rules.md without the ## Secrets heading fails AGT-SHELL-DISCIPLINE at subagent-context/shared-rules.md'

    $crlfRepo = New-TempRepo 'good'
    $crlfCommon = Join-Path $crlfRepo 'subagent-context/shared-rules.md'
    [System.IO.File]::WriteAllText($crlfCommon, ([System.IO.File]::ReadAllText($crlfCommon) -replace "`r?`n", "`r`n"))
    git -C $crlfRepo add -A | Out-Null
    $crlf = Invoke-SetupCheck $crlfRepo
    $crlfFails = @($crlf.json.checks | Where-Object { $_.id -eq 'AGT-SHELL-DISCIPLINE' -and $_.status -eq 'fail' })
    Assert ($crlfFails.Count -eq 0) 'shared rules: shared-rules.md with CRLF line endings passes AGT-SHELL-DISCIPLINE'

    # legacy-names marker: it exempts only the tokens it lists, on its own line; flag refs on that line are still checked
    $legacyRepo = New-TempRepo 'good'
    $legacyGuide = Join-Path $legacyRepo 'docs/guide.md'
    [System.IO.File]::AppendAllText($legacyGuide, "`nOld prose name sub-old-name stays readable. <!-- setup-check: legacy-names=sub-old-name -->`n")
    git -C $legacyRepo add -A | Out-Null
    $legacy = Invoke-SetupCheck $legacyRepo
    $legacyFails = @($legacy.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($legacyFails.Count -eq 0) 'legacy-names marker: listed prose token on a marked line passes REF-AGENT-NAMES'

    $legacyUnlistedRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $legacyUnlistedRepo 'docs/guide.md'), "`nOld names sub-old-name and sub-other-old. <!-- setup-check: legacy-names=sub-old-name -->`n")
    git -C $legacyUnlistedRepo add -A | Out-Null
    $legacyUnlisted = Invoke-SetupCheck $legacyUnlistedRepo
    $legacyUnlistedFails = @($legacyUnlisted.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($legacyUnlistedFails.Count -eq 1 -and $legacyUnlistedFails[0].message -match "unresolved agent 'sub-other-old' at docs/guide\.md" -and $legacyUnlistedFails[0].message -notmatch 'sub-old-name') 'legacy-names marker: unlisted unknown token on a marked line still fails REF-AGENT-NAMES'

    $legacyFlagRepo = New-TempRepo 'good'
    $legacyFlagGuide = Join-Path $legacyFlagRepo 'docs/guide.md'
    [System.IO.File]::AppendAllText($legacyFlagGuide, "`nOld flag ``--agent unknownname`` <!-- setup-check: legacy-names=unknownname -->`n")
    git -C $legacyFlagRepo add -A | Out-Null
    $legacyFlag = Invoke-SetupCheck $legacyFlagRepo
    $legacyFlagFails = @($legacyFlag.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($legacyFlagFails.Count -eq 1 -and $legacyFlagFails[0].message -match "unresolved agent 'unknownname' at docs/guide\.md") 'legacy-names marker: --agent unknownname on a marked line still fails REF-AGENT-NAMES'

    $unmarkedRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $unmarkedRepo 'docs/guide.md'), "`nOld prose name sub-old-name without a marker.`n")
    git -C $unmarkedRepo add -A | Out-Null
    $unmarked = Invoke-SetupCheck $unmarkedRepo
    $unmarkedFails = @($unmarked.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($unmarkedFails.Count -eq 1 -and $unmarkedFails[0].message -match "unresolved agent 'sub-old-name' at docs/guide\.md") 'unmarked unknown prose token still fails REF-AGENT-NAMES'

    # the bare marker (no token list) exempts nothing
    $bareRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $bareRepo 'docs/guide.md'), "`nOld prose name sub-old-name. <!-- setup-check: legacy-names -->`n")
    git -C $bareRepo add -A | Out-Null
    $bare = Invoke-SetupCheck $bareRepo
    $bareFails = @($bare.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($bareFails.Count -eq 1 -and $bareFails[0].message -match "unresolved agent 'sub-old-name' at docs/guide\.md") 'bare legacy-names marker without a token list exempts nothing'

    # agents/*.agent.md bodies are scanned for flag refs only (agent bodies may name legacy agents in prose)
    $bodyFlagRepo = New-TempRepo 'good'
    $syncPath = Join-Path $bodyFlagRepo 'agents/util-plugin-sync.agent.md'
    [System.IO.File]::AppendAllText($syncPath, "`n/agent nosuchagent`n")
    $syncLines = [System.IO.File]::ReadAllLines($syncPath)
    git -C $bodyFlagRepo add -A | Out-Null
    $bodyFlag = Invoke-SetupCheck $bodyFlagRepo
    $bodyFlagFails = @($bodyFlag.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($bodyFlagFails.Count -eq 1 -and $bodyFlagFails[0].evidence.Count -eq 1 -and $bodyFlagFails[0].evidence[0].path -eq 'agents/util-plugin-sync.agent.md' -and $bodyFlagFails[0].evidence[0].line -eq $syncLines.Count -and $bodyFlagFails[0].message -match "unresolved agent 'nosuchagent' at agents/util-plugin-sync\.agent\.md:$($syncLines.Count)") 'agent body flag /agent nosuchagent: REF-AGENT-NAMES fails with path:line evidence'

    $bodyProseRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $bodyProseRepo 'agents/util-plugin-sync.agent.md'), "`nProse mention of sub-legacy-thing is allowed in agent bodies.`n")
    git -C $bodyProseRepo add -A | Out-Null
    $bodyProse = Invoke-SetupCheck $bodyProseRepo
    $bodyProseFails = @($bodyProse.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($bodyProseFails.Count -eq 0) 'agent body prose token sub-legacy-thing: REF-AGENT-NAMES passes (prose tokens are not scanned in agent bodies)'

    # flag refs need a word boundary before --agent or /agent: prose such as 'label/agent dispatches' is not a flag ref
    $anchorRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $anchorRepo 'agents/util-plugin-sync.agent.md'), "`nThe label/agent dispatches count and foo--agent x are prose.`n")
    git -C $anchorRepo add -A | Out-Null
    $anchor = Invoke-SetupCheck $anchorRepo
    $anchorFails = @($anchor.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($anchorFails.Count -eq 0) 'agent body prose label/agent dispatches and foo--agent x are not flag refs'

    # a file name such as util-workflow-analyst.json is not an agent name, not even its truncated prefix
    $fileRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $fileRepo 'docs/guide.md'), "`nSee cli-tools/util-workflow-analyst.json and sub-worker-main.md; the sub-worker-* and sub-worker-<x> families are placeholders.`n")
    git -C $fileRepo add -A | Out-Null
    $fileCheck = Invoke-SetupCheck $fileRepo
    $fileFails = @($fileCheck.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($fileFails.Count -eq 0) 'file names util-workflow-analyst.json and sub-worker-main.md are not agent tokens (no truncated prefix match)'

    # stale families and trailing-hyphen placeholders must still be caught as unknown names
    $staleRepo = New-TempRepo 'good'
    [System.IO.File]::AppendAllText((Join-Path $staleRepo 'docs/guide.md'), "`nStale family sub-oldfamily-* and sub-oldfamily-<x> and sub-oldthing-.`n")
    git -C $staleRepo add -A | Out-Null
    $staleCheck = Invoke-SetupCheck $staleRepo
    $staleFails = @($staleCheck.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($staleFails.Count -eq 1 -and $staleFails[0].message -match "unresolved agent 'sub-oldfamily' at docs/guide\.md" -and $staleFails[0].message -match "unresolved agent 'sub-oldthing' at docs/guide\.md") 'stale families sub-oldfamily-* / sub-oldfamily-<x> and sub-oldthing- are caught as unresolved names'
    # AGT-AGENT-TOOL pins the 1main-only allow-list (setup-check.ps1 $allowedAgentTool): the analyst WITH the agent tool fails
    $analystToolRepo = New-TempRepo 'good'
    $analystToolFile = Join-Path $analystToolRepo 'agents/util-workflow-analyst.agent.md'
    $analystToolText = [IO.File]::ReadAllText($analystToolFile)
    [IO.File]::WriteAllText($analystToolFile, ($analystToolText -replace "tools:\r?\n", "tools:`n  - agent`n"))
    git -C $analystToolRepo add -A | Out-Null
    $analystToolCheck = Invoke-SetupCheck $analystToolRepo
    $analystToolFails = @($analystToolCheck.json.checks | Where-Object { $_.id -eq 'AGT-AGENT-TOOL' -and $_.status -eq 'fail' })
    Assert ($analystToolFails.Count -eq 1 -and $analystToolFails[0].evidence.Count -eq 1 -and $analystToolFails[0].evidence[0].path -eq 'agents/util-workflow-analyst.agent.md') 'AGT-AGENT-TOOL: util-workflow-analyst with the agent tool fails (only 1main may have it)'

    # AC-11 ladder agents: REF-AGENT-NAMES reads ladder.actions[].when.agents of extensions/cache-keeper/config.json
    $ladderGoodRepo = New-TempRepo 'good'
    $ladderGoodCfg = [System.IO.File]::ReadAllText((Join-Path $ladderGoodRepo 'extensions/cache-keeper/config.json')) | ConvertFrom-Json
    $ladderGoodPass = @($good.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'pass' })
    Assert ($null -ne $ladderGoodCfg.ladder -and @($ladderGoodCfg.ladder.actions[0].when.agents) -contains 'util-workflow-analyst' -and $ladderGoodPass.Count -eq 1) 'ladder agents: good fixture lists its agent in ladder.actions[].when.agents and REF-AGENT-NAMES still passes'

    $ladderBadRepo = New-TempRepo 'good'
    [System.IO.File]::WriteAllText((Join-Path $ladderBadRepo 'extensions/cache-keeper/config.json'), '{ "ladder": { "actions": [ { "id": "save", "command": "/save", "when": { "agents": ["util-workflow-analyst", "util-ghost-agent"] } } ] } }' + "`n")
    git -C $ladderBadRepo add -A | Out-Null
    $ladderBad = Invoke-SetupCheck $ladderBadRepo
    $ladderBadFails = @($ladderBad.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($ladderBad.code -eq 1 -and $ladderBadFails.Count -eq 1 -and $ladderBadFails[0].evidence.Count -eq 1 -and @($ladderBadFails[0].evidence | Where-Object { $_.path -eq 'extensions/cache-keeper/config.json' }).Count -eq 1 -and $ladderBadFails[0].message -match "unresolved agent 'util-ghost-agent' at extensions/cache-keeper/config\.json") 'ladder agents: an unknown name in ladder.actions[].when.agents fails REF-AGENT-NAMES at extensions/cache-keeper/config.json'

    $noRefConfigs = @(
        '{}',
        '{ "ladder": { "keepalives": 3 } }',
        '{ "ladder": { "actions": [ "x", 5, { "id": "c", "command": "/compact" }, { "id": "t", "text": "hi", "when": { "minContextTokens": 1 } } ] } }'
    )
    $noRefFailing = @()
    foreach ($noRefJson in $noRefConfigs) {
        $noRefRepo = New-TempRepo 'good'
        [System.IO.File]::WriteAllText((Join-Path $noRefRepo 'extensions/cache-keeper/config.json'), $noRefJson + "`n")
        git -C $noRefRepo add -A | Out-Null
        $noRef = Invoke-SetupCheck $noRefRepo
        $noRefFails = @($noRef.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
        if ($noRef.code -ne 0 -or $noRefFails.Count -ne 0) { $noRefFailing += $noRefJson }
    }
    Assert ($noRefFailing.Count -eq 0) "ladder agents: configs without ladder, actions, when or agents add no refs (failing: $($noRefFailing -join ' | '))"

    $oldSaveRepo = New-TempRepo 'good'
    [System.IO.File]::WriteAllText((Join-Path $oldSaveRepo 'extensions/cache-keeper/config.json'), '{ "save": { "agents": ["util-ghost-agent"] } }' + "`n")
    git -C $oldSaveRepo add -A | Out-Null
    $oldSave = Invoke-SetupCheck $oldSaveRepo
    $oldSaveFails = @($oldSave.json.checks | Where-Object { $_.id -eq 'REF-AGENT-NAMES' -and $_.status -eq 'fail' })
    Assert ($oldSave.code -eq 0 -and $oldSaveFails.Count -eq 0) 'ladder agents: the old save.agents key is no longer read'
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "`n$passed passed, $failures failed"
exit $failures
