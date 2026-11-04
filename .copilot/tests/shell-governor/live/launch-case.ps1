# Launcher of ONE live-test copilot session. Started by live-common.ps1 (Invoke-LiveSession) as its own pwsh process, so the
# harness can stop the whole process tree by PID. Runs only inside the scratch project, always with --allow-all.
#   interactive: visible window, `copilot -i <prompt>`. Nobody types; the case ends on DONE or by the harness timeout.
#   headless:    hidden window, `copilot -p <prompt>` with GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true and --no-ask-user.
#                With no UI an ASK cannot be answered, so the CLI resolves it (the case checks how).
param(
    [Parameter(Mandatory)][string]$ProjectDir,
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][ValidateSet('interactive', 'headless')][string]$Mode,
    [string]$OutFile
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectDir
$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.UTF8Encoding]::new($false))
if ($Mode -eq 'interactive') {
    $host.UI.RawUI.WindowTitle = 'SHELL-GOVERNOR LIVE TEST - do not type'
    copilot --model claude-haiku-5.5 --allow-all -i $prompt
}
else {
    $env:GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS = 'true'
    copilot --model claude-haiku-5.5 --allow-all --no-ask-user -p $prompt *> $OutFile
}
