<#
.SYNOPSIS
    Validates the evidence of a Mermaid "map" document against the repository (deterministic, no model judgment).

.DESCRIPTION
    Used by the implementation planner (writes maps) and the reviewer (checks maps).
    - Reads every ```mermaid block. Supported kinds: classDiagram, flowchart/graph, sequenceDiagram. Any other kind
      is a warning and is not checked; a leading front-matter block (--- ... ---) is skipped.
    - Extracts the nodes of supported diagrams and the edges of classDiagram and flowchart blocks. A diagram line
      the grammar does not understand is a warning ("not understood, not checked").
    - Reads the evidence table (Element | Evidence | Note) that follows each supported diagram.
    - Errors: a node or structural edge without an evidence row; a diagram without an evidence table; an evidence
      path that is absolute or not a file under the repo root; a line or range outside the file; an element name
      (for an edge: its target) not within 3 lines of the cited range; `new` evidence on an element not styled
      `added`; an evidence cell in no known format; an unclosed mermaid fence; no supported diagram at all.
    - Warnings: `inferred` rows; rows that name no element or edge of their diagram; a diagram with more than
      20 nodes; unsupported diagram kinds; lines not understood.
    Never writes files.

.PARAMETER MapPath
    Path to the map Markdown file. Required (exit 2 when missing).
.PARAMETER RepoRoot
    Directory that evidence paths are relative to. Default: the git root found by walking up from the map's
    `Repository:` header line; required (exit 2) when that line is absent.

.OUTPUTS
    One JSON object on stdout: { ok, errors, warnings, stats }.
    Exit code: 0 = no errors, 1 = errors, 2 = usage or internal error (the message is in errors).
#>
[CmdletBinding()]
param(
    [string] $MapPath,
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$nameWindow = 3
$maxNodesPerDiagram = 20

# Mermaid and evidence syntax. \G anchors a flowchart match at the position where the previous match ended.
$mermaidFenceRx = '^\s*```mermaid\s*$'
$closingFenceRx = '^\s*```\s*$'
$frontMatterRx = '^---$'
$kindTokenRx = '^(?<kind>[A-Za-z][\w-]*)'
$headerRepoRx = '^\s*(?:[-*]\s+)?(?:\*\*)?Repository:(?:\*\*)?\s*(?<value>.+?)\s*$'
$tableSeparatorRx = '^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$'
$classNameRx = '[A-Za-z_][\w.]*(?:<[^>]*>|~[^~]*~)?'
$classDeclRx = '^class\s+(?<name>' + $classNameRx + ')(?::::(?<cls>\w+))?(?:\s+(?<word>\w+))?\s*(?:\{.*)?$'
$classStyleRx = '^(?<name>' + $classNameRx + '):::(?<cls>\w+)\s*$'
$classRelRx = '^(?<src>' + $classNameRx + ')\s*(?:"[^"]*"\s*)?(?<arrow><\|--|<\|\.\.|\*--|--\*|o--|--o|-->|<--|--\|>|\.\.\|>|\.\.>|\*\.\.|o\.\.|--|\.\.)(?:\s*"[^"]*")?\s*(?<dst>' + $classNameRx + ')\s*(?::.*)?$'
$classMemberRx = '^(?<name>' + $classNameRx + ')\s*:\s*\S.*$'
$classNoOpRx = '^(?:\}|<<|note\b|direction\b|classDef\b|cssClass\b|style\b|click\b|link\b|callback\b|namespace\b|accTitle\b|accDescr\b|title\b)'
$shapeRx = '\[\[[^\]]*\]\]|\[\([^\]]*\)\]|\(\([^)]*\)\)|\(\[[^\]]*\]\)|\{\{[^}]*\}\}|\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|>[^\]]*\]'
$flowSegmentRx = '\G\s*(?<id>[A-Za-z_]\w*)\s*(?<shape>' + $shapeRx + ')?\s*(?::::(?<cls>\w+))?\s*'
$flowAmpRx = '\G\s*&\s*'
$flowArrowRx = '\G\s*(?<arrow>--\s+[^|]+?\s+-{2,}[>ox]?|==\s+[^|]+?\s+={2,}>?|-\.\s+[^|]+?\s+\.+-[>ox]?|-\.+->|-\.+-|={2,}>?|-{2,}[>ox]?)\s*(?:\|[^|]*\|\s*)?'
$flowSkipRx =   '^(?:subgraph|end|classDef|class|style|click|linkStyle|direction|accTitle|accDescr|title)\b'
$flowClassAddedRx = '^class\s+(?<ids>\w+(?:\s*,\s*\w+)*)\s+added\s*$'
$seqDeclRx = '^(?:participant|actor)\s+(?<id>[A-Za-z_]\w*)(?:\s+as\s+(?<alias>.+?))?\s*$'
$seqMessageRx = '^(?<src>[A-Za-z_]\w*)\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*(?<dst>[A-Za-z_]\w*)\s*(?::|$)'
$seqNoOpRx = '^(?:autonumber|activate|deactivate|alt|else|opt|par|and|loop|rect|critical|option|break|end|box|create|destroy|Note|note|title|accTitle|accDescr|link|links)\b'
$edgeRowRx = '^(?<src>\S+)\s+(?<arrow>\S*(?:--|->|\.\.|==|\.-|-\.)\S*)\s+(?<dst>\S+)$'
$evidencePathRx = '^(?<path>.+):(?<start>\d+)(?:-(?<end>\d+))?$'
$evidenceNewRx = '^new \(T\d+\)$'
$evidenceInferredRx = '^inferred$'

function Write-MapResult([string[]] $errors, [string[]] $warnings, $stats) {
    $result = [ordered]@{
        ok       = ($errors.Count -eq 0)
        errors   = @($errors)
        warnings = @($warnings)
        stats    = $stats
    }
    $result | ConvertTo-Json -Depth 6
}

function Exit-Usage([string] $message) {
    Write-MapResult @($message) @() $null
    exit 2
}

# --- Repository root ------------------------------------------------------------------------

function Find-RepoRootFromHeader([string[]] $mapLines, [string] $mapFull) {
    $value = $null
    foreach ($line in $mapLines) {
        $header = [regex]::Match($line, $headerRepoRx)
        if ($header.Success) { $value = Remove-Backticks ($header.Groups['value'].Value); break }
    }
    if ([string]::IsNullOrWhiteSpace($value)) { Exit-Usage "-RepoRoot is required when the map has no 'Repository:' header line" }
    $candidate = $value
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path (Split-Path -Parent $mapFull) $candidate }
    if (-not (Test-Path -LiteralPath $candidate)) { Exit-Usage "Repository: path not found: ${value}" }
    $dir = (Resolve-Path -LiteralPath $candidate).Path
    if (Test-Path -LiteralPath $dir -PathType Leaf) { $dir = Split-Path -Parent $dir }
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    Exit-Usage "no git root found above Repository: ${value}"
}

function Get-RepoRoot([string] $repoArg, [string[]] $mapLines, [string] $mapFull) {
    if (-not [string]::IsNullOrWhiteSpace($repoArg)) {
        if (-not (Test-Path -LiteralPath $repoArg -PathType Container)) { Exit-Usage "repo root not found: ${repoArg}" }
        return (Resolve-Path -LiteralPath $repoArg).Path.TrimEnd('\', '/')
    }
    return Find-RepoRootFromHeader $mapLines $mapFull
}

# --- Mermaid blocks -------------------------------------------------------------------------

function Get-MermaidBlocks([string[]] $mapLines, $errors) {
    $blocks = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $mapLines.Count; $i++) {
        if ($mapLines[$i] -notmatch $mermaidFenceRx) { continue }
        $close = $i + 1
        while ($close -lt $mapLines.Count -and $mapLines[$close] -notmatch $closingFenceRx) { $close++ }
        if ($close -ge $mapLines.Count) { $errors.Add("map line $($i + 1): Mermaid block is not closed"); break }
        $body = @()
        if ($close -gt $i + 1) { $body = @($mapLines[($i + 1)..($close - 1)]) }
        $blocks.Add(@{ mapLine = $i + 1; endIndex = $close; body = $body })
        $i = $close
    }
    return $blocks.ToArray()
}

# A block may start with a front-matter block (--- ... ---); the content starts after it.
function Get-ContentStart([string[]] $body) {
    $first = 0
    while ($first -lt $body.Count -and $body[$first].Trim() -eq '') { $first++ }
    if ($first -ge $body.Count -or $body[$first].Trim() -cnotmatch $frontMatterRx) { return $first }
    for ($k = $first + 1; $k -lt $body.Count; $k++) {
        if ($body[$k].Trim() -cmatch $frontMatterRx) { return $k + 1 }
    }
    return $body.Count
}

# The diagram-kind line: the first line from $start that is not blank or a %% comment (body length when none).
function Get-HeaderIndex([string[]] $body, [int] $start) {
    for ($k = $start; $k -lt $body.Count; $k++) {
        $line = $body[$k].Trim()
        if ($line -ne '' -and -not $line.StartsWith('%%')) { return $k }
    }
    return $body.Count
}

function Get-SupportedKind([string] $token) {
    switch -CaseSensitive ($token) {
        'classDiagram' { return 'classDiagram' }
        'flowchart' { return 'flowchart' }
        'graph' { return 'flowchart' }
        'sequenceDiagram' { return 'sequenceDiagram' }
        default { return $null }
    }
}

# --- Diagram model: nodes and structural edges ----------------------------------------------

function Remove-Generics([string] $name) {
    return ($name -replace '<[^>]*>|~[^~]*~', '')
}

function Add-DiagramNode($nodes, [string] $key, [string] $label, [bool] $styled) {
    if (-not $nodes.Contains($key)) { $nodes[$key] = @{ key = $key; label = $key; styled = $false } }
    $node = $nodes[$key]
    if ($label) { $node.label = $label }
    if ($styled) { $node.styled = $true }
    return $node
}

function Add-DiagramEdge($edges, [string] $src, [string] $arrow, [string] $dst) {
    $key = "$src|$arrow|$dst"
    foreach ($edge in $edges) { if ($edge.key -ceq $key) { return } }
    $edges.Add(@{ key = $key; src = $src; arrow = $arrow; dst = $dst })
}

# Test-NodeMatchesName compares names without generic parameters: Foo<T>, Foo~T~ and Foo all match Foo.

# The name that must appear in the evidence window: the label (the display name), then without parameters.
function Get-NodeSearchNames($node) {
    return @($node.label, (Remove-Generics $node.label))
}

function Test-NodeMatchesName($node, [string] $text) {
    $plain = Remove-Generics $text
    foreach ($name in @($node.key, $node.label)) {
        if ((Remove-Generics $name) -ceq $plain) { return $true }
    }
    return $false
}

function Get-ClassDiagramModel([string[]] $body) {
    $nodes = [ordered]@{}
    $edges = New-Object System.Collections.Generic.List[object]
    $unparsed = New-Object System.Collections.Generic.List[object]
    $inBody = $false
    for ($k = 0; $k -lt $body.Count; $k++) {
        $line = $body[$k].Trim()
        if ($inBody) {
            if ($line.StartsWith('}')) { $inBody = $false }
            continue
        }
        if ($line -eq '' -or $line.StartsWith('%%')) { continue }
        if ($line -eq '{') { $inBody = $true; continue }
        if ($line -cmatch $classDeclRx) {
            $name = $Matches['name']
            $styled = ($Matches['cls'] -eq 'added') -or ($Matches['word'] -eq 'added')
            [void](Add-DiagramNode $nodes (Remove-Generics $name) '' $styled)
            if ($line.Contains('{') -and -not $line.Contains('}')) { $inBody = $true }
            continue
        }
        if ($line -cmatch $classStyleRx) {
            $name = $Matches['name']
            $styled = ($Matches['cls'] -eq 'added')
            [void](Add-DiagramNode $nodes (Remove-Generics $name) '' $styled)
            continue
        }
        if ($line -cmatch $classRelRx) {
            $sourceName = $Matches['src']
            $arrow = $Matches['arrow']
            $targetName = $Matches['dst']
            $source = Remove-Generics $sourceName
            $target = Remove-Generics $targetName
            [void](Add-DiagramNode $nodes $source '' $false)
            [void](Add-DiagramNode $nodes $target '' $false)
            Add-DiagramEdge $edges $source $arrow $target
            continue
        }
        if ($line -cmatch $classMemberRx) {
            $name = $Matches['name']
            [void](Add-DiagramNode $nodes (Remove-Generics $name) '' $false)
            continue
        }
        if ($line -cmatch $classNoOpRx) { continue }
        $unparsed.Add(@{ index = $k; text = $line })
    }
    return @{ nodes = $nodes; edges = $edges; unparsed = $unparsed }
}

function Get-ShapeLabel([string] $shape) {
    $inner = ($shape -replace '^[\[\(\{>]+', '') -replace '[\]\)\}]+$', ''
    return $inner.Trim().Trim('"').Trim()
}

function Register-FlowchartNode($nodes, [System.Text.RegularExpressions.Match] $segment) {
    $label = ''
    if ($segment.Groups['shape'].Success) { $label = Get-ShapeLabel $segment.Groups['shape'].Value }
    $styled = $segment.Groups['cls'].Success -and ($segment.Groups['cls'].Value -eq 'added')
    $node = Add-DiagramNode $nodes $segment.Groups['id'].Value $label $styled
    return $node.key
}

# Reads a group of endpoints separated by '&' (node & node ...). Returns $null when the text does not fit.
function Read-FlowchartGroup([string] $line, [int] $position, [regex] $segmentRx, [regex] $ampRx, $nodes) {
    $segment = $segmentRx.Match($line, $position)
    if (-not $segment.Success) { return $null }
    $keys = New-Object System.Collections.Generic.List[string]
    $keys.Add((Register-FlowchartNode $nodes $segment))
    $end = $segment.Index + $segment.Length
    while ($true) {
        $amp = $ampRx.Match($line, $end)
        if (-not $amp.Success) { break }
        $segment = $segmentRx.Match($line, $amp.Index + $amp.Length)
        if (-not $segment.Success) { return $null }
        $keys.Add((Register-FlowchartNode $nodes $segment))
        $end = $segment.Index + $segment.Length
    }
    return @{ keys = $keys.ToArray(); end = $end }
}

# Reads one flowchart line: group (arrow group)*. Labelled arrows (-- text -->) are consumed by the arrow.
# Returns $false when the line does not fit this grammar or has trailing text (it is then reported, not checked).
function Read-FlowchartLine([string] $line, [regex] $segmentRx, [regex] $ampRx, [regex] $arrowRx, $nodes, $edges) {
    $group = Read-FlowchartGroup $line 0 $segmentRx $ampRx $nodes
    if ($null -eq $group) { return $false }
    $end = $group.end
    while ($true) {
        $arrow = $arrowRx.Match($line, $end)
        if (-not $arrow.Success) { break }
        $next = Read-FlowchartGroup $line ($arrow.Index + $arrow.Length) $segmentRx $ampRx $nodes
        if ($null -eq $next) { return $false }
        $arrowText = $arrow.Groups['arrow'].Value
        foreach ($source in $group.keys) {
            foreach ($target in $next.keys) { Add-DiagramEdge $edges $source $arrowText $target }
        }
        $group = $next
        $end = $next.end
    }
    return ($line.Substring($end).Trim().TrimEnd(';').Trim() -eq '')
}

function Get-FlowchartModel([string[]] $body) {
    $nodes = [ordered]@{}
    $edges = New-Object System.Collections.Generic.List[object]
    $unparsed = New-Object System.Collections.Generic.List[object]
    $segmentRx = [regex]::new($flowSegmentRx)
    $ampRx = [regex]::new($flowAmpRx)
    $arrowRx = [regex]::new($flowArrowRx)
    for ($k = 0; $k -lt $body.Count; $k++) {
        $line = $body[$k].Trim()
        if ($line -eq '' -or $line.StartsWith('%%')) { continue }
        $added = [regex]::Match($line, $flowClassAddedRx)
        if ($added.Success) {
            foreach ($id in ($added.Groups['ids'].Value -split ',')) { [void](Add-DiagramNode $nodes $id.Trim() '' $true) }
            continue
        }
        if ($line -cmatch $flowSkipRx) { continue }
        if (-not (Read-FlowchartLine $line $segmentRx $ampRx $arrowRx $nodes $edges)) {
            $unparsed.Add(@{ index = $k; text = $line })
        }
    }
    return @{ nodes = $nodes; edges = $edges; unparsed = $unparsed }
}

function Get-SequenceDiagramModel([string[]] $body) {
    $nodes = [ordered]@{}
    $edges = New-Object System.Collections.Generic.List[object]
    $unparsed = New-Object System.Collections.Generic.List[object]
    for ($k = 0; $k -lt $body.Count; $k++) {
        $line = $body[$k].Trim()
        if ($line -eq '' -or $line.StartsWith('%%')) { continue }
        if ($line -cmatch $seqDeclRx) {
            $id = $Matches['id']
            $displayName = $Matches['alias']
            [void](Add-DiagramNode $nodes $id $displayName $false)
            continue
        }
        if ($line -cmatch $seqMessageRx) {
            $source = $Matches['src']
            $target = $Matches['dst']
            [void](Add-DiagramNode $nodes $source '' $false)
            [void](Add-DiagramNode $nodes $target '' $false)
            continue
        }
        if ($line -cmatch $seqNoOpRx) { continue }
        $unparsed.Add(@{ index = $k; text = $line })
    }
    return @{ nodes = $nodes; edges = $edges; unparsed = $unparsed }
}

function Get-DiagramModel([string] $kind, [string[]] $body) {
    switch ($kind) {
        'classDiagram' { return Get-ClassDiagramModel $body }
        'flowchart' { return Get-FlowchartModel $body }
        default { return Get-SequenceDiagramModel $body }
    }
}

# --- Evidence tables ------------------------------------------------------------------------

function Split-TableCells([string] $line) {
    $inner = $line.Trim()
    if ($inner.StartsWith('|')) { $inner = $inner.Substring(1) }
    if ($inner.EndsWith('|')) { $inner = $inner.Substring(0, $inner.Length - 1) }
    # An escaped pipe (\|) stays in its cell, as in GitHub tables; needed for arrows such as <\|--.
    $cells = @($inner -split '(?<!\\)\|' | ForEach-Object { Remove-Backticks (($_.Trim()) -replace '\\\|', '|') })
    while ($cells.Count -lt 3) { $cells += '' }
    return $cells
}

# Strips one pair of surrounding backticks from a cell, so `Greeter` matches Greeter.
function Remove-Backticks([string] $text) {
    $trimmed = $text.Trim()
    if ($trimmed -match '^`(?<inner>.*)`$') { return $Matches['inner'].Trim() }
    return $trimmed
}

# Returns the first table with the header Element | Evidence | Note inside [fromIndex, endIndex): found and its rows.
function Get-EvidenceTable([string[]] $mapLines, [int] $fromIndex, [int] $endIndex) {
    $rows = New-Object System.Collections.Generic.List[object]
    $i = $fromIndex
    while ($i + 1 -lt $endIndex) {
        $isTable = $mapLines[$i].Trim().StartsWith('|') -and ($mapLines[$i + 1].Trim() -match $tableSeparatorRx)
        if (-not $isTable) { $i++; continue }
        $header = Split-TableCells $mapLines[$i]
        $isEvidence = ($header[0] -eq 'Element') -and ($header[1] -eq 'Evidence') -and ($header[2] -eq 'Note')
        $i += 2
        while ($i -lt $endIndex -and $mapLines[$i].Trim().StartsWith('|')) {
            if ($isEvidence) {
                $cells = Split-TableCells $mapLines[$i]
                $rows.Add(@{ mapLine = $i + 1; element = $cells[0]; evidence = $cells[1]; note = $cells[2] })
            }
            $i++
        }
        if ($isEvidence) { return @{ found = $true; rows = $rows.ToArray() } }
    }
    return @{ found = $false; rows = @() }
}

# A diagram's evidence table lies between its closing fence and the next Mermaid block (or end of file).
function Get-SectionEnd([string[]] $mapLines, [int] $afterIndex) {
    for ($j = $afterIndex + 1; $j -lt $mapLines.Count; $j++) {
        if ($mapLines[$j] -match $mermaidFenceRx) { return $j }
    }
    return $mapLines.Count
}

# Builds the supported diagrams; a block of another kind is reported as a warning and not checked.
function Get-Diagrams([string[]] $mapLines, $blocks, $warnings) {
    $diagrams = New-Object System.Collections.Generic.List[object]
    for ($b = 0; $b -lt $blocks.Count; $b++) {
        $block = $blocks[$b]
        $number = $b + 1
        $headerIndex = Get-HeaderIndex $block.body (Get-ContentStart $block.body)
        $token = '(empty)'
        if ($headerIndex -lt $block.body.Count) {
            $tokenMatch = [regex]::Match($block.body[$headerIndex].Trim(), $kindTokenRx)
            $token = $(if ($tokenMatch.Success) { $tokenMatch.Groups['kind'].Value } else { '(none)' })
        }
        $kind = Get-SupportedKind $token
        if ($null -eq $kind) { $warnings.Add("diagram ${number}: kind '${token}' not checked"); continue }
        $firstContent = $headerIndex + 1
        $content = @()
        if ($firstContent -lt $block.body.Count) { $content = @($block.body[$firstContent..($block.body.Count - 1)]) }
        $model = Get-DiagramModel $kind $content
        $sectionEnd = Get-SectionEnd $mapLines $block.endIndex
        $table = Get-EvidenceTable $mapLines ($block.endIndex + 1) $sectionEnd
        $diagrams.Add(@{
                number = $number; kind = $kind; mapLine = $block.mapLine; bodyMapLine = $block.mapLine + 1 + $firstContent
                nodes = $model.nodes; edges = $model.edges; unparsed = $model.unparsed
                tableFound = $table.found; rows = $table.rows
            })
    }
    return $diagrams.ToArray()
}

# --- Row matching -----------------------------------------------------------------------------

# A row names an edge when its element is "source arrow target"; otherwise it names a node.
function Resolve-RowMatch($diagram, [string] $element) {
    $edgeParts = [regex]::Match($element, $edgeRowRx)
    if (-not $edgeParts.Success) {
        $nodeTargets = @($diagram.nodes.Values | Where-Object { Test-NodeMatchesName $_ $element })
        return @{ isEdge = $false; edgeKeys = @(); targets = $nodeTargets }
    }
    $sourceText = $edgeParts.Groups['src'].Value
    $targetText = $edgeParts.Groups['dst'].Value
    $edgeKeys = New-Object System.Collections.Generic.List[string]
    $targets = New-Object System.Collections.Generic.List[object]
    foreach ($edge in $diagram.edges) {
        $source = $diagram.nodes[$edge.src]
        $target = $diagram.nodes[$edge.dst]
        if ((Test-NodeMatchesName $source $sourceText) -and (Test-NodeMatchesName $target $targetText)) {
            $edgeKeys.Add($edge.key)
            $targets.Add($target)
        }
    }
    return @{ isEdge = $true; edgeKeys = $edgeKeys.ToArray(); targets = $targets.ToArray() }
}

# --- Evidence checks --------------------------------------------------------------------------

function Read-EvidenceFile([string] $path, [string] $repoFull, [hashtable] $fileCache) {
    if ([System.IO.Path]::IsPathRooted($path)) {
        return @{ lines = $null; error = "evidence path must be repository-relative: ${path}" }
    }
    try {
        $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($repoFull, $path))
    }
    catch [System.ArgumentException], [System.NotSupportedException] {
        return @{ lines = $null; error = "invalid evidence path: ${path}" }
    }
    $prefix = $repoFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($full)) {
        return @{ lines = $null; error = "evidence path not found under repo root: ${path}" }
    }
    if (-not $fileCache.ContainsKey($full)) { $fileCache[$full] = [System.IO.File]::ReadAllLines($full) }
    return @{ lines = $fileCache[$full]; error = $null }
}

function Test-NameNearLines([string[]] $names, [string[]] $lines, [int] $start, [int] $end) {
    $from = [Math]::Max(1, $start - $nameWindow)
    $to = [Math]::Min($lines.Count, $end + $nameWindow)
    for ($n = $from; $n -le $to; $n++) {
        foreach ($name in $names) {
            if ([regex]::IsMatch($lines[$n - 1], '(?<!\w)' + [regex]::Escape($name) + '(?!\w)')) { return $true }
        }
    }
    return $false
}

# Line numbers beyond the range of [long] are capped, so they are reported as outside the file.
function ConvertTo-LineNumber([string] $digits) {
    $number = 0L
    if ([long]::TryParse($digits, [ref] $number)) { return $number }
    return [long]::MaxValue
}

function Test-EvidenceCell($row, $targets, [string] $where, [string] $repoFull, [hashtable] $fileCache, $errors, $warnings, $stats) {
    $location = "${where}, map line $($row.mapLine)"
    $evidence = $row.evidence
    if ($evidence -match $evidenceInferredRx) {
        $stats['inferred'] += 1
        $warnings.Add("${location}: inferred evidence for '$($row.element)'")
        return
    }
    if ($evidence -match $evidenceNewRx) {
        foreach ($target in @($targets)) {
            if (-not $target.styled) {
                $errors.Add("${location}: 'new' evidence for '$($target.key)' but it is not styled added (class X:::added, class X added, X:::added)")
            }
        }
        return
    }
    $pathMatch = [regex]::Match($evidence, $evidencePathRx)
    if (-not $pathMatch.Success) {
        $errors.Add("${location}: invalid evidence '${evidence}' for '$($row.element)' (expected path:line, path:start-end, inferred or new (T<n>))")
        return
    }
    $path = $pathMatch.Groups['path'].Value
    $startText = $pathMatch.Groups['start'].Value
    $endText = $startText
    if ($pathMatch.Groups['end'].Success) { $endText = $pathMatch.Groups['end'].Value }
    $start = ConvertTo-LineNumber $startText
    $end = ConvertTo-LineNumber $endText
    $file = Read-EvidenceFile $path $repoFull $fileCache
    if ($null -eq $file.lines) { $errors.Add("${location}: $($file.error)"); return }
    $lines = $file.lines
    if ($start -lt 1 -or $end -lt $start -or $end -gt $lines.Count) {
        $errors.Add("${location}: lines ${startText}-${endText} are outside ${path} ($($lines.Count) lines)")
        return
    }
    foreach ($target in @($targets)) {
        if (-not (Test-NameNearLines @(Get-NodeSearchNames $target) $lines ([int]$start) ([int]$end))) {
            $errors.Add("${location}: '$($target.label)' not found within ${nameWindow} lines of ${path}:${startText}-${endText}")
        }
    }
}

function Test-Diagram($diagram, [string] $repoFull, [hashtable] $fileCache, $errors, $warnings, $stats) {
    $where = "diagram $($diagram.number) ($($diagram.kind), map line $($diagram.mapLine))"
    $stats['diagrams'] += 1
    $stats['nodes'] += $diagram.nodes.Count
    $stats['edges'] += $diagram.edges.Count
    if ($diagram.nodes.Count -gt $maxNodesPerDiagram) {
        $warnings.Add("${where} has $($diagram.nodes.Count) nodes; the limit is $maxNodesPerDiagram - split the diagram")
    }
    foreach ($unparsedLine in $diagram.unparsed) {
        $warnings.Add("diagram $($diagram.number) line $($diagram.bodyMapLine + $unparsedLine.index): not understood, not checked: $($unparsedLine.text)")
    }
    if (-not $diagram.tableFound) {
        $errors.Add("${where}: no evidence table (Element | Evidence | Note)")
        return
    }
    $coveredNodes = @{}
    $coveredEdges = @{}
    foreach ($row in $diagram.rows) {
        $stats['rows'] += 1
        $match = Resolve-RowMatch $diagram $row.element
        if ($match.isEdge) {
            foreach ($key in $match.edgeKeys) { $coveredEdges[$key] = $true }
        }
        else {
            foreach ($node in $match.targets) { $coveredNodes[$node.key] = $true }
        }
        if (@($match.targets).Count -eq 0) {
            $kindWord = $(if ($match.isEdge) { 'edge' } else { 'element' })
            $warnings.Add("${where}, map line $($row.mapLine): row '$($row.element)' names no $kindWord of this diagram")
        }
        Test-EvidenceCell $row $match.targets $where $repoFull $fileCache $errors $warnings $stats
    }
    foreach ($node in $diagram.nodes.Values) {
        if ($coveredNodes.ContainsKey($node.key)) { continue }
        $labelText = $(if ($node.label -cne $node.key) { " ($($node.label))" } else { '' })
        $errors.Add("${where}: node '$($node.key)'${labelText} has no evidence row")
    }
    foreach ($edge in $diagram.edges) {
        if (-not $coveredEdges.ContainsKey($edge.key)) {
            $errors.Add("${where}: edge '$($edge.src) $($edge.arrow) $($edge.dst)' has no evidence row")
        }
    }
}

function Invoke-MapCheck([string] $mapFile, [string] $repoArg) {
    if ([string]::IsNullOrWhiteSpace($mapFile)) { Exit-Usage '-MapPath is required' }
    if (-not (Test-Path -LiteralPath $mapFile -PathType Leaf)) { Exit-Usage "map file not found: ${mapFile}" }
    $mapFull = (Resolve-Path -LiteralPath $mapFile).Path
    $mapLines = [System.IO.File]::ReadAllLines($mapFull)
    $repoFull = Get-RepoRoot $repoArg $mapLines $mapFull
    $errors = New-Object System.Collections.Generic.List[string]
    $warnings = New-Object System.Collections.Generic.List[string]
    $stats = [ordered]@{ diagrams = 0; nodes = 0; edges = 0; rows = 0; inferred = 0 }
    $blocks = @(Get-MermaidBlocks $mapLines $errors)
    if ($blocks.Count -eq 0 -and $errors.Count -eq 0) { Exit-Usage 'no Mermaid block found in the map (expected ```mermaid fences)' }
    $diagrams = @(Get-Diagrams $mapLines $blocks $warnings)
    if ($blocks.Count -gt 0 -and $diagrams.Count -eq 0) {
        $errors.Add('no supported diagram (classDiagram, flowchart/graph, sequenceDiagram) found')
    }
    $fileCache = @{}
    foreach ($diagram in $diagrams) {
        Test-Diagram $diagram $repoFull $fileCache $errors $warnings $stats
    }
    return @{ errors = $errors; warnings = $warnings; stats = $stats }
}

try {
    $result = Invoke-MapCheck $MapPath $RepoRoot
}
catch {
    Write-MapResult @("internal error: $($_.Exception.Message)") @() $null
    exit 2
}
Write-MapResult $result.errors.ToArray() $result.warnings.ToArray() $result.stats
if ($result.errors.Count -gt 0) { exit 1 }
exit 0
