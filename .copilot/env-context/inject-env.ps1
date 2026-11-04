# sessionStart hook: injects environment context (known directories, cwd/git info, bounded cwd tree) into the root session.
# Config: env.json beside this script. Skips resumed sessions and subagents. Never fails the session: always exits 0.
# Output: one progress line (cyan unless NO_COLOR, see hook-ui/HookUi.ps1) and the additionalContext line.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$log = Join-Path $dir 'inject.log'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$uiProblem = $null
try { . (Join-Path (Split-Path -Parent $dir) 'hook-ui/HookUi.ps1') }
catch { $uiProblem = $_.Exception.Message -replace '[\r\n]+', ' '; function Format-HookMessage([string] $Message) { $Message } }
function Progress([string]$m) { Write-Output (@{ type = 'progress'; message = (Format-HookMessage $m) } | ConvertTo-Json -Compress) }
function Expand([string]$p) { [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\') }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($payload.agentId -or $payload.parentAgentId) { exit 0 }
    if ([string]$payload.source -eq 'resume') { exit 0 }
    $cfgFile = Join-Path $dir 'env.json'
    if (-not (Test-Path -LiteralPath $cfgFile)) { exit 0 }
    $cfg = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json
    $cwd = if ($payload.cwd) { [string]$payload.cwd } else { (Get-Location).Path }

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('## Environment context (injected by sessionStart hook)')
    foreach ($f in @($cfg.Facts)) { if ($f) { [void]$sb.AppendLine("- $f") } }
    [void]$sb.AppendLine("- Working directory: ``$cwd``")

    $gitRoot = $null
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $gitRoot = (& git -C $cwd rev-parse --show-toplevel 2>$null) | Select-Object -First 1
        if ($LASTEXITCODE -ne 0) { $gitRoot = $null }
    }
    if ($gitRoot) {
        $branch = (& git -C $cwd rev-parse --abbrev-ref HEAD 2>$null) | Select-Object -First 1
        [void]$sb.AppendLine("- Git repo root: ``$($gitRoot -replace '/', '\')`` (branch: $branch)")
    }

    $dirs = [System.Collections.Generic.List[string]]::new()
    foreach ($k in @($cfg.Directories)) {
        $p = Expand ([string]$k.Path)
        if ($p -and (Test-Path -LiteralPath $p)) { $dirs.Add("- $($k.Name) (``$p``): $($k.Description)") }
    }
    if ($dirs.Count -gt 0) {
        [void]$sb.AppendLine()
        [void]$sb.AppendLine('### Known directories')
        foreach ($l in $dirs) { [void]$sb.AppendLine($l) }
    }

    $treeEntries = 0
    $treeBuilt = $false
    $t = $cfg.Tree
    if ($t -and $t.Enabled) {
        $cwdNorm = (Expand $cwd).TrimEnd('\')
        $skip = @($t.SkipFor | ForEach-Object { Expand ([string]$_) }) + @([System.IO.Path]::GetPathRoot($cwdNorm).TrimEnd('\'))
        if (-not ($skip -contains $cwdNorm)) {
            $treeBuilt = $true
            $maxDepth = [int]$t.MaxDepth; $maxEntries = [int]$t.MaxEntries; $timeout = [int]$t.TimeoutSeconds
            $exclude = [System.Collections.Generic.HashSet[string]]::new([string[]]@($t.Exclude), [StringComparer]::OrdinalIgnoreCase)
            $entries = @{}
            $treeSw = [System.Diagnostics.Stopwatch]::StartNew()
            if ($gitRoot) {
                $rel = (& git -C $cwd ls-files --cached --others --exclude-standard 2>$null) | Select-Object -First 50000
                foreach ($path in $rel) {
                    $segs = $path -split '/'
                    if ($segs | Where-Object { $exclude.Contains($_) }) { continue }
                    $n = [Math]::Min($segs.Count, $maxDepth)
                    for ($i = 1; $i -le $n; $i++) { $entries[($segs[0..($i - 1)] -join '/')] = ($i -lt $segs.Count) }
                }
            }
            else {
                $walk = $null
                $walk = {
                    param($path, $prefix, $depth)
                    if ($depth -gt $maxDepth -or $treeSw.Elapsed.TotalSeconds -gt $timeout) { return }
                    foreach ($e in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
                        $name = [System.IO.Path]::GetFileName($e)
                        if ($exclude.Contains($name)) { continue }
                        $isDir = [System.IO.Directory]::Exists($e)
                        $key = if ($prefix) { "$prefix/$name" } else { $name }
                        $entries[$key] = $isDir
                        if ($isDir) { & $walk $e $key ($depth + 1) }
                    }
                }
                & $walk $cwd '' 1
            }
            $keys = [string[]]@($entries.Keys | ForEach-Object { $_ })
            [Array]::Sort($keys, [Comparison[string]]{ param($a, $b) [string]::CompareOrdinal($a.Replace('/', [string][char]0), $b.Replace('/', [string][char]0)) })
            $treeEntries = @($keys).Count
            $shown = @($keys | Select-Object -First $maxEntries)
            if ($shown.Count -gt 0) {
                [void]$sb.AppendLine()
                [void]$sb.AppendLine("### Working directory tree (depth $maxDepth, git-aware, build/vendor dirs omitted)")
                [void]$sb.AppendLine('```')
                foreach ($k in $shown) {
                    $segs = $k -split '/'
                    $suffix = if ($entries[$k]) { '/' } else { '' }
                    [void]$sb.AppendLine(('  ' * ($segs.Count - 1)) + $segs[-1] + $suffix)
                }
                if ($treeEntries -gt $shown.Count) { [void]$sb.AppendLine("... +$($treeEntries - $shown.Count) more") }
                [void]$sb.AppendLine('```')
            }
        }
    }

    Progress ('env context: {0} dirs, {1}, {2} ms' -f $dirs.Count, $(if ($treeBuilt) { "$treeEntries entries" } else { 'no tree' }), [int]$sw.Elapsed.TotalMilliseconds)
    Write-Output (@{ additionalContext = $sb.ToString().TrimEnd() } | ConvertTo-Json -Compress)
    $logLine = "{0:s} cwd={1}; dirs={2}; tree={3}; {4}ms" -f (Get-Date), $cwd, $dirs.Count, $treeEntries, [int]$sw.Elapsed.TotalMilliseconds
    if ($uiProblem) { $logLine += "; ui=$uiProblem" }
    Add-Content -LiteralPath $log -Value $logLine
}
catch {
    try { Add-Content -LiteralPath $log -Value ("{0:s} ERROR: {1}" -f (Get-Date), $_.Exception.Message) } catch {}
}
exit 0

