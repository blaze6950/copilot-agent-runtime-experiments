# Section builders for code roles: "## Conventions" and "## Repository instructions", both driven by
# conventions/profiles.json. Dot-sourced after Common.ps1.

# Files matching a repoInstructions glob such as ".github/instructions/**/*.instructions.md"
# (full paths, deterministic order). Base folder = leading segments without wildcards; "**" means recurse.
function Get-GlobFiles([string] $Root, [string] $Glob) {
    $segments = @($Glob -split '[\\/]' | Where-Object { $_ })
    if ($segments.Count -eq 0) { return @() }
    $baseSegments = @()
    if ($segments.Count -gt 1) {
        foreach ($s in $segments[0..($segments.Count - 2)]) { if ($s -match '[*?]') { break }; $baseSegments += $s }
    }
    $base = if ($baseSegments.Count) { Join-Path $Root ($baseSegments -join [System.IO.Path]::DirectorySeparatorChar) } else { $Root }
    if (-not (Test-Path -LiteralPath $base -PathType Container)) { return @() }
    $leaf = $segments[-1]
    $recurse = $Glob -match '\*\*'
    $found = Get-ChildItem -LiteralPath $base -Filter $leaf -File -Recurse:$recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like $leaf }
    return @($found | ForEach-Object { $_.FullName } | Sort-Object)
}

# Profiles and repository root for a code role; $null for every other agent. No profiles.json = no code roles.
# Throws when profiles.json cannot be parsed (the caller skips both sections). Called once per invocation.
function Get-CodeRoleContext($Payload, [string] $Agent, [string] $CopilotHome) {
    $profilesFile = Join-Path $CopilotHome 'conventions\profiles.json'
    if (-not (Test-Path -LiteralPath $profilesFile)) { return $null }
    $profiles = Read-Text $profilesFile | ConvertFrom-Json
    if (@($profiles.codeRoles) -notcontains $Agent) { return $null }
    [pscustomobject]@{ Profiles = $profiles; Root = Find-RepoRoot $Payload }
}

function Test-PackMatches($Pack, [string] $Root) {
    $markers = @($Pack.markers)
    if ($markers.Count -eq 0) { return $true }
    if (-not $Root) { return $false }
    foreach ($marker in $markers) {
        $hit = Get-ChildItem -LiteralPath $Root -Filter $marker -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like $marker } | Select-Object -First 1
        if ($hit) { return $true }
    }
    return $false
}

function Get-ConventionsSection($Context, [string] $CopilotHome) {
    if ($null -eq $Context) { return $null }
    $context = $Context

    $packTexts = [System.Collections.Generic.List[string]]::new()
    $notes = [System.Collections.Generic.List[string]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    foreach ($pack in @($context.Profiles.packs)) {
        if (-not (Test-PackMatches $pack $context.Root)) { continue }
        $packFile = Join-Path $CopilotHome "conventions\$($pack.file)"
        if (Test-Path -LiteralPath $packFile) { $packTexts.Add((Read-Text $packFile).Trim()); $notes.Add("pack:$($pack.id)") }
        else { $warnings.Add("pack file missing: $($pack.file)") }
    }
    if ($packTexts.Count -eq 0) { return $null }
    New-Section -Text ("## Conventions`n`n" + ($packTexts -join "`n`n")) -Notes $notes -Warnings $warnings
}

# Instruction files per the profile switches (rootFilesMode / githubMode = "inject"), injected in priority order until
# the size cap is reached; the remaining files are listed by path. The cap counts the injected text of each file in
# UTF-8 bytes, including its "### <path>" header line.
function Get-RepoInstructionsSection($Context, [string] $CopilotHome) {
    if ($null -eq $Context -or -not $Context.Root) { return $null }
    $settings = $Context.Profiles.repoInstructions
    if ($null -eq $settings) { return $null }
    $root = $Context.Root

    $files = [System.Collections.Generic.List[string]]::new()
    if ($settings.rootFilesMode -eq 'inject') {
        foreach ($f in @($settings.rootFiles)) {
            $p = Join-Path $root ([string]$f)
            if (Test-Path -LiteralPath $p -PathType Leaf) { $files.Add($p) }
        }
    }
    if ($settings.githubMode -eq 'inject' -and $settings.githubGlob) {
        foreach ($p in (Get-GlobFiles $root ([string]$settings.githubGlob))) { $files.Add($p) }
    }
    if ($files.Count -eq 0) { return $null }

    # The cap counts, per file, the UTF-8 bytes of "### <relative path>", a blank line and the trimmed content.
    # It does not count the "## Repository instructions" heading, the separators between files or the
    # "Not injected" list. Files are read only while the cap is not reached; after the first file that does not
    # fit, the remaining files are listed by path without being read.
    $maxBytes = if ($settings.maxBytes) { [long]$settings.maxBytes } else { 32768 }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $usedBytes = 0L; $capped = $false
    $injected = [System.Collections.Generic.List[string]]::new()
    $listed = [System.Collections.Generic.List[string]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    foreach ($p in $files) {
        if ($capped) { $listed.Add("- $p"); continue }
        $relative = $p.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        try { $text = "### $relative`n`n" + (Read-Text $p).Trim() }
        catch { $warnings.Add("cannot read ${p}: $($_.Exception.Message)"); $listed.Add("- $p"); continue }
        $textBytes = $utf8.GetByteCount($text)
        # strict priority order: the first file that does not fit stops injection
        if (($usedBytes + $textBytes) -le $maxBytes) { $injected.Add($text); $usedBytes += $textBytes }
        else { $capped = $true; $listed.Add("- $p") }
    }

    $blocks = [System.Collections.Generic.List[string]]::new()
    $blocks.Add('## Repository instructions')
    foreach ($i in $injected) { $blocks.Add($i) }
    if ($listed.Count -gt 0) {
        $blocks.Add("### Not injected (size cap $maxBytes bytes or unreadable); read these files on demand`n`n" + ($listed -join "`n"))
    }
    New-Section -Text ($blocks -join "`n`n") -Notes "instructions:$($injected.Count)+$($listed.Count)listed" -Warnings $warnings
}
