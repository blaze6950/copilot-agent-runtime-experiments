# Section builder: shared rules (subagent-context/shared-rules.md). Dot-sourced after Common.ps1.

# Returns $null when the file does not exist (nothing to inject).
function Get-SharedRulesSection([string] $CopilotHome) {
    $file = Join-Path $CopilotHome 'subagent-context/shared-rules.md'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    New-Section -Text (Read-Text $file).Trim() -Notes 'common'
}
