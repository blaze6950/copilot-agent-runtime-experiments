# Shared helpers for subagent-context/inject.ps1. Dot-sourced; defines functions only.

# Copilot home folder. COPILOT_HOME_OVERRIDE is a test hook; the default is the parent of subagent-context/.
function Get-CopilotHome {
    if ($env:COPILOT_HOME_OVERRIDE) { return $env:COPILOT_HOME_OVERRIDE }
    return Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Read-Text([string] $Path) {
    [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

# Appends one line to subagent-context/inject.log. Never throws: logging must not stop the hook.
function Write-Log([string] $Message) {
    try {
        $logFile = Join-Path (Get-CopilotHome) 'subagent-context/inject.log'
        $line = '{0:s} {1}' -f (Get-Date), ($Message -replace '[\r\n]+', ' ')
        Add-Content -LiteralPath $logFile -Value $line
    }
    catch { }
}

# Result of a section builder. Text is the markdown block; Notes feed the progress message; Warnings go to the log;
# Missing counts tools that are not installed.
function New-Section([string] $Text, [string[]] $Notes, [string[]] $Warnings = @(), [int] $Missing = 0) {
    [pscustomobject]@{ Text = $Text; Notes = @($Notes); Warnings = @($Warnings | Where-Object { $_ }); Missing = $Missing }
}

# Repository root: the nearest folder at or above the payload's workingDirectory (else cwd, else the current
# location) that contains a ".git" folder or file (a git worktree has a ".git" file). No git process is started.
function Find-RepoRoot($Payload) {
    $start = @($Payload.workingDirectory, $Payload.cwd) |
        Where-Object { $_ -and (Test-Path -LiteralPath ([string]$_) -PathType Container) } |
        Select-Object -First 1
    if (-not $start) { $start = (Get-Location).Path }
    $dir = [System.IO.Path]::GetFullPath([string]$start)
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return [System.IO.Path]::TrimEndingDirectorySeparator($dir) }
        $dir = [System.IO.Path]::GetDirectoryName($dir)
    }
    return $null
}
