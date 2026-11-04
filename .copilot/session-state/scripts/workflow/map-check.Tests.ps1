<#
.SYNOPSIS
    Self-contained tests for map-check.ps1 (no Pester dependency).
    Run: pwsh -NoProfile -File map-check.Tests.ps1   (exit code = number of failures)
#>
$ErrorActionPreference = 'Stop'
$checkScript = Join-Path $PSScriptRoot 'map-check.ps1'
$fixtureRoot = Join-Path $PSScriptRoot 'fixtures/map'
$repo = Join-Path $fixtureRoot 'repo'
$valid = [System.IO.File]::ReadAllText((Join-Path $fixtureRoot 'valid-map.md')) -replace "`r`n", "`n"
$realistic = [System.IO.File]::ReadAllText((Join-Path $fixtureRoot 'realistic-map.md')) -replace "`r`n", "`n"
$fence = '```'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("map-check-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0; $passed = 0; $jsonFailures = 0

function Invoke-Raw([string[]] $callArgs) {
    $out = & pwsh -NoProfile -File $checkScript @callArgs 2>&1
    $code = $LASTEXITCODE
    $json = $null
    try { $json = (($out -join "`n") | ConvertFrom-Json) } catch { $json = $null }
    if ($null -eq $json) { $script:jsonFailures++ }
    return [pscustomobject]@{ code = $code; json = $json }
}
function Invoke-Check([string] $mapText, [string] $root = $repo) {
    $p = Join-Path $tmp ([guid]::NewGuid().ToString('N') + '.md')
    [System.IO.File]::WriteAllText($p, $mapText)
    return Invoke-Raw @('-MapPath', $p, '-RepoRoot', $root)
}
function Invoke-Header([string] $mapText) {
    $p = Join-Path $tmp ([guid]::NewGuid().ToString('N') + '.md')
    [System.IO.File]::WriteAllText($p, $mapText)
    return Invoke-Raw @('-MapPath', $p)
}
function Lines([string[]] $lines) { return (($lines -join "`n") + "`n") }
function New-ClassMap([string] $className, [string] $evidence) {
    return Lines @('# Map: class', '', "${fence}mermaid", 'classDiagram', "    class $className", $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', "| $className | $evidence | x |")
}
function New-TempRepo([string] $name, [switch] $gitFile) {
    $root = Join-Path $tmp $name
    New-Item -ItemType Directory -Path (Join-Path $root 'src') -Force | Out-Null
    if ($gitFile) { [System.IO.File]::WriteAllText((Join-Path $root '.git'), "gitdir: elsewhere`n") }
    else { New-Item -ItemType Directory -Path (Join-Path $root '.git') -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $repo 'src/Greeter.cs') -Destination (Join-Path $root 'src/Greeter.cs')
    return $root
}
function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passed++; Write-Host "PASS  $name" } else { $script:failures++; Write-Host "FAIL  $name" -ForegroundColor Red }
}
function Mutate([string] $text, [string] $from, [string] $to) {
    if (-not $text.Contains($from)) { throw "fixture text not found: $from" }
    return $text.Replace($from, $to)
}
function Get-ErrorText($r) { return (@($r.json.errors) -join "`n") }
function Get-WarningText($r) { return (@($r.json.warnings) -join "`n") }

try {
    # 1. valid map: classDiagram + sequenceDiagram + flowchart + target classDiagram with new evidence
    $r = Invoke-Check $valid
    Assert ($r.code -eq 0 -and $r.json.ok) '(1) valid map exits 0 with ok true'
    Assert (@($r.json.errors).Count -eq 0 -and @($r.json.warnings).Count -eq 0) '(1) valid map has no errors or warnings'
    Assert (($r.json.PSObject.Properties.Name -join ',') -eq 'ok,errors,warnings,stats') '(1) output keys are ok, errors, warnings, stats'
    Assert ($r.json.stats.diagrams -eq 4 -and $r.json.stats.nodes -eq 10 -and $r.json.stats.edges -eq 4 -and $r.json.stats.rows -eq 14 -and $r.json.stats.inferred -eq 0) '(1) stats count diagrams, nodes, edges, rows and inferred rows'

    # 2. node without row
    $r = Invoke-Check (Mutate $valid "| Cli | src/Cli.ps1:3 | entry point |`n" '')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "diagram 1 \(classDiagram, map line \d+\): node 'Cli' has no evidence row") '(2) node without row is an error naming the node and the diagram'

    # 3. classDiagram / flowchart edge without row
    $r = Invoke-Check (Mutate $valid "| Cli --> Greeter | src/Cli.ps1:4-5 | constructs and calls |`n" '')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "edge 'Cli --> Greeter' has no evidence row") '(3) classDiagram edge without row is an error'
    $r = Invoke-Check (Mutate $valid "| A --> Greeter | src/Cli.ps1:4-5 | calls |`n" '')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "edge 'A --> B' has no evidence row") '(3) flowchart edge without row is an error'

    # 4. evidence path missing
    $r = Invoke-Check (Mutate $valid 'src/Greeter.cs:3 | class declaration' 'src/Missing.cs:3 | class declaration')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'evidence path not found under repo root: src/Missing.cs') '(4) missing evidence path is an error'

    # 5. line beyond file end
    $r = Invoke-Check (Mutate $valid 'src/Greeter.cs:3 | class declaration' 'src/Greeter.cs:99 | class declaration')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'lines 99-99 are outside src/Greeter.cs') '(5) line beyond file end is an error'

    # 6. element name not within +-3 lines of the cited line
    $r = Invoke-Check (Mutate $valid '| Cli | src/Cli.ps1:3 | entry point |' '| Cli | src/Greeter.cs:1 | entry point |')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "'Cli' not found within 3 lines of src/Greeter.cs:1-1") '(6) name outside +-3 lines of the cited line is an error'

    # 7. path:start-end range accepted
    $r = Invoke-Check (Mutate $valid 'src/Greeter.cs:3 | class declaration' 'src/Greeter.cs:3-6 | class declaration')
    Assert ($r.code -eq 0 -and $r.json.ok) '(7) path:start-end range is accepted'

    # 8. inferred row is a warning, not an error
    $r = Invoke-Check (Mutate $valid '| Cli --> Greeter | src/Cli.ps1:4-5 | constructs and calls |' '| Cli --> Greeter | inferred | constructs and calls |')
    Assert ($r.code -eq 0 -and $r.json.ok -and @($r.json.warnings).Count -eq 1 -and $r.json.stats.inferred -eq 1) '(8) inferred row is a warning, not an error'

    # 9. row whose element is in no diagram is a warning
    $r = Invoke-Check (Mutate $valid "| Cli | src/Cli.ps1:3 | entry point |`n" "| Cli | src/Cli.ps1:3 | entry point |`n| Orphan | src/Cli.ps1:3 | not drawn |`n")
    Assert ($r.code -eq 0 -and (Get-WarningText $r) -match "row 'Orphan' names no element" -and @($r.json.errors).Count -eq 0) '(9) row whose element is in no diagram is a warning'

    # 10. diagram with more than 20 nodes is a warning
    $r = Invoke-Raw @('-MapPath', (Join-Path $fixtureRoot 'large-diagram.md'), '-RepoRoot', $repo)
    Assert ($r.code -eq 0 -and $r.json.ok -and (Get-WarningText $r) -match 'has 21 nodes') '(10) diagram with 21 nodes is a warning'

    # 11. new evidence needs an element styled added
    $r = Invoke-Check (Mutate $valid 'class Logger:::added' 'class Logger added')
    Assert ($r.code -eq 0 -and $r.json.ok) '(11) new evidence on an element styled "class X added" is accepted'
    $r = Invoke-Check (Mutate $valid 'class Logger:::added' 'class Logger')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "'new' evidence for 'Logger' but it is not styled added") '(11) new evidence on an unstyled node is an error'

    # 12. flowchart node A[Label] is matched by row element A (id) or Label
    $r = Invoke-Check (Mutate $valid '| Greeter | src/Greeter.cs:3 | matched by label |' '| B | src/Greeter.cs:3 | matched by id |')
    Assert ($r.code -eq 0 -and $r.json.ok) '(12) flowchart node is matched by its id'
    $r = Invoke-Check (Mutate $valid '| Greeter | src/Greeter.cs:3 | matched by label |' '| Q | src/Greeter.cs:3 | matched by id |')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "node 'B' \(Greeter\) has no evidence row") '(12) flowchart node B (label Greeter) is not covered by an unrelated row'

    # 13. sequence participants need rows; messages do not
    $r = Invoke-Check (Mutate $valid "| G | src/Greeter.cs:3 | alias of Greeter |`n" '')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "diagram 2 \(sequenceDiagram.*node 'G' \(Greeter\) has no evidence row") '(13) sequence participant without row is an error'

    # 14. generic parameters: Foo<T> is matched by the name Foo
    $r = Invoke-Check (Mutate $valid "    class Greeter`n    class Cli`n    Cli --> Greeter : uses" "    class Greeter<T>`n    class Cli`n    Cli --> Greeter<T> : uses")
    Assert ($r.code -eq 0 -and $r.json.ok) '(14) Foo<T> is matched by the name Foo'

    # 15. usage and internal errors exit 2 with a JSON error
    $r = Invoke-Raw @('-MapPath', (Join-Path $tmp 'missing.md'), '-RepoRoot', $repo)
    Assert ($r.code -eq 2 -and -not $r.json.ok -and (Get-ErrorText $r) -match 'map file not found') '(15) missing -MapPath file exits 2 with JSON error'
    $r = Invoke-Raw @('-RepoRoot', $repo)
    Assert ($r.code -eq 2 -and -not $r.json.ok) '(15) missing -MapPath argument exits 2 with JSON error'
    $r = Invoke-Check "# Map without diagrams`n`nplain text`n"
    Assert ($r.code -eq 2 -and (Get-ErrorText $r) -match 'no Mermaid block') '(15) map without a Mermaid block exits 2 with JSON error'
    $noRepoMap = Join-Path $tmp 'no-repo.md'
    [System.IO.File]::WriteAllText($noRepoMap, $valid)
    $r = Invoke-Raw @('-MapPath', $noRepoMap)
    Assert ($r.code -eq 2 -and (Get-ErrorText $r) -match '-RepoRoot is required') '(15) no -RepoRoot and no Repository: header line exits 2'
    $r = Invoke-Raw @('-MapPath', $noRepoMap, '-RepoRoot', (Join-Path $tmp 'no-such-dir'))
    Assert ($r.code -eq 2 -and (Get-ErrorText $r) -match 'repo root not found') '(15) missing -RepoRoot directory exits 2'

    # W1 sequence messages with spaces around the arrow
    $spaced = Lines @('# Map', '', "${fence}mermaid", 'sequenceDiagram', '    User ->> Cli: run', '    Cli -->> User: done', '    User ->>+ Cli: again', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', '| User | src/Cli.ps1:3 | caller |', '| Cli | src/Cli.ps1:3 | entry |')
    $r = Invoke-Check $spaced
    Assert ($r.code -eq 0 -and $r.json.ok -and $r.json.stats.nodes -eq 2 -and @($r.json.warnings).Count -eq 0) '(W1) sequence messages with spaces around the arrow are matched (2 nodes, no warning)'

    # W2 keyword-like ids are nodes
    $keywordIds = Lines @('# Map', '', "${fence}mermaid", 'flowchart LR', '    Graph --> Style', '    Class --> Title', '    End --> Subgraph', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|')
    $r = Invoke-Check $keywordIds
    $e = Get-ErrorText $r
    Assert ($r.json.stats.nodes -eq 6 -and $e -match "node 'Graph' has no evidence row" -and $e -match "node 'Subgraph' has no evidence row") '(W2) ids Graph, Style, Class, Title, End, Subgraph are nodes, not keywords'

    # W3 labelled arrows create no label node
    $labelled = Lines @('# Map', '', "${fence}mermaid", 'flowchart LR', '    A --> B -- text --> C', '    A -. text .-> D', '    D == text ==> E', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|')
    $r = Invoke-Check $labelled
    $e = Get-ErrorText $r
    Assert ($r.json.stats.nodes -eq 5 -and $r.json.stats.edges -eq 4 -and $e -notmatch "'text'" -and $e -match "edge 'B -- text --> C' has no evidence row") '(W3) labelled arrows (-- text -->, -. text .->, == text ==>) create no label node'

    # W4 ampersand chains split into nodes and edges
    $amp = Lines @('# Map', '', "${fence}mermaid", 'flowchart LR', '    A --> B & C', '    D & E --> F', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|')
    $r = Invoke-Check $amp
    Assert ($r.json.stats.nodes -eq 6 -and $r.json.stats.edges -eq 4) '(W4) & chains split into nodes and edges (A-->B, A-->C, D-->F, E-->F)'

    # W4 a line the grammar does not understand is reported, not silently dropped
    $notUnderstood = Lines @('# Map', '', "${fence}mermaid", 'classDiagram', '    class Greeter', '    Greeter ==> Cli', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', '| Greeter | src/Greeter.cs:3 | class |')
    $r = Invoke-Check $notUnderstood
    Assert ($r.code -eq 0 -and (Get-WarningText $r) -match 'diagram 1 line \d+: not understood, not checked: Greeter ==> Cli') '(W4) a line the grammar does not understand gives a "not understood" warning'

    # W5 unsupported kind: warning and not checked
    $withEr = Mutate $valid "## Current state`n`n${fence}mermaid`nclassDiagram`n" "## Current state`n`n${fence}mermaid`nerDiagram`n    CUSTOMER ||--o{ ORDER : places`n${fence}`n`n${fence}mermaid`nclassDiagram`n"
    $r = Invoke-Check $withEr
    Assert ($r.code -eq 0 -and (Get-WarningText $r) -match "diagram 1: kind 'erDiagram' not checked" -and $r.json.stats.diagrams -eq 4) '(W5) unsupported diagram kind gives a warning and is not checked'
    $onlyEr = Lines @('# Map', '', "${fence}mermaid", 'erDiagram', '    A ||--o{ B : x', $fence)
    $r = Invoke-Check $onlyEr
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'no supported diagram \(classDiagram, flowchart/graph, sequenceDiagram\) found' -and (Get-WarningText $r) -match "kind 'erDiagram' not checked") '(W5) a map with no supported diagram is an error (exit 1)'

    # W5 leading front matter is skipped before the kind is read
    $frontMatter = Lines @('# Map', '', "${fence}mermaid", '---', 'title: Greeter', '---', 'classDiagram', '    class Greeter', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', '| Greeter | src/Greeter.cs:3 | class |')
    $r = Invoke-Check $frontMatter
    Assert ($r.code -eq 0 -and $r.json.ok -and $r.json.stats.nodes -eq 1 -and @($r.json.warnings).Count -eq 0) '(W5) leading front matter (--- ... ---) is skipped before the diagram kind is read'

    # W6 backtick-quoted cells match as if unquoted
    $backticked = Lines @('# Map', '', "${fence}mermaid", 'classDiagram', '    class Greeter', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', '| `Greeter` | `src/Greeter.cs:3` | class |')
    $r = Invoke-Check $backticked
    Assert ($r.code -eq 0 -and $r.json.ok) '(W6) backtick-quoted cells (`Greeter`, `src/Greeter.cs:3`) match as if unquoted'

    # W7 Repository: header forms; the value is below the git root, which is found by walking up
    $hdrRoot = New-TempRepo 'hdr'
    $forms = @('Repository: {0}', '**Repository:** {0}', '- Repository: {0}', '- **Repository:** {0}', '* Repository: {0}', 'Repository: `{0}`')
    $body = @("${fence}mermaid", 'classDiagram', '    class Greeter', $fence, '', '| Element | Evidence | Note |', '|---|---|---|', '| Greeter | src/Greeter.cs:3 | class |')
    foreach ($form in $forms) {
        $headerLine = $form -f (Join-Path $hdrRoot 'src')
        $r = Invoke-Header (Lines (@('# Map', '', $headerLine, '') + $body))
        Assert ($r.code -eq 0 -and $r.json.ok) "(W7) header form '$form' resolves the git root above its value"
    }
    $gitFileRoot = New-TempRepo 'gitfile' -gitFile
    $r = Invoke-Header (Lines (@('# Map', '', "Repository: $gitFileRoot", '') + $body))
    Assert ($r.code -eq 0 -and $r.json.ok) '(W7) a .git file (worktree) counts as the git root'
    $noGit = Join-Path $tmp 'nogit\sub'
    New-Item -ItemType Directory -Path $noGit -Force | Out-Null
    $r = Invoke-Header (Lines (@('# Map', '', "Repository: $noGit", '') + $body))
    Assert ($r.code -eq 2 -and (Get-ErrorText $r) -match 'no git root found above Repository') '(W7) no git root above the Repository: value exits 2 with a JSON error'

    # W8 realistic map: class members, ~T~ and <T>, cardinality, flowchart shapes/labels/&/subgraph, sequence keywords
    $r = Invoke-Raw @('-MapPath', (Join-Path $fixtureRoot 'realistic-map.md'), '-RepoRoot', $repo)
    Assert ($r.code -eq 0 -and $r.json.ok -and @($r.json.warnings).Count -eq 0 -and $r.json.stats.diagrams -eq 3 -and $r.json.stats.nodes -eq 12 -and $r.json.stats.edges -eq 8 -and $r.json.stats.rows -eq 20) '(W8) realistic map exits 0 with no warnings (classes, flowchart, sequence syntax coverage)'
    $r = Invoke-Check (Mutate $realistic '| Foo --> Box | src/Model.cs:3-8 | holds |' '| Foo --> Box | src/Model.cs:3 | holds |')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "'Box' not found within 3 lines of src/Model.cs:3-3") '(W8) edge target name must be within 3 lines of the cited range'

    # W8 +-3 boundary (Item21 is on line 23 of Many.cs, Item01 on line 3)
    $rAfter = Invoke-Check (New-ClassMap 'Item21' 'src/Many.cs:20')
    $rTooFar = Invoke-Check (New-ClassMap 'Item21' 'src/Many.cs:19')
    $rBefore = Invoke-Check (New-ClassMap 'Item01' 'src/Many.cs:6')
    $rBeforeTooFar = Invoke-Check (New-ClassMap 'Item01' 'src/Many.cs:7')
    Assert ($rAfter.code -eq 0 -and $rBefore.code -eq 0 -and $rTooFar.code -eq 1 -and $rBeforeTooFar.code -eq 1 -and (Get-ErrorText $rBeforeTooFar) -match "'Item01' not found within 3 lines of src/Many.cs:7-7") '(W8) a name exactly 3 lines outside the cited range passes; 4 lines fails'

    # W8 path traversal, sibling prefix and absolute paths
    $r = Invoke-Check (New-ClassMap 'Greeter' '..\valid-map.md:1')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'evidence path not found under repo root: \.\.\\valid-map\.md') '(W8) evidence path ..\valid-map.md outside the repo root is rejected'
    $r = Invoke-Check (New-ClassMap 'Greeter' '../valid-map.md:1')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'evidence path not found under repo root: \.\./valid-map\.md') '(W8) evidence path ../valid-map.md outside the repo root is rejected'
    $sibRoot = New-TempRepo 'sibling'
    $sibling = Join-Path $tmp 'sibling2'
    New-Item -ItemType Directory -Path $sibling -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'src/Greeter.cs') -Destination (Join-Path $sibling 'Greeter.cs')
    $r = Invoke-Check (New-ClassMap 'Greeter' '..\sibling2\Greeter.cs:3') $sibRoot
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'evidence path not found under repo root') '(W8) a sibling directory whose name starts with the repo name is rejected'
    $r = Invoke-Check (New-ClassMap 'Greeter' ((Join-Path $repo 'src\Greeter.cs') + ':3'))
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'evidence path must be repository-relative') '(S12) an absolute evidence path is rejected even inside the repo'

    # W8 path with spaces and backslashes; CRLF map and CRLF source
    $spaceRoot = New-TempRepo 'spaces'
    New-Item -ItemType Directory -Path (Join-Path $spaceRoot 'docs and src') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'src/Greeter.cs') -Destination (Join-Path $spaceRoot 'docs and src\My Greeter.cs')
    $r = Invoke-Check (New-ClassMap 'Greeter' 'docs and src\My Greeter.cs:3') $spaceRoot
    Assert ($r.code -eq 0 -and $r.json.ok) '(W8) evidence path with spaces and backslashes resolves'
    $crlfRoot = New-TempRepo 'crlf'
    $greeterLf = [System.IO.File]::ReadAllText((Join-Path $repo 'src/Greeter.cs')) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText((Join-Path $crlfRoot 'src/Greeter.cs'), ($greeterLf -replace "`n", "`r`n"))
    $crlfMap = (New-ClassMap 'Greeter' 'src/Greeter.cs:3') -replace "`n", "`r`n"
    $r = Invoke-Check $crlfMap $crlfRoot
    Assert ($r.code -eq 0 -and $r.json.ok -and [System.IO.File]::ReadAllText((Join-Path $crlfRoot 'src/Greeter.cs')).Contains("`r`n")) '(W8) CRLF map and CRLF source (bytes kept) pass'

    # W8 line and range numbers, unclosed fence, invalid evidence
    $r = Invoke-Check (New-ClassMap 'Greeter' 'src/Greeter.cs:0')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'lines 0-0 are outside src/Greeter.cs') '(W8) line 0 is outside the file'
    $r = Invoke-Check (New-ClassMap 'Greeter' 'src/Greeter.cs:5-3')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'lines 5-3 are outside src/Greeter.cs') '(W8) a range whose end is before its start is an error'
    $unclosed = Lines @('# Map', '', "${fence}mermaid", 'classDiagram', '    class Greeter')
    $r = Invoke-Check $unclosed
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'Mermaid block is not closed') '(W8) unclosed mermaid fence is an error'
    $r = Invoke-Check (New-ClassMap 'Greeter' 'see Greeter.cs')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match "invalid evidence 'see Greeter.cs'") '(W8) invalid evidence format is an error'

    # S10 huge line number is "outside the file", not an internal error
    $r = Invoke-Check (New-ClassMap 'Greeter' 'src/Greeter.cs:99999999999999999999999')
    Assert ($r.code -eq 1 -and (Get-ErrorText $r) -match 'lines 99999999999999999999999-99999999999999999999999 are outside' -and (Get-ErrorText $r) -notmatch 'internal error') '(S10) a huge line number is "outside the file", not an internal error'

    # S11 diagram without an evidence table: one error, no per-node errors
    $noTable = Mutate $valid "| Element | Evidence | Note |`n|---|---|---|`n| User | src/Cli.ps1:3 | the caller |`n| Cli | src/Cli.ps1:3 | participant |`n| G | src/Greeter.cs:3 | alias of Greeter |`n" ''
    $r = Invoke-Check $noTable
    Assert ($r.code -eq 1 -and @($r.json.errors).Count -eq 1 -and (Get-ErrorText $r) -match 'diagram 2 \(sequenceDiagram, map line \d+\): no evidence table \(Element \| Evidence \| Note\)') '(S11) a diagram without an evidence table gives one error'

    # S13 generics: Foo~T~, Foo<T> and the row Foo<T> are one node Foo
    $generic = Lines @('# Map', '', "${fence}mermaid", 'classDiagram', '    class Greeter~T~', '    class Greeter<T>', $fence, '',
        '| Element | Evidence | Note |', '|---|---|---|', '| Greeter<T> | src/Greeter.cs:3 | class |')
    $r = Invoke-Check $generic
    Assert ($r.code -eq 0 -and $r.json.ok -and $r.json.stats.nodes -eq 1) '(S13) Foo~T~, Foo<T> and the row Foo<T> are one node Foo'

    # 16. stdout is one parseable JSON object in every case above
    Assert ($jsonFailures -eq 0) '(16) stdout is one parseable JSON object in every case'
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "`n$passed passed, $failures failed"
exit $failures
