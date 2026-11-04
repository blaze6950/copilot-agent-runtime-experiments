# SubagentStart hook: injects shared rules, session info, CLI tool knowledge, convention packs and repo instructions
# as additionalContext. Section order: shared rules; "## Session" (every agent); CLI tools + rules (agents that have a
# cli-tools\<agent>.json); for code roles "## Conventions" and "## Repository instructions" (see lib\Conventions.ps1).
# Each section is built in its own try/catch: a failing section is skipped and logged, the others are still emitted.
# Only an unreadable payload or an invalid agent name emits nothing.
# Stdout contract: one progress line {"type":"progress",...} (message in ANSI cyan unless NO_COLOR, see hook-ui\HookUi.ps1)
# then {"additionalContext":"..."} (both pure ASCII JSON).
# Never fails the subagent: always exits 0. Exactly one line is appended to subagent-context\inject.log per run.
# Test hook: COPILOT_HOME_OVERRIDE replaces the copilot home folder (default: parent of subagent-context\).
$ErrorActionPreference = 'Stop'
$skipped = [System.Collections.Generic.List[string]]::new()
$problems = [System.Collections.Generic.List[string]]::new()

# Minimal fallback used only when lib\Common.ps1 cannot be loaded (Common.ps1 redefines it): the run must still
# write its one log line. Never throws.
function Write-Log([string] $Message) {
    try {
        $home_ = if ($env:COPILOT_HOME_OVERRIDE) { $env:COPILOT_HOME_OVERRIDE } else { Split-Path -Parent $PSScriptRoot }
        Add-Content -LiteralPath (Join-Path $home_ 'subagent-context/inject.log') -Value ('{0:s} {1}' -f (Get-Date), ($Message -replace '[\r\n]+', ' '))
    }
    catch { }
}

# Common.ps1 is the only hard dependency: without it nothing can be built, so log once and stop.
try { . (Join-Path $PSScriptRoot 'lib/Common.ps1') }
catch { Write-Log "ERROR: lib/Common.ps1 not loaded: $($_.Exception.Message)"; exit 0 }

# Every other module is optional: a module that fails to load only skips its own section(s).
foreach ($module in 'Shared', 'Session', 'Tools', 'Conventions') {
    try { . (Join-Path $PSScriptRoot "lib/$module.ps1") }
    catch { $problems.Add("module ${module}.ps1 not loaded: $($_.Exception.Message)") }
}
# The shared output rule (cyan progress line unless NO_COLOR) is optional too: without it the progress line stays plain.
try { . (Join-Path (Split-Path -Parent $PSScriptRoot) 'hook-ui/HookUi.ps1') }
catch { $problems.Add("module HookUi.ps1 not loaded: $($_.Exception.Message)"); function Format-HookMessage([string] $Message) { $Message } }

$copilotHome = Get-CopilotHome

# Runs one section builder; a failure (including a builder whose module did not load) skips only that section.
function Invoke-Section([string] $Name, [scriptblock] $Build) {
    try { return (& $Build) }
    catch {
        $skipped.Add($Name)
        $problems.Add("section ${Name} skipped: $($_.Exception.Message)")
        return $null
    }
}

# Reads the hook payload from stdin (UTF-8). Throws when it is not JSON.
function Read-HookPayload {
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
    return ($reader.ReadToEnd() | ConvertFrom-Json)
}

# Escapes non-ASCII so the output survives any console code page; the JSON stays valid.
function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress
    return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

$logMessage = 'ERROR: unexpected failure'
try {
    $payload = $null
    try { $payload = Read-HookPayload } catch { $logMessage = "SKIP: unreadable payload: $($_.Exception.Message)"; return }
    $agent = [string]$payload.agentName
    if ([string]::IsNullOrWhiteSpace($agent) -or $agent -notmatch '^[\w.-]+$') { $logMessage = 'SKIP: missing or invalid agentName'; return }

    # profiles.json and the repository root are resolved once; both code-role sections share the result (or its failure)
    $codeRoleContext = $null; $codeRoleFailure = $null
    try { $codeRoleContext = Get-CodeRoleContext $payload $agent $copilotHome } catch { $codeRoleFailure = $_ }

    $sections = @(
        (Invoke-Section 'shared-rules' { Get-SharedRulesSection $copilotHome }),
        (Invoke-Section 'session' { Get-SessionSection $payload }),
        (Invoke-Section 'tools' { Get-ToolsSection $copilotHome $agent }),
        (Invoke-Section 'conventions' { if ($codeRoleFailure) { throw $codeRoleFailure.Exception }; Get-ConventionsSection $codeRoleContext $copilotHome }),
        (Invoke-Section 'instructions' { if ($codeRoleFailure) { throw $codeRoleFailure.Exception }; Get-RepoInstructionsSection $codeRoleContext $copilotHome })
    ) | Where-Object { $null -ne $_ }

    $texts = @($sections | Where-Object { $_.Text } | ForEach-Object { $_.Text })
    $notes = @($sections | Where-Object { $_.Text } | ForEach-Object { $_.Notes })
    $missing = [int](($sections | Measure-Object -Property Missing -Sum).Sum)
    foreach ($w in @($sections | ForEach-Object { $_.Warnings })) { $problems.Add("warning: $w") }

    if ($texts.Count -eq 0) { $logMessage = "${agent}: nothing to inject"; return }

    $extras = @()
    if ($missing -gt 0) { $extras += "$missing tools not installed" }
    if ($skipped.Count -gt 0) { $extras += "skipped: $($skipped -join ', ')" }
    $message = "Injecting $($notes -join ', ') for $agent" + $(if ($extras.Count) { " ($($extras -join '; '))" } else { '' })
    $progressLine = ConvertTo-AsciiJson @{ type = 'progress'; message = (Format-HookMessage $message) }
    $contextLine = ConvertTo-AsciiJson @{ additionalContext = ($texts -join "`n`n") }
    Write-Output $progressLine
    Write-Output $contextLine
    $logMessage = "${agent}: $message"
}
catch { $logMessage = "ERROR: $($_.Exception.Message)" }
finally {
    if ($problems.Count -gt 0) { $logMessage += ' | ' + ($problems -join ' | ') }
    Write-Log $logMessage
}
exit 0
