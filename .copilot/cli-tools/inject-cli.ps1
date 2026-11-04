# TEMPORARY compatibility shim: CLI sessions started before the subagent-context switch still run the cached hooks\cli-tools.json registration. Remove after every CLI session has been restarted.
& (Join-Path $PSScriptRoot '..\subagent-context\inject.ps1')
exit 0
