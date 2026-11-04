# Section builder: "## Session" block with id, folder, events and reports folder. Dot-sourced after Common.ps1.

# Needs sessionId and transcriptPath; returns $null when either is missing. A transcriptPath without a directory part
# throws (the caller skips the section). The hook creates the reports folder because agents without a shell cannot;
# a failure to create it is only a warning, the block is still emitted.
function Get-SessionSection($Payload) {
    $sessionId = [string]$Payload.sessionId
    $transcriptPath = [string]$Payload.transcriptPath
    if (-not $sessionId -or -not $transcriptPath) { return $null }

    $folder = Split-Path -Parent $transcriptPath
    if (-not $folder) { throw 'transcriptPath has no directory part' }
    $reports = Join-Path $folder 'files\reports'
    $warnings = @()
    try { New-Item -ItemType Directory -Force -Path $reports | Out-Null }
    catch { $warnings += "cannot create ${reports}: $($_.Exception.Message)" }

    $text = @('## Session', "- id: $sessionId", "- folder: $folder", "- events: $transcriptPath", "- reports: $reports") -join "`n"
    New-Section -Text $text -Notes 'session' -Warnings $warnings
}
