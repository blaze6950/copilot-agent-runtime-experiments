<#
.SYNOPSIS
    Deterministic, read-only setup audit of a Copilot CLI config folder (report-only).
.DESCRIPTION
    Prints one JSON object on stdout: { ok, root, generatedAt, summary: { pass, fail, warn }, checks[] }.
    Exit codes: 0 = no error-severity failure, 1 = at least one error-severity failure,
    2 = internal error or missing -Root folder.
    Privacy: never opens mcp-secrets/, mcp-oauth-config/, entra-broker-*, config.json or mcp-config.json.
    Tracked secret-adjacent files are reported by path name only (git ls-files).
#>
param([string] $Root = (Join-Path $HOME '.copilot'))

$ErrorActionPreference = 'Stop'
$sep = [System.IO.Path]::DirectorySeparatorChar.ToString()
$scriptPattern = '[^\s"<>|;&\x27]+\.(?:ps1|csx|js|mjs|cjs|ts|sh)\b'
$namePattern = '\b(?:sub|util)-[a-z0-9]+(?:-[a-z0-9]+)*(?!\w)(?!-\w)(?!\.(?:ps1|csx|json|md)\b)'
$agentFlagPattern = '(?:(?<![\w-])--agent|(?<![\w/])/agent)\s+([A-Za-z0-9][\w-]*)'
$allowedAgentTool = @('1main')
$gitIgnoreProbes = @('session-state/x/events.jsonl', 'logs/x.log', 'cli-tools/inject.log', 'subagent-context/inject.log', 'env-context/inject.log', 'extensions/cache-keeper/state/x.json', 'reports/x.md')
$trackedSensitiveFiles = @('config.json', 'permissions-config.json', 'mcp-config.json')
# Legacy-names marker: <!-- setup-check: legacy-names=name-a,name-b -->. It exempts only the listed prose tokens on its own line;
# flag refs on the line are always checked.
$legacyPattern = '<!--\s*setup-check:\s*legacy-names=([^>]*?)\s*-->'

function Get-UnquotedValue([string] $Value) {
    $v = $Value.Trim()
    if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
        return $v.Substring(1, $v.Length - 2)
    }
    return $v
}

function New-Check([string] $Id, [string] $Severity, [string] $Subject, [bool] $Pass, [string] $Message, [object[]] $Evidence = @()) {
    [pscustomobject]@{
        id       = $Id
        severity = $Severity
        subject  = $Subject
        status   = $(if ($Pass) { 'pass' } else { 'fail' })
        message  = $Message
        evidence = @($Evidence)
    }
}

function New-Ev([string] $Path, [int] $Line = 1) {
    [pscustomobject]@{ path = $Path; line = $Line }
}

function Get-Msg([string[]] $Problems, [string] $Ok) {
    if ($Problems.Count -gt 0) { return ($Problems -join '; ') }
    return $Ok
}

function Get-LineNo([string[]] $Lines, [string] $Pattern) {
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $Pattern) { return $i + 1 }
    }
    return 1
}

function Read-JsonSafe([string] $Path) {
    try {
        return [pscustomobject]@{ ok = $true; value = (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path))) }
    }
    catch {
        # Parser messages can echo file content, so they are deliberately not kept.
        return [pscustomobject]@{ ok = $false; value = $null }
    }
}

function Read-Frontmatter([string] $Path) {
    $lines = [IO.File]::ReadAllLines($Path)
    $r = [pscustomobject]@{ HasFrontmatter = $false; Fields = @{}; Lines = @{}; Lists = @{}; Body = $lines }
    if ($lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return $r }
    $end = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { $end = $i; break }
    }
    if ($end -lt 0) { return $r }
    $r.HasFrontmatter = $true
    $listKey = $null
    for ($i = 1; $i -lt $end; $i++) {
        $line = $lines[$i]
        if ($line.Trim() -eq '' -or $line -match '^\s*#') { continue }
        if ($listKey -and $line -match '^\s*-\s*(.*?)\s*$') {
            $r.Lists[$listKey] = @($r.Lists[$listKey]) + @(Get-UnquotedValue $Matches[1])
            continue
        }
        if ($line -match '^([A-Za-z_][\w-]*):\s*(.*?)\s*$') {
            $key = $Matches[1]
            $value = $Matches[2]
            $listKey = $null
            $r.Lines[$key] = $i + 1
            if ($value -eq '') {
                $listKey = $key
                $r.Lists[$key] = @()
                $r.Fields[$key] = ''
            }
            elseif ($value.StartsWith('[') -and $value.EndsWith(']')) {
                $r.Lists[$key] = @($value.Trim('[', ']') -split ',' | ForEach-Object { Get-UnquotedValue $_ } | Where-Object { $_ })
                $r.Fields[$key] = $value
            }
            else {
                $r.Fields[$key] = Get-UnquotedValue $value
            }
        }
    }
    return $r
}

function Get-Tools($Fm) {
    if ($Fm.Lists.ContainsKey('tools')) { return @($Fm.Lists['tools']) }
    return @()
}

function Get-KeyLine($Fm, [string] $Key) {
    if ($Fm.Lines.ContainsKey($Key)) { return [int]$Fm.Lines[$Key] }
    return 1
}

function Get-NameRefs([string] $Full, [string] $Rel, [bool] $FlagsOnly = $false) {
    $lines = [IO.File]::ReadAllLines($Full)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        # A legacy-names marker on the line exempts only the prose tokens it lists; flag refs are always checked.
        $exempt = @()
        $legacyMatch = [regex]::Match($lines[$i], $legacyPattern)
        if ($legacyMatch.Success) {
            $exempt = @($legacyMatch.Groups[1].Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        if (-not $FlagsOnly) {
            foreach ($m in [regex]::Matches($lines[$i], $namePattern)) {
                if ($exempt -cnotcontains $m.Value) {
                    [pscustomobject]@{ name = $m.Value; path = $Rel; line = $i + 1; kind = 'token' }
                }
            }
        }
        foreach ($m in [regex]::Matches($lines[$i], $agentFlagPattern)) {
            [pscustomobject]@{ name = $m.Groups[1].Value; path = $Rel; line = $i + 1; kind = 'flag' }
        }
    }
}

# REF-AGENT-NAMES tolerance. Each ref has a kind:
#   'token'  a name in prose or docs (matched by namePattern);
#   'flag'   a --agent / /agent target (agentFlagPattern);
#   'config' an exact agent name used by code: a ladder.actions[].when.agents entry in extensions/cache-keeper/config.json or a
#            cli-tools/<name>.json file name (subagent-context/inject.ps1 looks up cli-tools/<agentName>.json).
# Only 'token' refs can be tolerated. A matched token is NOT reported when:
#  (a) it is a generic category word: a strict prefix of an existing agent name followed by '-'. The agent names
#      come from agents/*.agent.md, so no list is maintained by hand (e.g. 'sub-worker' in prose while
#      'sub-worker-main' exists; 'sub-expert' while 'sub-expert-ado' exists);
#  (b) it is 'sub-agent' or 'sub-agents' (prose about sub-agents in general);
#  (c) it is listed in the legacy-names marker on its line (<!-- setup-check: legacy-names=a,b -->), e.g. the stale names in §4 of AGENTS.md.
# Agent bodies (agents/*.agent.md) are scanned for flag refs only: they legitimately name legacy agents in prose.
# 'flag' and 'config' refs must resolve exactly: the runtime needs the exact name for --agent / /agent and for
# cli-tools/<agent>.json lookups, so '--agent sub-worker' or 'cli-tools/sub-worker.json' is reported even though
# 'sub-worker-main' exists. Real stale names are still reported, e.g. '--agent main' when no agent is named 'main'.
# _-prefixed cli-tools files (shared helpers such as _shell.json) are not agents and are skipped.
function Test-GenericAgentToken([string] $Token, [string[]] $AgentNames) {
    if ($Token -ceq 'sub-agent' -or $Token -ceq 'sub-agents') { return $true }
    foreach ($n in $AgentNames) {
        if ($n.StartsWith($Token + '-', [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

try {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        [Console]::Error.WriteLine("setup-check: root folder not found: $Root")
        exit 2
    }
    $rootFull = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd($sep)

    function Join-Rel([string] $Rel) {
        return [IO.Path]::Combine($rootFull, ($Rel -replace '/', $sep))
    }

    # Expands $HOME/~ prefixes: "$HOME/.copilot/..." maps to -Root; other $HOME paths map to the user profile.
    function Resolve-Target([string] $Token) {
        $t = ($Token.TrimStart('\') -replace '\\+', '/')
        if ($t -match '^(?:\$HOME|\$\{HOME\}|~|\$env:USERPROFILE)/\.copilot/(.+)$') { return Join-Rel $Matches[1] }
        if ($t -match '^(?:\$HOME|\$\{HOME\}|~|\$env:USERPROFILE)/(.+)$') { return [IO.Path]::Combine($HOME, ($Matches[1] -replace '/', $sep)) }
        if ([IO.Path]::IsPathRooted($t)) { return $t }
        return Join-Rel $t
    }

    # ---- discovery (names and parsed metadata only where a check needs them) ----
    $agentsDir = Join-Rel 'agents'
    $agentFiles = @()
    if (Test-Path -LiteralPath $agentsDir -PathType Container) {
        $agentFiles = @(Get-ChildItem -LiteralPath $agentsDir -File -Filter '*.agent.md' | Sort-Object Name)
    }
    $agents = @(foreach ($f in $agentFiles) {
            $fm = Read-Frontmatter $f.FullName
            $base = $f.Name -replace '\.agent\.md$', ''
            $name = if ($fm.Fields.ContainsKey('name') -and $fm.Fields['name']) { $fm.Fields['name'] } else { $base }
            [pscustomobject]@{ File = $f.Name; Rel = "agents/$($f.Name)"; Base = $base; Name = $name; Fm = $fm }
        })

    $settingsPath = Join-Rel 'settings.json'
    $settingsRead = [pscustomobject]@{ ok = $false; value = $null }
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) { $settingsRead = Read-JsonSafe $settingsPath }
    $settings = $settingsRead.value
    $disabled = @()
    if ($settingsRead.ok -and $null -ne $settings.disabledSkills) { $disabled = @($settings.disabledSkills) }

    $skillsDir = Join-Rel 'skills'
    $skillFolders = @()
    if (Test-Path -LiteralPath $skillsDir -PathType Container) {
        $skillFolders = @(Get-ChildItem -LiteralPath $skillsDir -Directory | Sort-Object Name)
    }

    $hooksDir = Join-Rel 'hooks'
    $hookFiles = @()
    if (Test-Path -LiteralPath $hooksDir -PathType Container) {
        $hookFiles = @(Get-ChildItem -LiteralPath $hooksDir -File -Filter '*.json' | Sort-Object Name)
    }

    $cliDir = Join-Rel 'cli-tools'
    $cliFiles = @()
    if (Test-Path -LiteralPath $cliDir -PathType Container) {
        $cliFiles = @(Get-ChildItem -LiteralPath $cliDir -File -Filter '*.json' | Sort-Object Name)
    }

    $checks = New-Object System.Collections.Generic.List[object]

    # ---- AGT-* ----
    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        $probs = @()
        if (-not $a.Fm.HasFrontmatter) { $probs += 'no frontmatter' }
        foreach ($k in @('name', 'description')) {
            if (-not $a.Fm.Fields.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($a.Fm.Fields[$k])) { $probs += "missing $k" }
        }
        if ($probs.Count -gt 0) { $ev += New-Ev $a.Rel 1; $msgs += "$($a.File): $($probs -join ', ')" }
    }
    $checks.Add((New-Check 'AGT-FRONTMATTER' 'error' 'agents/*.agent.md' ($ev.Count -eq 0) (Get-Msg $msgs "$($agents.Count) agent(s) have name and description") $ev))

    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        if ($a.Name -ne $a.Base) {
            $ev += New-Ev $a.Rel (Get-KeyLine $a.Fm 'name')
            $msgs += "$($a.File): name '$($a.Name)' differs from file name"
        }
    }
    $checks.Add((New-Check 'AGT-NAME-FILE' 'warn' 'agents/*.agent.md name vs file' ($ev.Count -eq 0) (Get-Msg $msgs 'agent names match file names') $ev))

    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        if ($a.Fm.Fields.ContainsKey('description') -and $a.Fm.Fields['description'] -match '\(model:\s*([^)\s]+)\s*\)') {
            $declared = $Matches[1]
            $actual = if ($a.Fm.Fields.ContainsKey('model')) { $a.Fm.Fields['model'] } else { '' }
            if ($actual -ne $declared) {
                $ev += New-Ev $a.Rel (Get-KeyLine $a.Fm 'description')
                $msgs += "$($a.File): description says model '$declared', model field is '$actual'"
            }
        }
    }
    $checks.Add((New-Check 'AGT-MODEL-DESC' 'error' 'agents/*.agent.md description model' ($ev.Count -eq 0) (Get-Msg $msgs 'description model matches model field') $ev))

    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        $tools = Get-Tools $a.Fm
        if (($tools -contains 'agent') -and ($allowedAgentTool -notcontains $a.Name)) {
            $ev += New-Ev $a.Rel 1
            $msgs += "$($a.File): agent tool not allowed for '$($a.Name)'"
        }
    }
    $checks.Add((New-Check 'AGT-AGENT-TOOL' 'error' 'agents/*.agent.md agent tool' ($ev.Count -eq 0) (Get-Msg $msgs 'agent tool limited to allowed agents') $ev))

    # Sub-agents get the shell rules by injection (cli-tools/_shell.json and subagent-context/shared-rules.md), so only top-level-only
    # agents (disable-model-invocation: true) must carry their own heading. The shared rules themselves must exist.
    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        if ([string]$a.Fm.Fields['disable-model-invocation'] -ieq 'true') {
            $tools = Get-Tools $a.Fm
            if ($tools -contains 'powershell') {
                $hasHeading = @($a.Fm.Body | Where-Object { $_ -match '^#{1,6}\s+.*Shell discipline' }).Count -gt 0
                if (-not $hasHeading) {
                    $ev += New-Ev $a.Rel 1
                    $msgs += "$($a.File): top-level powershell agent without a 'Shell discipline' heading"
                }
            }
        }
    }

    $shellRel = 'cli-tools/_shell.json'
    $shellPath = Join-Rel $shellRel
    if (-not (Test-Path -LiteralPath $shellPath -PathType Leaf)) {
        $ev += New-Ev $shellRel 1
        $msgs += 'cli-tools/_shell.json missing'
    }
    else {
        $shellRead = Read-JsonSafe $shellPath
        if (-not $shellRead.ok) {
            $ev += New-Ev $shellRel 1
            $msgs += 'cli-tools/_shell.json does not parse as JSON'
        }
        elseif (@($shellRead.value.Rules | Where-Object { $_ -is [string] -and $_.StartsWith('Shell discipline:') }).Count -eq 0) {
            $ev += New-Ev $shellRel 1
            $msgs += "cli-tools/_shell.json has no 'Shell discipline:' rule"
        }
    }

    $commonRel = 'subagent-context/shared-rules.md'
    $commonPath = Join-Rel $commonRel
    if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
        $ev += New-Ev $commonRel 1
        $msgs += 'subagent-context/shared-rules.md missing'
    }
    else {
        $foundHeadings = @()
        foreach ($line in [IO.File]::ReadAllLines($commonPath)) {
            if ($line.TrimEnd([char]13) -match '^## (Reports|NEEDS-INPUT|Evidence|Secrets)\s*$') { $foundHeadings += $Matches[1] }
        }
        $absentHeadings = @(@('Reports', 'NEEDS-INPUT', 'Evidence', 'Secrets') | Where-Object { $foundHeadings -notcontains $_ })
        if ($absentHeadings.Count -gt 0) {
            $ev += New-Ev $commonRel 1
            $msgs += "subagent-context/shared-rules.md misses heading(s): $($absentHeadings -join ', ')"
        }
    }

    $checks.Add((New-Check 'AGT-SHELL-DISCIPLINE' 'error' 'agents/*.agent.md shell discipline and shared shell rules' ($ev.Count -eq 0) (Get-Msg $msgs 'top-level powershell agents have a shell discipline section; shared shell rules present') $ev))

    $ev = @(); $msgs = @()
    foreach ($a in $agents) {
        # Top-level-only agents (disable-model-invocation: true) run as --agent X; the subagentStart hook never fires
        # for them, so a cli-tools file would never be injected. They are exempt.
        if ([string]$a.Fm.Fields['disable-model-invocation'] -ieq 'true') { continue }
        $tools = Get-Tools $a.Fm
        if (($tools -contains 'powershell') -and -not (Test-Path -LiteralPath (Join-Rel "cli-tools/$($a.Name).json") -PathType Leaf)) {
            $ev += New-Ev $a.Rel 1
            $msgs += "$($a.File): no cli-tools/$($a.Name).json"
        }
    }
    $checks.Add((New-Check 'AGT-CLITOOLS' 'warn' 'agents/*.agent.md cli-tools file' ($ev.Count -eq 0) (Get-Msg $msgs 'powershell agents have a cli-tools file') $ev))

    # ---- REF-* ----
    $known = @{}
    foreach ($a in $agents) { $known[$a.Name] = $true }

    $refFiles = @()
    $agentsMd = Join-Rel 'AGENTS.md'
    if (Test-Path -LiteralPath $agentsMd -PathType Leaf) { $refFiles += [pscustomobject]@{ Full = $agentsMd; Rel = 'AGENTS.md' } }
    $docsDir = Join-Rel 'docs'
    if (Test-Path -LiteralPath $docsDir -PathType Container) {
        foreach ($d in (Get-ChildItem -LiteralPath $docsDir -File -Filter '*.md' | Sort-Object Name)) {
            $refFiles += [pscustomobject]@{ Full = $d.FullName; Rel = "docs/$($d.Name)" }
        }
    }
    foreach ($d in $skillFolders) {
        if ($disabled -contains $d.Name) { continue }
        $skillMd = Join-Path $d.FullName 'SKILL.md'
        if (Test-Path -LiteralPath $skillMd -PathType Leaf) { $refFiles += [pscustomobject]@{ Full = $skillMd; Rel = "skills/$($d.Name)/SKILL.md"; FlagsOnly = $false } }
    }
    # Agent bodies legitimately mention legacy names in prose, so only their --agent / /agent flag refs are checked.
    foreach ($f in $agentFiles) {
        $refFiles += [pscustomobject]@{ Full = $f.FullName; Rel = "agents/$($f.Name)"; FlagsOnly = $true }
    }

    $refs = @()
    foreach ($rf in $refFiles) { $refs += @(Get-NameRefs $rf.Full $rf.Rel ([bool]$rf.FlagsOnly)) }

    $cachePath = Join-Rel 'extensions/cache-keeper/config.json'
    if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
        $cache = Read-JsonSafe $cachePath
        if ($cache.ok -and $null -ne $cache.value.ladder) {
            $cacheLines = [IO.File]::ReadAllLines($cachePath)
            foreach ($action in @($cache.value.ladder.actions)) {
                if ($action -isnot [pscustomobject] -or $null -eq $action.when) { continue }
                foreach ($n in @($action.when.agents)) {
                    if ($n -is [string] -and $n) { $refs += [pscustomobject]@{ name = $n; path = 'extensions/cache-keeper/config.json'; line = (Get-LineNo $cacheLines ('"' + [regex]::Escape($n) + '"')); kind = 'config' } }
                }
            }
        }
    }
    foreach ($c in $cliFiles) {
        # _-prefixed cli-tools files (e.g. _shell) are shared helpers, not agents.
        if ($c.BaseName.StartsWith('_')) { continue }
        $refs += [pscustomobject]@{ name = $c.BaseName; path = "cli-tools/$($c.Name)"; line = 1; kind = 'config' }
    }

    $ev = @(); $msgs = @(); $seen = @{}
    $agentNames = @($known.Keys)
    foreach ($r in $refs) {
        $key = "$($r.name)|$($r.path)|$($r.line)"
        $tolerated = ($r.kind -eq 'token') -and (Test-GenericAgentToken $r.name $agentNames)
        if (-not $known.ContainsKey($r.name) -and -not $tolerated -and -not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $ev += New-Ev $r.path $r.line
            $msgs += "unresolved agent '$($r.name)' at $($r.path):$($r.line)"
        }
    }
    $checks.Add((New-Check 'REF-AGENT-NAMES' 'error' 'agent name references' ($ev.Count -eq 0) (Get-Msg $msgs 'all agent references resolve') $ev))

    $ev = @(); $msgs = @()
    $syncAgent = $agents | Where-Object { $_.Base -eq 'util-plugin-sync' } | Select-Object -First 1
    $skipText = $null
    $skipLine = 0
    if ($syncAgent) {
        for ($i = 0; $i -lt $syncAgent.Fm.Body.Count; $i++) {
            if ($syncAgent.Fm.Body[$i] -match '(?i)Skip all user-created agents') { $skipText = $syncAgent.Fm.Body[$i]; $skipLine = $i + 1; break }
        }
    }
    if (-not $syncAgent) {
        $ev += New-Ev 'agents/util-plugin-sync.agent.md' 1
        $msgs += 'util-plugin-sync agent not found'
    }
    elseif ($null -eq $skipText) {
        $ev += New-Ev $syncAgent.Rel 1
        $msgs += 'skip-list line not found'
    }
    else {
        foreach ($a in $agents) {
            if ($skipText -notmatch ('(?<![\w-])' + [regex]::Escape($a.Name) + '(?![\w-])')) {
                $ev += New-Ev $syncAgent.Rel $skipLine
                $msgs += "skip-list misses $($a.Name)"
            }
        }
    }
    $checks.Add((New-Check 'REF-SKIPLIST' 'warn' 'util-plugin-sync skip-list' ($ev.Count -eq 0) (Get-Msg $msgs 'skip-list names every agent') $ev))

    # ---- HOOK-SCRIPT ----
    $ev = @(); $msgs = @()
    foreach ($h in $hookFiles) {
        $hookLines = [IO.File]::ReadAllLines($h.FullName)
        for ($i = 0; $i -lt $hookLines.Count; $i++) {
            foreach ($m in [regex]::Matches($hookLines[$i], $scriptPattern)) {
                $target = Resolve-Target ($m.Value)
                if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
                    $ev += New-Ev "hooks/$($h.Name)" ($i + 1)
                    $msgs += "hooks/$($h.Name):$($i + 1) references missing script $($m.Value)"
                }
            }
        }
    }
    $checks.Add((New-Check 'HOOK-SCRIPT' 'error' 'hooks/*.json script paths' ($ev.Count -eq 0) (Get-Msg $msgs "all hook scripts exist ($($hookFiles.Count) hook file(s))") $ev))

    # ---- SKILL-FOLDER (error) ----
    $ev = @(); $msgs = @()
    foreach ($d in $skillFolders) {
        if ($disabled -contains $d.Name) { continue }
        $skillMd = Join-Path $d.FullName 'SKILL.md'
        $rel = "skills/$($d.Name)/SKILL.md"
        if (-not (Test-Path -LiteralPath $skillMd -PathType Leaf)) {
            $ev += New-Ev $rel 1
            $msgs += "$($d.Name): no SKILL.md"
            continue
        }
        $fm = Read-Frontmatter $skillMd
        $probs = @()
        foreach ($k in @('name', 'description')) {
            if (-not $fm.Fields.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($fm.Fields[$k])) { $probs += "missing $k" }
        }
        if ($probs.Count -gt 0) { $ev += New-Ev $rel 1; $msgs += "$($d.Name): $($probs -join ', ')" }
    }
    $checks.Add((New-Check 'SKILL-FOLDER' 'error' 'skills/* enabled folders' ($ev.Count -eq 0) (Get-Msg $msgs 'enabled skills have SKILL.md with name and description') $ev))

    # SKILL-ORPHAN (info): disabledSkills entries that name no skill folder. Its own stable ID, so the analyst can
    # key findings on it; it is always emitted (pass when there are no orphans) and never changes the exit code.
    $folderNames = @($skillFolders | ForEach-Object { $_.Name })
    $orphans = @($disabled | Where-Object { $folderNames -notcontains $_ })
    $orphanEv = @()
    $orphanMsg = 'every disabledSkills entry has a folder'
    if ($orphans.Count -gt 0) {
        $settingsLines = [IO.File]::ReadAllLines($settingsPath)
        $orphanEv = @(New-Ev 'settings.json' (Get-LineNo $settingsLines 'disabledSkills'))
        $orphanMsg = "disabledSkills entries without a folder: $($orphans -join ', ')"
    }
    $checks.Add((New-Check 'SKILL-ORPHAN' 'info' 'settings.json disabledSkills' ($orphans.Count -eq 0) $orphanMsg $orphanEv))

    # ---- SET-EXT ----
    $ev = @(); $msgs = @()
    $settingsLines = if (Test-Path -LiteralPath $settingsPath -PathType Leaf) { [IO.File]::ReadAllLines($settingsPath) } else { @() }
    if (-not $settingsRead.ok) {
        $ev += New-Ev 'settings.json' 1
        $msgs += 'settings.json is missing or does not parse'
    }
    else {
        if ($settings.enabledFeatureFlags.EXTENSIONS -ne $true) {
            $ev += New-Ev 'settings.json' (Get-LineNo $settingsLines 'EXTENSIONS')
            $msgs += 'enabledFeatureFlags.EXTENSIONS is not true'
        }
        if ([string]::IsNullOrWhiteSpace([string]$settings.extensions.mode)) {
            $ev += New-Ev 'settings.json' (Get-LineNo $settingsLines '"extensions"')
            $msgs += 'extensions.mode is not set'
        }
        $statusCmd = [string]$settings.statusLine.command
        $tok = [regex]::Match($statusCmd, $scriptPattern)
        if (-not $tok.Success) {
            $ev += New-Ev 'settings.json' (Get-LineNo $settingsLines 'statusLine')
            $msgs += 'statusLine.command names no script'
        }
        elseif (-not (Test-Path -LiteralPath (Resolve-Target ($tok.Value)) -PathType Leaf)) {
            $ev += New-Ev 'settings.json' (Get-LineNo $settingsLines 'statusLine')
            $msgs += 'statusLine target script is missing'
        }
    }
    $checks.Add((New-Check 'SET-EXT' 'error' 'settings.json extensions and statusLine' ($ev.Count -eq 0) (Get-Msg $msgs 'extensions enabled, mode set, statusLine target exists') $ev))

    # ---- JSON-VALID ----
    $ev = @(); $msgs = @()
    $jsonFiles = @()
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) { $jsonFiles += [pscustomobject]@{ Full = $settingsPath; Rel = 'settings.json' } }
    foreach ($h in $hookFiles) { $jsonFiles += [pscustomobject]@{ Full = $h.FullName; Rel = "hooks/$($h.Name)" } }
    foreach ($c in $cliFiles) { $jsonFiles += [pscustomobject]@{ Full = $c.FullName; Rel = "cli-tools/$($c.Name)" } }
    if (Test-Path -LiteralPath $cachePath -PathType Leaf) { $jsonFiles += [pscustomobject]@{ Full = $cachePath; Rel = 'extensions/cache-keeper/config.json' } }
    foreach ($j in $jsonFiles) {
        if (-not (Read-JsonSafe $j.Full).ok) {
            $ev += New-Ev $j.Rel 1
            $msgs += "$($j.Rel) does not parse as JSON"
        }
    }
    $checks.Add((New-Check 'JSON-VALID' 'error' 'settings, hooks, cli-tools, cache-keeper JSON' ($ev.Count -eq 0) (Get-Msg $msgs "$($jsonFiles.Count) JSON file(s) parse") $ev))

    # ---- GIT-IGNORE ----
    $ev = @(); $msgs = @()
    foreach ($p in $gitIgnoreProbes) {
        $null = & git -C $rootFull check-ignore --no-index -q -- $p 2>$null
        $code = $LASTEXITCODE
        if ($code -eq 1) { $msgs += "not ignored: $p" }
        elseif ($code -ne 0) { $msgs += "git check-ignore failed (exit $code) for $p" }
    }
    if ($msgs.Count -gt 0) { $ev += New-Ev '.gitignore' 1 }
    $checks.Add((New-Check 'GIT-IGNORE' 'error' 'runtime paths are git-ignored' ($ev.Count -eq 0) (Get-Msg $msgs 'all runtime probe paths are ignored') $ev))

    # ---- GIT-TRACKED-SENSITIVE (names only, never opened) ----
    $ev = @(); $msgs = @()
    $tracked = @(& git -C $rootFull ls-files 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $ev += New-Ev '.' 1
        $msgs += 'git ls-files failed'
    }
    else {
        foreach ($t in $tracked) {
            if ($t -like 'mcp-secrets/*' -or $trackedSensitiveFiles -contains $t) {
                $ev += New-Ev $t 1
                $msgs += "tracked secret-adjacent file (name only): $t"
            }
        }
    }
    $checks.Add((New-Check 'GIT-TRACKED-SENSITIVE' 'warn' 'git-tracked secret-adjacent files' ($ev.Count -eq 0) (Get-Msg $msgs 'no secret-adjacent files are tracked') $ev))

    # ---- output ----
    $list = $checks.ToArray()
    $pass = @($list | Where-Object { $_.status -eq 'pass' }).Count
    $fail = @($list | Where-Object { $_.status -eq 'fail' -and $_.severity -eq 'error' }).Count
    $warn = @($list | Where-Object { $_.status -eq 'fail' -and $_.severity -eq 'warn' }).Count
    $ok = ($fail -eq 0)
    $result = [pscustomobject]@{
        ok          = $ok
        root        = $rootFull
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        summary     = [pscustomobject]@{ pass = $pass; fail = $fail; warn = $warn }
        checks      = $list
    }
    $result | ConvertTo-Json -Depth 8
    if ($ok) { exit 0 } else { exit 1 }
}
catch {
    [Console]::Error.WriteLine("setup-check: internal error: $($_.Exception.Message)")
    exit 2
}
