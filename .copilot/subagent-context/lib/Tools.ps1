# Section builder: CLI tools and rules from cli-tools/_shell.json + cli-tools/<agent>.json. Dot-sourced after Common.ps1.

# Returns $null when the agent has no cli-tools json or none of its tools is installed. Output format is
# "## CLI tools (injected by hook for <agent>, N available)" followed by "### CLI rules".
function Get-ToolsSection([string] $CopilotHome, [string] $Agent) {
    $dir = Join-Path $CopilotHome 'cli-tools'
    $agentFile = Join-Path $dir "$Agent.json"
    if (-not (Test-Path -LiteralPath $agentFile)) { return $null }

    $cfg = Read-Text $agentFile | ConvertFrom-Json
    $sources = @()
    $shellFile = Join-Path $dir '_shell.json'
    $includeShell = $null -eq $cfg.IncludeShell -or [bool]$cfg.IncludeShell
    if ($includeShell -and (Test-Path -LiteralPath $shellFile)) { $sources += (Read-Text $shellFile | ConvertFrom-Json) }
    $sources += $cfg

    $tools = [ordered]@{}
    $rules = [System.Collections.Generic.List[string]]::new()
    foreach ($s in $sources) {
        foreach ($r in @($s.Rules)) { if ($r) { $rules.Add([string]$r) } }
        foreach ($t in @($s.CliTools)) { if ($t.Name) { $tools[[string]$t.Name] = $t } }
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $missingNames = [System.Collections.Generic.List[string]]::new()
    foreach ($t in $tools.Values) {
        $path = (Get-Command $t.Name -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $path -and $t.PathHint -and (Test-Path -LiteralPath $t.PathHint)) { $path = $t.PathHint }
        if (-not $path) { $missingNames.Add([string]$t.Name); continue }
        $access = if ($t.Access) { " [$($t.Access)]" } else { '' }
        $lines.Add("- ``$($t.Name)``$access ($path): $($t.UseCase)")
    }
    $warnings = @()
    if ($missingNames.Count -gt 0) { $warnings = @("tools not installed: $($missingNames -join ', ')") }
    if ($lines.Count -eq 0) { return New-Section -Text '' -Notes @() -Warnings $warnings -Missing $missingNames.Count }

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine("## CLI tools (injected by hook for $Agent, $($lines.Count) available)")
    foreach ($l in $lines) { [void]$sb.AppendLine($l) }
    if ($rules.Count -gt 0) {
        [void]$sb.AppendLine()
        [void]$sb.AppendLine('### CLI rules')
        foreach ($r in $rules) { [void]$sb.AppendLine("- $r") }
    }
    New-Section -Text $sb.ToString().Trim() -Notes "$($lines.Count) tools" -Warnings $warnings -Missing $missingNames.Count
}
