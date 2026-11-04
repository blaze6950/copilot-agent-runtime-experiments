# shell-governor: persistent PowerShell "facts" worker (AST extractor v2).
# Protocol: one JSON request per stdin line, one JSON response per stdout line (flushed). Diagnostics go to stderr only.
#   {"id":1,"op":"config", ...}           -> startup configuration from the client (userHome, copilotHome, secretPatterns,
#                                            systemRoots, flagTable); answers {"id","op":"config","applied":[...]}
#   {"id":2,"op":"parse","script":"..."}  -> parse facts (errors, command names, redirections, dynamic-invocation counts)
#   {"id":3,"op":"argv","script":"...","cwd":"...","features":{"joinPath":true,"dotnetArgs":true}} -> extractor v2 facts
#   {"id":4,"op":"stats"}                 -> pid, working set, requests served, configured tool count
#   {"id":5,"op":"exit"}                  -> acknowledge and exit
# FACTS ONLY. Interpretation (classes, subcommand matching, policy) lives in the engine (lib/*.mjs). The only
# machine-specific values (user home, flag table, ...) come from the `config` request; nothing is hard-coded here.
# No network access.
param()
$ErrorActionPreference = 'Stop'
$startSw = [System.Diagnostics.Stopwatch]::StartNew()
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8NoBom)
$writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8NoBom)
$writer.AutoFlush = $true
$script:served = 0

# values from the `config` request
$script:cfgUserHome = $null
$script:cfgCopilotHome = $null
$script:cfgSecretPatterns = @()
$script:cfgSystemRoots = @()
$script:flagTable = @{}

function Send-Message([System.Collections.IDictionary]$obj) {
    $writer.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 8))
    $writer.Flush()
}

function Send-MessageDeep([System.Collections.IDictionary]$obj) {
    $writer.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 24))
    $writer.Flush()
}

function Get-UserHome {
    if (-not [string]::IsNullOrEmpty($script:cfgUserHome)) { return $script:cfgUserHome }
    return [Environment]::GetFolderPath('UserProfile')
}

# [start, end) offsets of the Comment tokens the PowerShell tokenizer found. The judge removes exactly these ranges from the
# script it shows; a `#`/`<#` inside a string, here-string or `$( )` is never a comment token, so executed code cannot be hidden.
function Get-CommentSpans($tokens) {
    $spans = New-Object System.Collections.Generic.List[object]
    foreach ($t in @($tokens)) {
        if ($t.Kind -eq [System.Management.Automation.Language.TokenKind]::Comment) {
            $spans.Add([int[]]@($t.Extent.StartOffset, $t.Extent.EndOffset))
        }
    }
    , $spans
}

# Identity of the analysed script, sent with the comment spans so that a consumer applies the offsets only to exactly this text:
# length = number of UTF-16 code units (.NET String.Length, the unit of the tokenizer offsets; JavaScript text.length),
# sha256 = lowercase hex SHA-256 of the UTF-8 bytes of the script.
function Get-ScriptIdentity([string]$source) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($source)) } finally { $sha.Dispose() }
    [ordered]@{ length = $source.Length; sha256 = ([System.BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()) }
}

function Get-Facts([int]$id, [string]$source) {
    if ($null -eq $source) { $source = '' }
    $tokens = $null
    $errors = $null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    $parseMs = $sw.Elapsed.TotalMilliseconds

    $parseErrors = @(foreach ($e in $errors) {
        [ordered]@{ message = $e.Message; line = $e.Extent.StartLineNumber; column = $e.Extent.StartColumnNumber }
    })

    $cmdAsts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))
    $dynamic = 0
    $nestedEncoded = 0
    $commands = @(foreach ($c in $cmdAsts) {
        $name = $c.GetCommandName()
        $first = $c.CommandElements[0]
        if ($null -eq $name) {
            $dynamic++
        }
        elseif ($name -match '^(iex|Invoke-Expression)$') {
            $dynamic++
        }
        elseif ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown -and
                $first -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $dynamic++
        }
        if ($null -ne $name -and $name -match '^(powershell|pwsh)(\.exe)?$') {
            foreach ($el in $c.CommandElements) {
                if ($el -is [System.Management.Automation.Language.CommandParameterAst] -and
                    $el.ParameterName -match '^(e|ec|enc|encodedcommand)$') { $nestedEncoded++ }
            }
        }
        $firstArgs = @()
        for ($i = 1; $i -lt $c.CommandElements.Count -and $firstArgs.Count -lt 5; $i++) {
            $el = $c.CommandElements[$i]
            if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
                $firstArgs += [string]$el.Value
            }
        }
        [ordered]@{ name = $name; elementCount = $c.CommandElements.Count; firstArgs = $firstArgs }
    })

    $redirs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.RedirectionAst] }, $true))
    $files = @(foreach ($r in $redirs) {
        if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) {
            $loc = $r.Location
            $target = $null
            if ($loc -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $target = [string]$loc.Value }
            [ordered]@{ append = [bool]$r.Append; target = $target }
        }
    })

    [ordered]@{
        id                      = $id
        parseErrors             = $parseErrors
        commentSpans            = (Get-CommentSpans $tokens)
        commandCount            = $cmdAsts.Count
        commands                = $commands
        redirections            = [ordered]@{ count = $redirs.Count; files = $files }
        dynamicInvocationCount  = $dynamic
        nestedEncodedShellCount = $nestedEncoded
        parseMs                 = [math]::Round($parseMs, 3)
    }
}

# alias name -> resolved command name (lower case), used to report aliases (ls, %, ...) by cmdlet name
$aliasMap = @{}
foreach ($alias in (Get-Alias)) {
    $target = [string]$alias.ResolvedCommandName
    if ([string]::IsNullOrEmpty($target)) { $target = [string]$alias.Definition }
    $aliasMap[$alias.Name.ToLowerInvariant()] = $target.ToLowerInvariant()
}

function Get-ParseCategory([string]$m) {
    if ($m -match 'Missing closing') { return 'missing-closing-token' }
    if ($m -match 'Unexpected token') { return 'unexpected-token' }
    if ($m -match 'terminator') { return 'missing-terminator' }
    if ($m -match 'Missing expression') { return 'missing-expression' }
    return 'other'
}

# ---------------- "argv" op (extractor v2) ----------------
# FACTS ONLY. For every CommandAst in source order: raw argument tokens with case preserved (params and words), constant
# values (string constants, here-strings, $env:*, $HOME, $PWD, single-assigned constant variables), the effective cwd at
# the call (Set-Location / Push-Location / Pop-Location tracked), redirections (null sinks flagged), path-parameter binding
# for cmdlets, value arity from the configured flag table, and recursive inner scripts (pwsh -Command / -EncodedCommand /
# iex literal, cmd /c literal).
$v2PathParams = @('path', 'literalpath', 'filepath', 'destination', 'outfile', 'outputfile', 'destinationpath', 'inputfile', 'pspath',
    'workingdirectory', 'root', 'configuration', 'from', 'to')
$v2FsPositional = @('get-content', 'set-content', 'add-content', 'clear-content', 'out-file', 'remove-item', 'get-childitem', 'get-item',
    'new-item', 'test-path', 'resolve-path', 'get-filehash', 'import-csv', 'export-csv', 'export-clixml', 'import-clixml', 'get-acl',
    'set-acl', 'expand-archive', 'compress-archive', 'unblock-file', 'copy-item', 'move-item', 'rename-item', 'tee-object',
    'set-location', 'push-location', 'pop-location', 'start-process', 'get-itemproperty', 'set-itemproperty', 'invoke-item', 'clear-recyclebin')
$v2TwoPathPositional = @('copy-item', 'move-item', 'rename-item', 'expand-archive', 'compress-archive')
$v2NullSinks = @('$null', '/dev/null', 'nul')
# feature switches per request (joinPath = Join-Path / Path.Combine / '+' resolution; dotnetArgs = .NET call arguments)
$script:v2J = $true
$script:v2D = $true
$v2ShellNames = @('pwsh', 'powershell', 'cmd')

function Resolve-V2Text([string]$s, [hashtable]$vars, [string]$cwd) {
    # expands $env:NAME, ${env:NAME}, $HOME, $PWD and single-assigned constant variables; any other expression -> $null
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    while ($i -lt $s.Length) {
        $ch = $s[$i]
        if ($ch -eq '`') { return $null }
        if ($ch -ne '$') { [void]$sb.Append($ch); $i++; continue }
        $m = [regex]::Match($s.Substring($i), '^\$\{?([A-Za-z_][A-Za-z0-9_:]*)\}?')
        if (-not $m.Success) { return $null }
        $name = $m.Groups[1].Value
        $val = $null
        if ($name -like 'env:*') {
            $envName = $name.Substring(4)
            # the user profile comes from the worker configuration (same source as ~ and $HOME), not from the process environment
            if ($envName -ieq 'USERPROFILE' -or $envName -ieq 'HOME') { $val = Get-UserHome } else { $val = [Environment]::GetEnvironmentVariable($envName) }
        }
        elseif ($name -ieq 'home') { $val = Get-UserHome }
        elseif ($name -ieq 'pwd') { $val = $cwd }
        elseif ($vars.ContainsKey($name)) { $val = [string]$vars[$name] }
        if ([string]::IsNullOrEmpty($val)) { return $null }
        [void]$sb.Append($val)
        $i += $m.Length
    }
    return $sb.ToString()
}

function Get-V2Word($node, [hashtable]$vars, [string]$cwd) {
    # returns @{ isConst; value; prop } for one argument expression
    if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [ordered]@{ isConst = $true; value = [string]$node.Value; prop = $false }
    }
    $raw = [string]$node.Extent.Text
    if ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        if ($raw.StartsWith('@"')) { $raw = $raw.Substring(2); $raw = $raw -replace '^\r?\n', ''; $raw = $raw -replace '\r?\n"@$', '' }
        elseif ($raw.StartsWith('"') -and $raw.EndsWith('"') -and $raw.Length -ge 2) { $raw = $raw.Substring(1, $raw.Length - 2) }
        $r = Resolve-V2Text $raw $vars $cwd
        return [ordered]@{ isConst = ($null -ne $r); value = $r; prop = $true }
    }
    if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) {
        $r = Resolve-V2Text $raw $vars $cwd
        return [ordered]@{ isConst = ($null -ne $r); value = $r; prop = $true }
    }
    if ($script:v2J -and ($node -is [System.Management.Automation.Language.ParenExpressionAst] -or
            $node -is [System.Management.Automation.Language.BinaryExpressionAst] -or
            $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst])) {
        $rv = Resolve-V2Expr $node $vars $cwd
        if ($null -ne $rv) { return [ordered]@{ isConst = $true; value = $rv; prop = $true } }
    }
    return [ordered]@{ isConst = $false; value = $null; prop = $false }
}

function Get-V2ConstVars($ast, [string]$cwd) {
    # a variable is constant when it is assigned exactly once (plain '=') from a constant expression
    $assigns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) | Sort-Object { $_.Extent.StartOffset })
    $counts = @{}
    foreach ($a in $assigns) {
        if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
            $n = [string]$a.Left.VariablePath.UserPath
            $add = 1
            if ($a.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals) { $add = 2 }
            $counts[$n] = [int]$counts[$n] + $add
        }
    }
    $vars = @{}
    foreach ($a in $assigns) {
        if (-not ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst])) { continue }
        $n = [string]$a.Left.VariablePath.UserPath
        if ([int]$counts[$n] -ne 1) { continue }
        $right = $a.Right
        $rexpr = $null
        if ($right -is [System.Management.Automation.Language.CommandExpressionAst]) { $rexpr = $right.Expression }
        elseif ($right -is [System.Management.Automation.Language.PipelineAst]) {
            $els = @($right.PipelineElements)
            if ($els.Count -eq 1 -and $els[0] -is [System.Management.Automation.Language.CommandExpressionAst]) { $rexpr = $els[0].Expression }
        }
        if ($null -eq $rexpr) {
            if ($script:v2J -and $right -is [System.Management.Automation.Language.PipelineAst]) {
                $rel = @($right.PipelineElements)
                if ($rel.Count -eq 1 -and $rel[0] -is [System.Management.Automation.Language.CommandAst]) {
                    $jv = Resolve-V2JoinCmd $rel[0] $vars $cwd
                    if ($null -ne $jv) { $vars[$n] = $jv }
                }
            }
            continue
        }
        $w = Get-V2Word $rexpr $vars $cwd
        if ($w.isConst) { $vars[$n] = $w.value }
    }
    return $vars
}

function Resolve-V2Path([string]$v, [string]$cwd) {
    # absolute path string, or $null when it cannot be resolved from the given cwd; registry / unc / url keep a prefix
    if ($null -eq $v) { return $null }
    $s = $v.Trim().Trim('"').Trim("'")
    if ($s -match '^(https?|ftp)://') { return 'url:' + $s }
    if ($s -match '^(?i)(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+)[:\\]') { return 'registry:' + $s }
    if ($s -match '^(\\\\|//)') { return 'unc:' + $s }
    if ($s -match '^~(?=[\\/]|$)') { $s = (Get-UserHome) + $s.Substring(1) }
    try {
        if ($s -match '^[A-Za-z]:') { return [IO.Path]::GetFullPath($s) }
        if ([string]::IsNullOrEmpty($cwd)) { return $null }
        if ($s -match '^[\\/]') {
            $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($cwd))
            return [IO.Path]::GetFullPath([IO.Path]::Combine($root, $s.TrimStart('\', '/')))
        }
        return [IO.Path]::GetFullPath([IO.Path]::Combine($cwd, $s))
    }
    catch { return $null }
}

function Resolve-V2JoinCmd($c, [hashtable]$vars, [string]$cwd) {
    # Join-Path with constant arguments (-Path / -ChildPath / positional); returns the combined string or $null
    if (([string]$c.GetCommandName()) -ine 'join-path') { return $null }
    $parts = New-Object System.Collections.Generic.List[string]
    $els = @($c.CommandElements)
    $pathV = $null
    $childV = $null
    for ($i = 1; $i -lt $els.Count; $i++) {
        $el = $els[$i]
        if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {
            $pn = ([string]$el.ParameterName).ToLowerInvariant()
            if ($pn -notin @('path', 'childpath') -or $i + 1 -ge $els.Count) { return $null }
            $w = Get-V2Word $els[$i + 1] $vars $cwd
            if (-not $w.isConst) { return $null }
            if ($pn -eq 'path') { $pathV = [string]$w.value } else { $childV = [string]$w.value }
            $i++
            continue
        }
        $w = Get-V2Word $el $vars $cwd
        if (-not $w.isConst) { return $null }
        $parts.Add([string]$w.value)
    }
    $all = New-Object System.Collections.Generic.List[string]
    if ($null -ne $pathV) { $all.Add($pathV) }
    foreach ($p in $parts) { $all.Add($p) }
    if ($null -ne $childV) { $all.Add($childV) }
    if ($all.Count -lt 2) { return $null }
    try {
        $acc = $all[0]
        for ($k = 1; $k -lt $all.Count; $k++) { $acc = [IO.Path]::Combine($acc, $all[$k]) }
        return $acc
    }
    catch { return $null }
}

function Resolve-V2Expr($node, [hashtable]$vars, [string]$cwd) {
    # resolvable expressions: (Join-Path ...), [IO.Path]::Combine(...), 'a' + 'b' (constants, env, HOME, PWD, assigned variables)
    if ($node -is [System.Management.Automation.Language.ParenExpressionAst]) {
        $p = $node.Pipeline
        if ($p -is [System.Management.Automation.Language.PipelineAst]) {
            $els = @($p.PipelineElements)
            if ($els.Count -eq 1) {
                if ($els[0] -is [System.Management.Automation.Language.CommandExpressionAst]) { return (Resolve-V2Expr $els[0].Expression $vars $cwd) }
                if ($els[0] -is [System.Management.Automation.Language.CommandAst]) { return (Resolve-V2JoinCmd $els[0] $vars $cwd) }
            }
        }
        return $null
    }
    if ($node -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $node.Operator -eq [System.Management.Automation.Language.TokenKind]::Plus) {
        $l = Resolve-V2Expr $node.Left $vars $cwd
        if ($null -eq $l) { $lw = Get-V2Word $node.Left $vars $cwd; if ($lw.isConst) { $l = [string]$lw.value } }
        $r = Resolve-V2Expr $node.Right $vars $cwd
        if ($null -eq $r) { $rw = Get-V2Word $node.Right $vars $cwd; if ($rw.isConst) { $r = [string]$rw.value } }
        if ($null -ne $l -and $null -ne $r) { return ($l + $r) }
        return $null
    }
    if ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        $node.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
        $tn = ([string]$node.Expression.TypeName.FullName).ToLowerInvariant()
        if ($tn -in @('io.path', 'system.io.path') -and ([string]$node.Member.Value).ToLowerInvariant() -eq 'combine') {
            $parts = New-Object System.Collections.Generic.List[string]
            foreach ($a in @($node.Arguments)) {
                $w = Get-V2Word $a $vars $cwd
                if (-not $w.isConst) { return $null }
                $parts.Add([string]$w.value)
            }
            if ($parts.Count -lt 1) { return $null }
            try {
                $acc = $parts[0]
                for ($k = 1; $k -lt $parts.Count; $k++) { $acc = [IO.Path]::Combine($acc, $parts[$k]) }
                return $acc
            }
            catch { return $null }
        }
        return $null
    }
    # other binary/paren/member expressions are not resolvable here; never fall back to Get-V2Word for them
    # (Get-V2Word calls back into Resolve-V2Expr for these node types, which would recurse without end)
    if ($node -is [System.Management.Automation.Language.BinaryExpressionAst] -or $node -is [System.Management.Automation.Language.ParenExpressionAst] -or
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) { return $null }
    $w = Get-V2Word $node $vars $cwd
    if ($w.isConst) { return [string]$w.value }
    return $null
}

function Add-V2Arity($cargs, $spec) {
    # value arity from the configured flag table (per executable): marks every flag with `takesValue` and every word with
    # `valueFor` (index in args of the flag it is the value of, else null). Mirrors the catalog's parseNative rules:
    # globalWithValue / valueFlags take the next word unless given inline (--x=v, -x:v); globalNoValue takes none;
    # POSIX tools bundle short flags (-sL): a value flag inside the bundle takes the rest of the bundle or the next word.
    $pending = -1
    for ($i = 0; $i -lt $cargs.Count; $i++) {
        $a = $cargs[$i]
        if ($a.k -eq 'word') {
            if ($pending -ge 0) { $a['valueFor'] = $pending; $pending = -1 } else { $a['valueFor'] = $null }
            continue
        }
        $pending = -1
        $a['takesValue'] = $false
        $raw = [string]$a.raw
        if ($raw -eq '--') { continue }
        $name = $raw
        $inline = $false
        $m = [regex]::Match($raw, '^(-{1,2}[^=:]+)[=:](.*)$')
        if ($m.Success) { $name = $m.Groups[1].Value; $inline = $true }
        $takes = $false
        if ($spec.gw.Contains($name)) { $takes = -not $inline }
        elseif ($spec.gn.Contains($name)) { $takes = $false }
        elseif ($spec.posix -and -not $inline -and $name -cmatch '^-[A-Za-z]{2,}$' -and -not $spec.vf.Contains($name)) {
            $letters = $name.Substring(1).ToCharArray()
            for ($j = 0; $j -lt $letters.Length; $j++) {
                if ($spec.vf.Contains('-' + $letters[$j])) { $takes = ($j -eq $letters.Length - 1); break }
            }
        }
        elseif ($inline) { $takes = $false }
        elseif ($spec.vf.Contains($name)) { $takes = $true }
        if ($takes) { $a['takesValue'] = $true; $pending = $i }
    }
}

function Get-V2Redirs($redirections, [hashtable]$vars, [string]$cwd) {
    # file redirections of one statement; $null / /dev/null / NUL are null sinks, stream merges are not file targets
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($r in $redirections) {
        if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) {
            $w = Get-V2Word $r.Location $vars $cwd
            $raw = [string]$r.Location.Extent.Text
            $isNull = ($v2NullSinks -contains $raw) -or ($w.isConst -and ($v2NullSinks -contains [string]$w.value))
            $list.Add([ordered]@{ raw = $raw; value = $w.value; isConst = $w.isConst; nullSink = $isNull; append = [bool]$r.Append })
        }
    }
    return , $list
}

# pipeline filters that pass their input through (the kind of input is decided by the element before them); ForEach-Object is listed here but always
# classified "paths" in Get-V2PipeSource (it can emit anything), and a filter with an -InputObject value is "paths" too (TFIX-8)
$v2PipeThrough = @('where-object', 'sort-object', 'select-object', 'foreach-object', 'tee-object', 'group-object', 'get-random', 'get-unique')
# Parameters of Verb-Noun cmdlets whose value is never a path (their word is not counted as a positional argument).
$v2NonPathValueParams = @('context', 'encoding', 'include', 'exclude', 'filter', 'culture', 'first', 'last', 'skip', 'tail', 'totalcount', 'delimiter', 'stream')
# Cmdlets whose output cannot be FileInfo or path items (text, parsed data, process/command/date objects, web results): "data" for the Select-String
# consumer, which reads files only for FileInfo input (verified: objects with a Path/PSPath/LiteralPath property are not bound). Anything that can emit
# FileInfo or paths (Get-ChildItem, Get-Item, Resolve-Path, ...) and every unknown cmdlet stays "paths".
# A member must never re-emit the objects it receives from the pipeline (TFIX-5 audit; Get-Random does and lives in $v2PipeThrough above, Write-Output
# without arguments is handled in Get-V2PipeSource). Each member was run as `Get-ChildItem <dir> | <member> | Select-String needle` on pwsh 7.6.7: 0 files read.
$v2PipeData = @('convertfrom-json', 'convertfrom-csv', 'convertfrom-stringdata', 'get-process', 'get-service', 'get-date', 'get-command', 'get-host',
    'get-help', 'get-module', 'get-alias', 'get-history', 'get-winevent', 'get-eventlog', 'out-string', 'format-list', 'format-table', 'measure-object',
    'invoke-restmethod', 'invoke-webrequest', 'join-path', 'split-path', 'test-path', 'get-clipboard', 'select-string')

# Parameter tables of the two pass-through cmdlets whose pipeline input can be replaced by a value (TFIX-7; pwsh 7.6.7). Kinds: 'input' = InputObject (the
# list value), 'switch' = takes no value (`-Verbose:0` is the switch's own argument, a following word is a positional value), 'value' = takes the next word
# (or its inline `:argument`). Write-Output: InputObject is ValueFromRemainingArguments, so an UNKNOWN parameter word is itself a value ("-Foo" is emitted).
$v2CommonParams = @{ verbose = 'switch'; debug = 'switch'; erroraction = 'value'; warningaction = 'value'; informationaction = 'value'; progressaction = 'value'
    errorvariable = 'value'; warningvariable = 'value'; informationvariable = 'value'; outvariable = 'value'; outbuffer = 'value'; pipelinevariable = 'value' }
$v2CommonAliases = @{ vb = 'verbose'; db = 'debug'; ea = 'erroraction'; wa = 'warningaction'; infa = 'informationaction'; ev = 'errorvariable'
    wv = 'warningvariable'; iv = 'informationvariable'; ov = 'outvariable'; ob = 'outbuffer'; pv = 'pipelinevariable' }
$v2WriteOutputParams = @{ inputobject = 'input'; noenumerate = 'switch' }
# Get-Random replaces its pipeline input only through InputObject (named, or a positional non-numeric value); every other parameter keeps the input flowing.
$v2GetRandomParams = @{ inputobject = 'input'; setseed = 'value'; minimum = 'value'; maximum = 'value'; count = 'value'; shuffle = 'switch' }
# Own parameter names (and aliases) of the pass-through filters that can have their pipeline input REPLACED by an -InputObject value (TFIX-8; pwsh 7.6.7,
# from Get-Command). Only InputObject matters (kind 'input'); the rest ('value') exists so a prefix resolves or is ambiguous exactly as PowerShell's binder
# sees it (-In on Where-Object is the -In operator, -Ind on Select-Object is -Index, -i on Select-Object / Where-Object is ambiguous). InputObject is never
# a positional parameter of these cmdlets (Position = none; probed), so only the named form (also -InputObject:value) counts.
$v2FilterParams = @{
    'where-object' = @{ inputobject = 'input'; filterscript = 'value'; property = 'value'; value = 'value'; not = 'switch'; is = 'value'; isnot = 'value'
        eq = 'value'; ieq = 'value'; ceq = 'value'; ne = 'value'; ine = 'value'; cne = 'value'; gt = 'value'; igt = 'value'; cgt = 'value'
        lt = 'value'; ilt = 'value'; clt = 'value'; ge = 'value'; ige = 'value'; cge = 'value'; le = 'value'; ile = 'value'; cle = 'value'
        like = 'value'; ilike = 'value'; clike = 'value'; notlike = 'value'; inotlike = 'value'; cnotlike = 'value'; match = 'value'; imatch = 'value'
        cmatch = 'value'; notmatch = 'value'; inotmatch = 'value'; cnotmatch = 'value'; contains = 'value'; icontains = 'value'; ccontains = 'value'
        notcontains = 'value'; inotcontains = 'value'; cnotcontains = 'value'; in = 'value'; iin = 'value'; cin = 'value'; notin = 'value'; inotin = 'value'; cnotin = 'value' }
    'sort-object' = @{ inputobject = 'input'; property = 'value'; descending = 'switch'; unique = 'switch'; culture = 'value'; casesensitive = 'switch'
        stable = 'switch'; top = 'value'; bottom = 'value' }
    'select-object' = @{ inputobject = 'input'; property = 'value'; excludeproperty = 'value'; expandproperty = 'value'; unique = 'switch'; caseinsensitive = 'switch'
        last = 'value'; first = 'value'; skip = 'value'; wait = 'switch'; skiplast = 'value'; index = 'value'; skipindex = 'value' }
    'tee-object' = @{ inputobject = 'input'; filepath = 'value'; path = 'value'; append = 'switch'; encoding = 'value'; literalpath = 'value'; pspath = 'value'; lp = 'value'; variable = 'value' }
    'group-object' = @{ inputobject = 'input'; property = 'value'; noelement = 'switch'; ashashtable = 'switch'; aht = 'switch'; asstring = 'switch'; culture = 'value'; casesensitive = 'switch' }
    'get-unique' = @{ inputobject = 'input'; asstring = 'switch'; caseinsensitive = 'switch'; ontype = 'switch' }
}

function Resolve-V2ParamKind([string]$name, [hashtable]$own) {
    # Kind of a parameter word as PowerShell's own binder reads it: an exact name or alias first, then a unique prefix; the cmdlet's own parameters win over
    # the common ones (verified on 7.6.7: -i and -in are InputObject although InformationAction/InformationVariable also start with "i"; -inf, -e, -o, -w, -p are
    # ambiguous). Returns 'input' | 'switch' | 'value' | 'ambiguous' | 'unknown'.
    $n = $name.ToLowerInvariant()
    if ($n.Length -eq 0) { return 'unknown' }
    if ($own.ContainsKey($n)) { return [string]$own[$n] }
    if ($v2CommonAliases.ContainsKey($n)) { return [string]$v2CommonParams[[string]$v2CommonAliases[$n]] }
    if ($v2CommonParams.ContainsKey($n)) { return [string]$v2CommonParams[$n] }
    $hits = @($own.Keys | Where-Object { ([string]$_).StartsWith($n) })
    if ($hits.Count -eq 1) { return [string]$own[[string]$hits[0]] }
    if ($hits.Count -gt 1) { return 'ambiguous' }
    $common = New-Object System.Collections.Generic.HashSet[string]
    foreach ($k in $v2CommonParams.Keys) { if (([string]$k).StartsWith($n)) { [void]$common.Add([string]$k) } }
    foreach ($k in $v2CommonAliases.Keys) { if (([string]$k).StartsWith($n)) { [void]$common.Add([string]$v2CommonAliases[$k]) } }
    if ($common.Count -eq 1) { return [string]$v2CommonParams[@($common)[0]] }
    if ($common.Count -gt 1) { return 'ambiguous' }
    return 'unknown'
}

function Test-V2ConstWord($node) {
    return ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) -or ($node -is [System.Management.Automation.Language.ConstantExpressionAst])
}

function Test-V2RandomHasValue($cmdAst) {
    # Get-Random re-emits its pipeline input unless it receives a list value: -InputObject (any prefix PowerShell binds to it, also -InputObject:(...)) or a
    # positional non-numeric word emits the elements of that value instead (possibly FileInfo): the caller then reports 'paths'. A word after a parameter that
    # takes a value (-Count 3, -ErrorAction Stop) is that argument; a word after a switch (-Verbose, -Shuffle), an unknown or an ambiguous parameter is a
    # positional value (the conservative reading); a positional number is -Maximum/-Minimum.
    $pending = $false
    for ($m = 1; $m -lt $cmdAst.CommandElements.Count; $m++) {
        $ce = $cmdAst.CommandElements[$m]
        if ($ce -is [System.Management.Automation.Language.CommandParameterAst]) {
            $kind = Resolve-V2ParamKind ([string]$ce.ParameterName) $v2GetRandomParams
            if ($kind -eq 'input') { return $true }
            $pending = ($kind -eq 'value' -and $null -eq $ce.Argument)
            continue
        }
        if ($pending) { $pending = $false; continue }
        if ($ce -is [System.Management.Automation.Language.ConstantExpressionAst] -and $ce.Value -is [ValueType]) { continue }
        return $true
    }
    return $false
}

function Test-V2FilterHasInputObject($cmdAst, [string]$cmdlet) {
    # TFIX-8: Where-Object, Sort-Object, Select-Object, Tee-Object, Group-Object and Get-Unique emit the value of -InputObject instead of their pipeline input
    # (any prefix PowerShell binds to it, the colon form too; an ambiguous prefix is treated like InputObject, the conservative reading). The engine's own
    # pass-through walk (PIPE_PASS_THROUGH in lib/engine.mjs) is a different question (does a recursive listing reach a reader) and needs no such rule.
    $table = $v2FilterParams[$cmdlet]
    if ($null -eq $table) { return $false }
    for ($m = 1; $m -lt $cmdAst.CommandElements.Count; $m++) {
        $ce = $cmdAst.CommandElements[$m]
        if ($ce -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
        $kind = Resolve-V2ParamKind ([string]$ce.ParameterName) $table
        if ($kind -eq 'input' -or $kind -eq 'ambiguous') { return $true }
    }
    return $false
}

function Get-V2WriteOutputKind($el) {
    # 'pass' when Write-Output re-emits its pipeline input (no value), else the kind of its value: 'data' for constant text only, 'paths' when a variable or
    # expression may hold FileInfo objects. Only InputObject (also -i / -in / -inp ...), a positional word or an unknown parameter word (see above) is a value;
    # switches and common parameters, with or without a value (-Verbose:0, -NoEnumerate:$false, -ErrorAction Stop), leave Write-Output a pass-through.
    # An ambiguous prefix (-e, -o) makes the call fail in PowerShell: 'paths' (the conservative kind).
    $hasValue = $false
    $allConst = $true
    $pending = $false
    for ($m = 1; $m -lt $el.CommandElements.Count; $m++) {
        $ce = $el.CommandElements[$m]
        if ($ce -is [System.Management.Automation.Language.CommandParameterAst]) {
            $pending = $false
            $kind = Resolve-V2ParamKind ([string]$ce.ParameterName) $v2WriteOutputParams
            if ($kind -eq 'ambiguous') { return 'paths' }
            if ($kind -eq 'switch') { continue }
            if ($kind -eq 'value') { $pending = ($null -eq $ce.Argument); continue }
            $hasValue = $true # 'input' or 'unknown'
            if ($null -ne $ce.Argument -and -not (Test-V2ConstWord $ce.Argument)) { $allConst = $false }
            continue
        }
        if ($pending) { $pending = $false; continue }
        $hasValue = $true
        if (-not (Test-V2ConstWord $ce)) { $allConst = $false }
    }
    if (-not $hasValue) { return 'pass' }
    return $(if ($allConst) { 'data' } else { 'paths' })
}

function Get-V2PipeSource($cmdAst) {
    # 'data' only when the element feeding this command emits plain text lines: Get-Content (cat, gc, type) or a native executable.
    # Everything else ('paths': path producers, expressions, other cmdlets, dynamic calls) may carry paths or objects with a Path
    # property. Pass-through filters (Where-Object, Select-Object, ...) inherit the kind of their own input.
    $pe = @($cmdAst.Parent.PipelineElements)
    $idx = -1
    for ($i = 0; $i -lt $pe.Count; $i++) { if ([object]::ReferenceEquals($pe[$i], $cmdAst)) { $idx = $i; break } }
    for ($k = $idx - 1; $k -ge 0; $k--) {
        $el = $pe[$k]
        if ($el -isnot [System.Management.Automation.Language.CommandAst]) { return 'paths' }
        $cn = $el.GetCommandName()
        if ($null -eq $cn) { return 'paths' }
        $n = ([string]$cn).ToLowerInvariant()
        if ($script:aliasMap.ContainsKey($n)) { $n = [string]$script:aliasMap[$n] }
        if ($n -eq 'get-random' -and (Test-V2RandomHasValue $el)) { return 'paths' } # emits the elements of its -InputObject value, not its pipeline input
        # TFIX-8: ForEach-Object (every alias and parameter form: script block, -Process/-Begin/-End, -MemberName) can emit anything, FileInfo included
        # (probe, pwsh 7.6.7: ForEach-Object { Get-ChildItem x } | Select-String reads the files), so it is always a path source.
        if ($n -eq 'foreach-object') { return 'paths' }
        if ($v2FilterParams.ContainsKey($n) -and (Test-V2FilterHasInputObject $el $n)) { return 'paths' } # -InputObject replaces the pipeline input
        if ($v2PipeThrough -contains $n) { continue }
        if ($n -eq 'get-content') { return 'data' }
        if ($v2PipeData -contains $n) { return 'data' }
        if ($n -eq 'write-output') {
            $wo = Get-V2WriteOutputKind $el
            if ($wo -eq 'pass') { continue } # re-emits its pipeline input: inherits the kind of the element before it
            return $wo
        }
        if ($n -notmatch '-' -or $n -match '[\\/]' -or $n.EndsWith('.exe')) { return 'data' } # no Verb-Noun name: a native executable
        return 'paths'
    }
    return 'paths'
}

function Get-V2Argv([string]$source, [string]$cwdStart, [int]$depth) {
    if ($null -eq $source) { $source = '' }
    if ([string]::IsNullOrWhiteSpace($cwdStart)) { $cwdStart = $null }
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    $parseErrors = @(foreach ($e in $errors) {
        [ordered]@{ category = (Get-ParseCategory ([string]$e.Message)); message = [string]$e.Message; line = $e.Extent.StartLineNumber; column = $e.Extent.StartColumnNumber }
    })
    $vars = Get-V2ConstVars $ast $cwdStart
    $cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | Sort-Object { $_.Extent.StartOffset })
    $curCwd = $cwdStart
    $stack = New-Object System.Collections.Generic.Stack[object]
    $flags = @{ dynamic = $false; iex = $false; encoded = $false; nestedShell = $false; nestedDynamic = $false; undecodable = $false
        startProcess = $false; runas = $false; download = $false; pipeToIex = $false; procStart = $false; inlineCode = $false; dynamicInvoke = $false }
    $out = New-Object System.Collections.Generic.List[object]
    $cwdTrail = New-Object System.Collections.Generic.List[object]

    foreach ($c in $cmds) {
        $els = @($c.CommandElements)
        $typed = $c.GetCommandName()
        $inv = 'command'
        $name = $null
        $exeValue = $null
        $constInvoke = $null
        if ($els[0] -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst] -and
            ($null -eq $typed -or ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown -and
                $els[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst]))) {
            $wv = Get-V2Word $els[0] $vars $curCwd
            if ($wv.isConst) { $constInvoke = [string]$wv.value }
        }
        if ($els[0] -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { $inv = 'scriptblock'; $name = '<scriptblock>' }
        elseif ($null -ne $constInvoke) {
            # & $var / & "$env:TEMP\x.exe" with a resolvable constant: behaves like a literal command name or path
            if ($constInvoke -match '[\\/]' -or $constInvoke -match '\.(exe|cmd|bat|ps1|psm1|csx|py|sh)$') {
                $ext = [IO.Path]::GetExtension($constInvoke).ToLowerInvariant()
                $name = [IO.Path]::GetFileNameWithoutExtension($constInvoke).ToLowerInvariant()
                $inv = if ($ext -in @('.ps1', '.psm1', '.csx', '.py', '.sh')) { 'script' } else { 'exe' }
                $exeValue = Resolve-V2Path $constInvoke $curCwd
            }
            else { $name = $constInvoke.ToLowerInvariant(); $inv = 'command' }
        }
        elseif ($null -eq $typed -or ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown -and
                $els[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst])) {
            $inv = 'dynamic'; $name = '<dynamic>'; $flags.dynamic = $true
        }
        else {
            $typedS = [string]$typed
            if ($typedS -match '[\\/]' -or $typedS -match '\.(exe|cmd|bat|ps1|psm1|csx|py|sh)$') {
                $ext = [IO.Path]::GetExtension($typedS).ToLowerInvariant()
                $name = [IO.Path]::GetFileNameWithoutExtension($typedS).ToLowerInvariant()
                $inv = if ($ext -in @('.ps1', '.psm1', '.csx', '.py', '.sh')) { 'script' } else { 'exe' }
                $w0 = Get-V2Word $els[0] $vars $curCwd
                $exeValue = if ($w0.isConst) { Resolve-V2Path $w0.value $curCwd } else { $null }
                if (-not $w0.isConst) { $exeValue = 'dynamic-path' }
            }
            else {
                $lower = $typedS.ToLowerInvariant()
                if ($lower.EndsWith('.exe')) { $name = $lower.Substring(0, $lower.Length - 4); $inv = 'exe' }
                else { $name = $lower }
                $fromAlias = $script:aliasMap[$lower]
                if ($fromAlias -and -not $lower.EndsWith('.exe')) { $name = [string]$fromAlias }
            }
        }

        # arguments: parameters keep their case; words keep their constant value when resolvable
        $cargs = New-Object System.Collections.Generic.List[object]
        $positional = 0
        $lastParam = $null
        for ($i = 1; $i -lt $els.Count; $i++) {
            $el = $els[$i]
            if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {
                $av = $null
                if ($null -ne $el.Argument) { $av = Get-V2Word $el.Argument $vars $curCwd }
                $cargs.Add([ordered]@{ k = 'param'; name = [string]$el.ParameterName; raw = [string]$el.Extent.Text
                    value = $(if ($av) { $av.value } else { $null }); isConst = $(if ($av) { $av.isConst } else { $false }); pathParam = $false; pos = $null })
                $lastParam = [string]$el.ParameterName
                continue
            }
            if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst] -and ([string]$el.Value).StartsWith('-') -and ([string]$el.Value).Length -gt 1 -and
                -not ([string]$el.Extent.Text).StartsWith('"') -and -not ([string]$el.Extent.Text).StartsWith("'") -and -not ([string]$el.Extent.Text).StartsWith('@')) {
                $t = [string]$el.Value
                $cargs.Add([ordered]@{ k = 'param'; name = $t.TrimStart('-'); raw = $t; value = $null; isConst = $false; pathParam = $false; pos = $null })
                $lastParam = $null
                continue
            }
            $w = Get-V2Word $el $vars $curCwd
            # the value of a parameter that takes a non-path value (-Context 2,3, -Encoding utf8, -Filter *.cs) is no positional argument (cmdlets only)
            $isParamValue = ($null -ne $lastParam -and $name -and $name -match '-' -and ($v2NonPathValueParams -contains $lastParam.ToLowerInvariant()))
            $cargs.Add([ordered]@{ k = 'word'; raw = [string]$el.Extent.Text; value = $w.value; isConst = $w.isConst; prop = $w.prop
                pathLike = [bool]($w.isConst -and $w.value -match '(\\|/|^\.|^~|^[A-Za-z]:|%)'); pathParam = $false; pos = $(if ($isParamValue) { $null } else { $positional }) })
            if (-not $isParamValue) { $positional++ }
            $lastParam = $null
        }

        # value arity from the configured flag table (native tools only)
        if ($inv -in @('exe', 'command') -and $name -and $script:flagTable.ContainsKey($name)) { Add-V2Arity $cargs $script:flagTable[$name] }

        # cmdlet path binding: path-typed parameters and positional path arguments of filesystem cmdlets only
        if ($inv -eq 'command' -and $name -and ($v2FsPositional -contains $name)) {
            foreach ($a in $cargs) {
                if ($a.k -eq 'param') {
                    if ($v2PathParams -contains $a.name.ToLowerInvariant()) { $a['pathParam'] = $true }
                }
                else {
                    $limit = if ($v2TwoPathPositional -contains $name) { 2 } else { 1 }
                    if ($null -ne $a.pos -and $a.pos -lt $limit) { $a['pathParam'] = $true }
                }
            }
        }

        # redirections: $null / /dev/null / NUL are null sinks; stream merges are not file targets
        $redirs = Get-V2Redirs $c.Redirections $vars $curCwd

        $pipedFrom = $false
        if ($c.Parent -is [System.Management.Automation.Language.PipelineAst]) {
            $pe = @($c.Parent.PipelineElements)
            if ($pe.Count -gt 0 -and -not [object]::ReferenceEquals($pe[0], $c)) { $pipedFrom = $true }
        }
        $pipeSource = $(if ($pipedFrom) { Get-V2PipeSource $c } else { $null })

        # inner scripts (recursive, depth-limited)
        $inner = $null
        if ($depth -lt 2 -and $name -and ($name -in $v2ShellNames)) {
            $flags.nestedShell = $true
            $cmdIdx = -1
            for ($k = 0; $k -lt $cargs.Count; $k++) {
                $a = $cargs[$k]
                if ($a.k -eq 'param' -and $a.name -imatch '^(command|c)$') { $cmdIdx = $k + 1; break }
                if ($a.k -eq 'param' -and $a.name -imatch '^(encodedcommand|enc|ec|e)$') {
                    $flags.encoded = $true
                    if ($a.isConst) {
                        try { $dec = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$a.value)); $inner = Get-V2Argv $dec $curCwd ($depth + 1); $inner['encodedDecoded'] = $true }
                        catch { $flags.undecodable = $true }
                    }
                    else { $flags.undecodable = $true; $flags.nestedDynamic = $true }
                    break
                }
                if ($a.k -eq 'word' -and $a.raw -imatch '^/[ck]$' -and $name -eq 'cmd') { $cmdIdx = $k + 1; break }
            }
            if ($null -eq $inner -and $cmdIdx -ge 0 -and $cmdIdx -lt $cargs.Count) {
                $parts = @()
                $allConst = $true
                for ($k = $cmdIdx; $k -lt $cargs.Count; $k++) {
                    $a = $cargs[$k]
                    if ($a.k -eq 'word' -or ($a.k -eq 'param' -and $a.isConst)) { if ($a.isConst) { $parts += [string]$a.value } else { $allConst = $false } }
                    elseif ($a.k -eq 'param') { $parts += ('-' + $a.name) }
                }
                if ($allConst -and $parts.Count -gt 0) {
                    $text = ($parts -join ' ')
                    if ($name -eq 'cmd') { $inner = [ordered]@{ kind = 'cmd'; text = $text; commands = @() } }
                    else { $inner = Get-V2Argv $text $curCwd ($depth + 1) }
                }
                else { $flags.nestedDynamic = $true }
            }
        }
        if ($name -in @('iex', 'invoke-expression')) {
            $flags.iex = $true
            $first = $cargs | Where-Object { $_.k -eq 'word' } | Select-Object -First 1
            if ($first -and $first.isConst -and $depth -lt 2) { $inner = Get-V2Argv ([string]$first.value) $curCwd ($depth + 1) }
        }
        if ($name -eq 'start-process') { $flags.startProcess = $true; if ($cargs | Where-Object { $_.k -eq 'param' -and $_.name -ieq 'verb' }) { $flags.runas = $true } }
        if (($name -in @('invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer')) -or ($name -in @('curl', 'wget', 'bitsadmin'))) { $flags.download = $true }
        if ($name -eq 'certutil' -and ($cargs | Where-Object { $_.k -eq 'param' -and $_.name -ieq 'urlcache' })) { $flags.download = $true }

        # cwd effects (after this command's own path arguments were resolved against the previous cwd)
        $cmdCwd = if ($curCwd) { $curCwd } else { $null }
        $cmdCwdKnown = [bool]$curCwd
        if ($name -in @('set-location', 'push-location', 'pop-location')) {
            if ($name -eq 'pop-location') {
                if ($stack.Count -gt 0) { $p = $stack.Pop(); $curCwd = $p.cwd }
            }
            else {
                if ($name -eq 'push-location') { $stack.Push([ordered]@{ cwd = $curCwd }) }
                $target = $null
                $hasTarget = $false
                for ($k = 0; $k -lt $cargs.Count; $k++) {
                    $a = $cargs[$k]
                    if ($a.k -eq 'param' -and $a.name -imatch '^(path|literalpath)$') {
                        $target = '<expr>'
                        if ($null -ne $a['value']) { $target = $(if ($a['isConst']) { $a['value'] } else { '<expr>' }) }
                        elseif ($k + 1 -lt $cargs.Count -and $cargs[$k + 1].k -eq 'word') { $nx = $cargs[$k + 1]; $target = $(if ($nx.isConst) { $nx.value } else { '<expr>' }) }
                        $hasTarget = $true; break
                    }
                    if ($a.k -eq 'word' -and $a.pos -eq 0) { $target = $(if ($a.isConst) { $a.value } else { '<expr>' }); $hasTarget = $true; break }
                }
                if (-not $hasTarget) { $target = '~' }
                $resolved = if ($target -eq '<expr>') { $null } else { Resolve-V2Path ([string]$target) $curCwd }
                if ($null -eq $resolved -or $resolved -match '^(url|registry|unc):') { $curCwd = $null } else { $curCwd = $resolved }
            }
        }

        $item = [ordered]@{
            idx = $out.Count; inv = $inv; name = $name; exeValue = $exeValue; cwd = $cmdCwd; cwdKnown = $cmdCwdKnown
            pipedFrom = $pipedFrom; pipeSource = $pipeSource; args = $cargs.ToArray(); redirs = $redirs.ToArray(); inner = $inner
        }
        $out.Add($item)
        $cwdTrail.Add([pscustomobject]@{ off = $c.Extent.StartOffset; cwd = $curCwd })
    }

    # redirections on expression statements ('x' > file) belong to no command: judge them as a write by a pseudo command
    foreach ($ce in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandExpressionAst] -and $n.Redirections.Count -gt 0 }, $true)) {
        $ecwd = $cwdStart
        foreach ($t in $cwdTrail) { if ($t.off -lt $ce.Extent.StartOffset) { $ecwd = $t.cwd } }
        $eredirs = Get-V2Redirs $ce.Redirections $vars $ecwd
        if ($eredirs.Count -eq 0) { continue }
        $out.Add([ordered]@{
            idx = $out.Count; inv = 'expression'; name = '<expression>'; exeValue = $null; cwd = $ecwd; cwdKnown = [bool]$ecwd
            pipedFrom = $false; pipeSource = $null; args = @(); redirs = $eredirs.ToArray(); inner = $null
        })
    }

    # .NET static calls and instance download methods (type/member names only)
    $dotnet = New-Object System.Collections.Generic.List[string]
    foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.MemberExpressionAst] -and $n.Expression -is [System.Management.Automation.Language.TypeExpressionAst] }, $true)) {
        $tname = ([string]$m.Expression.TypeName.FullName).ToLowerInvariant()
        $mem = '<dynamic-member>'
        if ($m.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mem = ([string]$m.Member.Value).ToLowerInvariant() }
        $dotnet.Add("$tname::$mem")
        if ($tname -match 'process$' -and $mem -eq 'start') { $flags.procStart = $true }
        if ($tname -match 'webclient|httpclient|webrequest') { $flags.download = $true }
    }
    foreach ($pl in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.PipelineAst] }, $true)) {
        $els2 = @($pl.PipelineElements)
        for ($k = 1; $k -lt $els2.Count; $k++) {
            if ($els2[$k] -is [System.Management.Automation.Language.CommandAst] -and ([string]$els2[$k].GetCommandName()) -match '^(iex|invoke-expression)$') { $flags.pipeToIex = $true }
        }
    }

    # dynamic code through members: .Invoke(), InvokeScript, NewScriptBlock, [scriptblock]::Create and members with a computed name
    foreach ($im in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
        $mn = $null
        if ($im.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mn = [string]$im.Member.Value }
        $isType = $im.Expression -is [System.Management.Automation.Language.TypeExpressionAst]
        if ($null -eq $mn -or $mn -in @('Invoke', 'InvokeScript', 'InvokeReturnAsIs', 'NewScriptBlock', 'Start') -or
            ($mn -ieq 'Create' -and $isType -and ([string]$im.Expression.TypeName.FullName) -match 'scriptblock$')) {
            $flags.dynamicInvoke = $true; $flags.dynamic = $true
        }
    }
    $stmtCount = 0
    foreach ($blk in @($ast.BeginBlock, $ast.ProcessBlock, $ast.EndBlock, $ast.DynamicParamBlock)) {
        if ($null -ne $blk) { $stmtCount += @($blk.Statements).Count }
    }

    # .NET static invocations with their arguments (constant values or unresolved), for path intents in the engine
    $dotnetCalls = New-Object System.Collections.Generic.List[object]
    if ($script:v2D) {
        foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Expression -is [System.Management.Automation.Language.TypeExpressionAst] }, $true)) {
            $tname = ([string]$m.Expression.TypeName.FullName).ToLowerInvariant()
            $mem = '<dynamic-member>'
            if ($m.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mem = ([string]$m.Member.Value).ToLowerInvariant() }
            $dargs = New-Object System.Collections.Generic.List[object]
            foreach ($a in @($m.Arguments)) {
                $w = Get-V2Word $a $vars $cwdStart
                $dargs.Add([ordered]@{ isConst = [bool]$w.isConst; value = $w.value })
            }
            $dotnetCalls.Add([ordered]@{ type = $tname; method = $mem; args = $dargs.ToArray(); cwd = $(if ($cwdStart) { $cwdStart } else { $null }) })
        }
    }

    # environment variables read anywhere in the script ($env:NAME, ${env:NAME}; also inside strings and script blocks): distinct names in original case
    $envRefs = New-Object System.Collections.Generic.List[string]
    foreach ($ve in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)) {
        $up = [string]$ve.VariablePath.UserPath
        if ($up -imatch '^env:(.+)$' -and -not $envRefs.Contains($Matches[1])) { $envRefs.Add($Matches[1]) }
    }

    return [ordered]@{
        parseErrors    = $parseErrors
        commentSpans   = $(if ($depth -eq 0) { Get-CommentSpans $tokens } else { , @() })
        commentSpansFor = $(if ($depth -eq 0) { Get-ScriptIdentity $source } else { $null })
        statementCount = $stmtCount
        envRefs     = $envRefs.ToArray()
        constVars   = @($vars.Keys | Sort-Object)
        dotnetCalls = $dotnetCalls.ToArray()
        commands    = $out.ToArray()
        dotnet      = @($dotnet | Sort-Object -Unique)
        flags       = $flags
    }
}

function Set-WorkerConfig($req) {
    # validate everything first so a rejected request leaves the previous configuration untouched
    $applied = New-Object System.Collections.Generic.List[string]
    $patterns = $null
    if ($null -ne $req.secretPatterns) {
        $patterns = @(foreach ($p in @($req.secretPatterns)) {
            try { [void][regex]::new([string]$p) } catch { throw "invalid secret pattern '$p': $($_.Exception.Message)" }
            [string]$p
        })
    }
    $table = $null
    if ($null -ne $req.flagTable) {
        $table = @{}
        foreach ($tool in $req.flagTable.PSObject.Properties) {
            $s = $tool.Value
            $cs = $true
            if ($null -ne $s.caseSensitive) { $cs = [bool]$s.caseSensitive }
            $cmp = if ($cs) { [System.StringComparer]::Ordinal } else { [System.StringComparer]::OrdinalIgnoreCase }
            $make = {
                param($items)
                $set = New-Object 'System.Collections.Generic.HashSet[string]' ($cmp)
                foreach ($x in @($items)) { if ($null -ne $x) { [void]$set.Add([string]$x) } }
                , $set
            }
            $table[([string]$tool.Name).ToLowerInvariant()] = @{
                posix = [bool]($s.posix)
                gn    = (& $make $s.globalNoValue)
                gw    = (& $make $s.globalWithValue)
                vf    = (& $make $s.valueFlags)
            }
        }
    }
    if ($null -ne $req.userHome) { $script:cfgUserHome = ([string]$req.userHome).TrimEnd('\', '/'); $applied.Add('userHome') }
    if ($null -ne $req.copilotHome) { $script:cfgCopilotHome = [string]$req.copilotHome; $applied.Add('copilotHome') }
    if ($null -ne $patterns) { $script:cfgSecretPatterns = $patterns; $applied.Add('secretPatterns') }
    if ($null -ne $req.systemRoots) { $script:cfgSystemRoots = @(@($req.systemRoots) | ForEach-Object { [string]$_ }); $applied.Add('systemRoots') }
    if ($null -ne $table) { $script:flagTable = $table; $applied.Add('flagTable') }
    return , $applied.ToArray()
}

Send-Message ([ordered]@{
    ready     = $true
    psVersion = $PSVersionTable.PSVersion.ToString()
    startMs   = [math]::Round($startSw.Elapsed.TotalMilliseconds, 1)
    pid       = $PID
})

$exitRequested = $false
while (-not $exitRequested -and $null -ne ($line = $reader.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = $null
    try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        switch ($req.op) {
            'config' {
                $applied = Set-WorkerConfig $req
                Send-Message ([ordered]@{ id = $id; op = 'config'; applied = $applied })
            }
            'parse' {
                $result = Get-Facts -id $id -source ([string]$req.script)
                $script:served++
                Send-Message $result
            }
            'stats' {
                $script:served++
                Send-Message ([ordered]@{
                    id           = $id
                    op           = 'stats'
                    psVersion    = $PSVersionTable.PSVersion.ToString()
                    pid          = $PID
                    workingSetMB = [math]::Round([System.Diagnostics.Process]::GetCurrentProcess().WorkingSet64 / 1MB, 1)
                    served       = $script:served
                    flagTools    = $script:flagTable.Count
                })
            }
            'argv' {
                $cwdArg = $null
                if ($req.cwd) { $cwdArg = [string]$req.cwd }
                $script:v2J = $true
                $script:v2D = $true
                if ($null -ne $req.features) {
                    if ($null -ne $req.features.joinPath) { $script:v2J = [bool]$req.features.joinPath }
                    if ($null -ne $req.features.dotnetArgs) { $script:v2D = [bool]$req.features.dotnetArgs }
                }
                $res = Get-V2Argv -source ([string]$req.script) -cwdStart $cwdArg -depth 0
                $script:served++
                $payload = [ordered]@{ id = $id; op = 'argv'; cwd = $cwdArg }
                foreach ($k in $res.Keys) { $payload[$k] = $res[$k] }
                Send-MessageDeep $payload
            }
            'exit' {
                Send-Message ([ordered]@{ id = $id; op = 'exit'; served = $script:served })
                $exitRequested = $true
            }
            default {
                Send-Message ([ordered]@{ id = $id; error = "unknown op: $($req.op)" })
            }
        }
    }
    catch {
        Send-Message ([ordered]@{ id = $id; error = $_.Exception.Message })
    }
}
