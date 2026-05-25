#!/usr/bin/env dotnet-script
#nullable enable
#r "nuget: Spectre.Console, 0.49.1"
#load "./lib/events-core.csx"
#load "./lib/events-annotations.csx"
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Spectre.Console;
// analyze-events.csx — GitHub Copilot CLI session telemetry analyzer
//
// USAGE:
//   dotnet script analyze-events.csx                               # uses events.jsonl next to this script
//   dotnet script analyze-events.csx path\to\events.jsonl          # explicit path
//   dotnet script analyze-events.csx path\to\session-dir\          # directory — finds events.jsonl inside
//   dotnet script analyze-events.csx <path> --timeline             # include full per-lane timeline
//   dotnet script analyze-events.csx <path> --dispatches           # include full subagent dispatch detail
//
// REQUIREMENTS:
//   dotnet-script 2.x  (dotnet tool install -g dotnet-script)
//   .NET 9 SDK
//
// ARCHITECTURE: Two-pass streaming design (see lib/events-core.csx)
//   Pass 1 — forward scan line-by-line; stores only byte offsets + lightweight metadata.
//   Pass 2 — all output sections seek to specific byte offsets and parse only needed lines.
//             Peak RAM is O(index size) not O(file size), supporting 1 GB+ sessions.
//
// SECTION ORDER:
//   C  Event Type Summary
//   E  Graph Statistics
//   H  Tool Usage Statistics
//   J  Error / Warning Report
//   K  Token / Cost Table
//   I  Subagent Dispatches  (only with --dispatches flag)
//   F  Timeline             (only with --timeline flag)

// ── tunables ─────────────────────────────────────────────────────────────────
const int TimelineMaxEventsPerLane = 0;     // cap per-lane timeline lines (0 = unlimited)

// ── parse flags ──────────────────────────────────────────────────────────────
bool showTimeline   = Args.Remove("--timeline");
bool showDispatches = Args.Remove("--dispatches");

// ── resolve input path ────────────────────────────────────────────────────────
var scriptDir = Path.GetDirectoryName(Path.GetFullPath(Environment.GetCommandLineArgs()
    .FirstOrDefault(a => a.EndsWith(".csx", StringComparison.OrdinalIgnoreCase))
    ?? "analyze-events.csx")) ?? Directory.GetCurrentDirectory();

string inputPath;
if (Args.Count > 0)
{
    var arg = Args[0];
    if (Directory.Exists(arg))
        inputPath = Path.Combine(arg, "events.jsonl");
    else
        inputPath = arg;
}
else
{
    inputPath = Path.Combine(scriptDir, "events.jsonl");
}

if (!File.Exists(inputPath))
{
    Console.Error.WriteLine($"ERROR: File not found: {inputPath}");
    Console.Error.WriteLine("Usage: dotnet script analyze-events.csx [path/to/events.jsonl] [--timeline] [--dispatches]");
    return;
}

// ═════════════════════════════════════════════════════════════════════════════
// PASS 1 + SORT
// ═════════════════════════════════════════════════════════════════════════════

RunPass1(inputPath);
SortTimeline();

if (isJsonArray)
{
    Console.Error.WriteLine("  WARNING: File appears to be a JSON array, not JSONL. JSON array format is not supported.");
    return;
}

OpenEventFile(inputPath);

// ═════════════════════════════════════════════════════════════════════════════
// HEADER
// ═════════════════════════════════════════════════════════════════════════════

AnsiConsole.Write(new Rule("[bold aqua]COPILOT CLI SESSION ANALYZER[/]").RuleStyle("cyan"));
AnsiConsole.MarkupLine($"  [silver]File   :[/] [white]{Markup.Escape(inputPath)}[/]");
AnsiConsole.MarkupLine($"  [silver]Format :[/] JSONL  (streaming two-pass)");
AnsiConsole.MarkupLine($"  [silver]Lines  :[/] [aqua]{totalLines}[/]  |  Loaded: [aqua]{total}[/]  |  Parse errors: [aqua]{parseErrors}[/]  |  Blank: [aqua]{skippedBlanks}[/]");
AnsiConsole.Write(new Rule().RuleStyle("cyan"));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C — EVENT TYPE SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

AnsiConsole.Write(new Rule("[bold yellow]EVENT TYPE SUMMARY[/]").RuleStyle("yellow").LeftJustified());
foreach (var kv in typeCounts.OrderByDescending(x => x.Value))
    AnsiConsole.MarkupLine($"  [aqua]{kv.Value,6}[/] [grey]({kv.Value * 100.0 / total,5:F1}%)[/]  [white]{Markup.Escape(kv.Key)}[/]");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E — GRAPH STATISTICS
// ═════════════════════════════════════════════════════════════════════════════

var depth       = new Dictionary<string, int>(StringComparer.Ordinal);
var subtreeSize = new Dictionary<string, int>(StringComparer.Ordinal);

void ComputeDepths(string id, int d)
{
    depth[id] = d;
    int sz = 1;
    if (childIndex.TryGetValue(id, out var ch))
        foreach (var c in ch) { ComputeDepths(c, d + 1); sz += subtreeSize.GetValueOrDefault(c, 0); }
    subtreeSize[id] = sz;
}

foreach (var r in roots) ComputeDepths(r, 0);
foreach (var id in orphans)
    if (!depth.ContainsKey(id)) ComputeDepths(id, 0);

int maxDepth   = depth.Values.Count > 0 ? depth.Values.Max() : 0;
int totalEdges = parentIndex.Count;
double avgBranch = childIndex.Values.Count > 0
    ? childIndex.Values.Average(c => (double)c.Count) : 0;

int maxChainLen = 0;
{
    var visited = new HashSet<string>(StringComparer.Ordinal);
    foreach (var id in typeById.Keys)
    {
        if (typeById.GetValueOrDefault(id) != "tool.execution_complete") continue;
        var childrenOfId = childIndex.GetValueOrDefault(id);
        bool hasCompleteChild = childrenOfId != null &&
            childrenOfId.Any(c => typeById.GetValueOrDefault(c) == "tool.execution_complete");
        if (hasCompleteChild) continue;
        if (visited.Contains(id)) continue;

        int chainLen = 1;
        var curId = id;
        visited.Add(curId);
        while (parentIndex.TryGetValue(curId, out var pid) &&
               typeById.GetValueOrDefault(pid) == "tool.execution_complete" &&
               !visited.Contains(pid))
        {
            curId = pid;
            visited.Add(curId);
            chainLen++;
        }
        if (chainLen > maxChainLen) maxChainLen = chainLen;
    }
}

AnsiConsole.Write(new Rule("[bold yellow]GRAPH STATISTICS[/]").RuleStyle("yellow").LeftJustified());
AnsiConsole.MarkupLine($"  [silver]Total events       :[/] [aqua]{total}[/]");
AnsiConsole.MarkupLine($"  [silver]Total edges        :[/] [aqua]{totalEdges}[/]");
AnsiConsole.MarkupLine($"  [silver]Root events        :[/] [aqua]{roots.Count}[/]");
AnsiConsole.MarkupLine($"  [silver]Orphan events      :[/] [aqua]{orphans.Count}[/]  [grey](parentId not found in this file)[/]");
AnsiConsole.MarkupLine($"  [silver]Max tree depth     :[/] [aqua]{maxDepth}[/]");
AnsiConsole.MarkupLine($"  [silver]Avg branching      :[/] [aqua]{avgBranch:F2}[/]");
AnsiConsole.MarkupLine($"  [silver]Internal nodes     :[/] [aqua]{childIndex.Count}[/]  [grey](have at least one child)[/]");
AnsiConsole.MarkupLine($"  [silver]Leaf nodes         :[/] [aqua]{total - childIndex.Count}[/]");
AnsiConsole.MarkupLine($"  [silver]Max tool chain len :[/] [aqua]{maxChainLen}[/]  [grey](serial tool.execution_complete chain)[/]");
AnsiConsole.MarkupLine($"  [silver]Hook pairs         :[/] [aqua]{hookStartOffsetByInvId.Count}[/] [grey]start /[/] [aqua]{hookEndOffsetByInvId.Count}[/] [grey]end[/]");
AnsiConsole.MarkupLine($"  [silver]Unmatched hook ends:[/] [aqua]{hookEndOffsetByInvId.Keys.Count(k => !hookStartOffsetByInvId.ContainsKey(k))}[/]");

if (roots.Count > 0)
{
    AnsiConsole.MarkupLine($"\n  [bold white]ROOT EVENTS:[/]");
    foreach (var r in roots)
    {
        var ev     = SeekLine(offsetById[r]);
        var ts     = SafeStr(ev, "timestamp") ?? "?";
        var evType = SafeStr(ev, "type") ?? "?";
        var sessId = SafeStr(ev["data"], "sessionId") ?? "";
        AnsiConsole.MarkupLine($"    [grey58]{Markup.Escape(ts)}[/]  [aqua]{Markup.Escape(evType)}[/]  [white]{Markup.Escape(sessId)}[/]  [grey](subtree: {subtreeSize.GetValueOrDefault(r)} events)[/]");
    }
}

if (orphans.Count > 0)
{
    AnsiConsole.MarkupLine($"\n  [bold white]ORPHAN EVENTS[/] [grey](sample, up to 10):[/]");
    foreach (var id in orphans.Take(10))
    {
        if (!offsetById.TryGetValue(id, out var off)) continue;
        var ev = SeekLine(off);
        AnsiConsole.MarkupLine($"    [aqua]{Markup.Escape(SafeStr(ev,"type") ?? ""),-35}[/]  [grey]parentId={Markup.Escape(SafeStr(ev,"parentId") ?? "")}  id={Markup.Escape(id)}[/]");
    }
}

// ── Build subagent label map early — needed by TIMELINE, ERROR, and DISPATCH sections ──
var subagentCallIdToLabel = new Dictionary<string, string>(StringComparer.Ordinal);
{
    var nameCounterPre = new Dictionary<string, int>(StringComparer.Ordinal);
    if (offsetsByType.TryGetValue("subagent.started", out List<long>? preOffsets) && preOffsets != null)
    {
        foreach (var off in preOffsets
            .Select(o => (o, ts: ParseTimestampStr(SafeStr(SeekLine(o), "timestamp"))))
            .OrderBy(x => x.ts)
            .Select(x => x.o))
        {
            var ev     = SeekLine(off);
            var d      = ev["data"];
            var name   = SafeStr(d, "agentName") ?? "<unknown>";
            var callId = SafeStr(d, "toolCallId") ?? "";
            nameCounterPre[name] = nameCounterPre.GetValueOrDefault(name) + 1;
            if (callId != "") subagentCallIdToLabel[callId] = $"{name} #{nameCounterPre[name]}";
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// LANE ASSIGNMENT — needed by TIMELINE and ERROR sections
// ═════════════════════════════════════════════════════════════════════════════

var orchestratorLane = new List<(DateTimeOffset ts, long offset)>();
var subagentLanes    = new Dictionary<string, List<(DateTimeOffset ts, long offset)>>(StringComparer.Ordinal);

if (offsetsByType.TryGetValue("subagent.started", out List<long>? laneStartOffsets) && laneStartOffsets != null)
{
    foreach (var off in laneStartOffsets
        .Select(o => (o, ts: ParseTimestampStr(SafeStr(SeekLine(o), "timestamp"))))
        .OrderBy(x => x.ts)
        .Select(x => x.o))
    {
        var ev  = SeekLine(off);
        var cid = SafeStr(ev["data"], "toolCallId");
        if (cid != null && !subagentLanes.ContainsKey(cid))
            subagentLanes[cid] = new List<(DateTimeOffset, long)>();
    }
}

foreach (var (ts, offset) in sortedByTime)
{
    var ev           = SeekLine(offset);
    var data         = ev["data"];
    var parentCallId = SafeStr(data, "parentToolCallId") ?? "";

    if (parentCallId != "" && subagentLanes.ContainsKey(parentCallId))
        subagentLanes[parentCallId].Add((ts, offset));
    else
        orchestratorLane.Add((ts, offset));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION H — TOOL USAGE STATISTICS
// ═════════════════════════════════════════════════════════════════════════════

AnsiConsole.Write(new Rule("[bold yellow]TOOL USAGE STATISTICS[/]").RuleStyle("yellow").LeftJustified());

var toolStats = new Dictionary<string, (int calls, int successes, List<double> durationMs)>(StringComparer.Ordinal);

foreach (var (callId, startOffset) in toolStartOffsetByCallId)
{
    var name = toolNameByCallId.GetValueOrDefault(callId, "<unknown>");
    if (!toolStats.TryGetValue(name, out var stat))
        toolStats[name] = stat = (0, 0, new List<double>());

    int calls = stat.calls + 1;
    int succ  = stat.successes;
    var durs  = stat.durationMs;

    if (toolCompleteOffsetByCallId.TryGetValue(callId, out var complOffset))
    {
        var complEv     = SeekLine(complOffset);
        var successNode = complEv["data"]?["success"];
        bool success = false;
        try { success = successNode?.GetValue<bool>() ?? false; } catch { }
        if (success) succ++;

        var startId = toolStartIdByCallId.GetValueOrDefault(callId, "");
        var complId = toolCompleteIdByCallId.GetValueOrDefault(callId, "");
        var startTs = startId != "" ? timestampById.GetValueOrDefault(startId, DateTimeOffset.MinValue) : DateTimeOffset.MinValue;
        var complTs = complId != "" ? timestampById.GetValueOrDefault(complId, DateTimeOffset.MinValue) : DateTimeOffset.MinValue;
        if (startTs != DateTimeOffset.MinValue && complTs != DateTimeOffset.MinValue)
            durs.Add((complTs - startTs).TotalMilliseconds);
    }

    toolStats[name] = (calls, succ, durs);
}

var toolTable = new Table()
    .NoBorder()
    .AddColumn(new TableColumn("[bold white]Tool Name[/]").NoWrap())
    .AddColumn(new TableColumn("[bold white]Calls[/]").RightAligned().NoWrap())
    .AddColumn(new TableColumn("[bold white]Succ%[/]").RightAligned().NoWrap())
    .AddColumn(new TableColumn("[bold white]Avg ms[/]").RightAligned().NoWrap())
    .AddColumn(new TableColumn("[bold white]Min ms[/]").RightAligned().NoWrap())
    .AddColumn(new TableColumn("[bold white]Max ms[/]").RightAligned().NoWrap());

foreach (var kv in toolStats.OrderByDescending(x => x.Value.calls))
{
    var (calls, succ, durs) = kv.Value;
    var pct     = calls > 0 ? succ * 100.0 / calls : 100.0;
    var succStr = calls > 0 ? $"{pct:F0}%" : "n/a";
    var avgStr  = durs.Count > 0 ? $"{durs.Average():F0}" : "n/a";
    var minStr  = durs.Count > 0 ? $"{durs.Min():F0}"     : "n/a";
    var maxStr  = durs.Count > 0 ? $"{durs.Max():F0}"     : "n/a";
    var succMarkup = pct < 100 && calls > 0 ? $"[red1]{Markup.Escape(succStr)}[/]" : $"[chartreuse2]{Markup.Escape(succStr)}[/]";
    toolTable.AddRow(
        $"[white]{Markup.Escape(kv.Key)}[/]",
        $"[aqua]{calls}[/]",
        succMarkup,
        $"[grey]{Markup.Escape(avgStr)}[/]",
        $"[grey]{Markup.Escape(minStr)}[/]",
        $"[grey]{Markup.Escape(maxStr)}[/]");
}
AnsiConsole.Write(toolTable);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION J — ERROR / WARNING REPORT
// ═════════════════════════════════════════════════════════════════════════════

AnsiConsole.Write(new Rule("[bold yellow]ERROR / WARNING REPORT[/]").RuleStyle("yellow").LeftJustified());

var errorEventTypes = new HashSet<string>(StringComparer.Ordinal)
    { "session.error", "abort", "session.warning" };

int errorCount = 0;
foreach (var (ts, offset) in sortedByTime)
{
    var ev   = SeekLine(offset);
    var type = SafeStr(ev, "type") ?? "";
    var data = ev["data"];
    var tsStr = ts.ToString("HH:mm:ss.fff");

    bool isError = false;
    string detail = "";

    if (errorEventTypes.Contains(type))
    {
        isError = true;
        detail  = SafeStr(data, "message") ?? SafeStr(data, "reason") ?? "";
    }
    else if (type == "subagent.failed")
    {
        isError = true;
        detail  = $"agent={SafeStr(data,"agentName")}  {SafeStr(data,"error")}";
    }
    else if (type is "tool.execution_complete" or "permission.completed" or "hook.end")
    {
        var successNode = data?["success"];
        if (successNode != null)
        {
            try
            {
                if (!successNode.GetValue<bool>())
                {
                    isError = true;
                    detail  = SafeStr(data, "error") ?? SafeStr(data, "message") ?? Truncate(data?.ToJsonString() ?? "", 100);
                }
            }
            catch { }
        }
    }

    if (isError)
    {
        string scope = ResolveEventScope(ev, type, data, subagentCallIdToLabel);
        errorCount++;
        bool isWarn = type == "session.warning";
        var typeMarkup = isWarn
            ? $"[yellow1]{Markup.Escape(type),-35}[/]"
            : $"[red1]{Markup.Escape(type),-35}[/]";
        AnsiConsole.MarkupLine(
            $"  [grey58]{Markup.Escape(tsStr)}[/]  {typeMarkup}  [silver][[{Markup.Escape(scope)}]][/]  [white]{Markup.Escape(detail)}[/]");
    }
}

if (errorCount == 0)
    AnsiConsole.MarkupLine("  [grey](no errors or warnings found)[/]");
else
    AnsiConsole.MarkupLine($"\n  [bold white]Total:[/] [red1]{errorCount}[/] errors/warnings");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION K — TOKEN / COST TABLE
// ═════════════════════════════════════════════════════════════════════════════

AnsiConsole.Write(new Rule("[bold yellow]TOKEN / COST TABLE[/]").RuleStyle("yellow").LeftJustified());

JsonNode? shutdownEv = null;
if (offsetsByType.TryGetValue("session.shutdown", out List<long>? shutdownOffsets) && shutdownOffsets != null && shutdownOffsets.Count > 0)
    shutdownEv = SeekLine(shutdownOffsets[^1]);

if (shutdownEv == null)
{
    AnsiConsole.MarkupLine("  [yellow1]WARNING:[/] No session.shutdown event found — session may be ongoing or truncated.");
}
else
{
    var sd = shutdownEv["data"];
    AnsiConsole.MarkupLine($"  [silver]Shutdown type        :[/] [white]{Markup.Escape(SafeStr(sd,"shutdownType") ?? "?")}[/]");
    AnsiConsole.MarkupLine($"  [silver]Session start (Unix) :[/] [white]{sd?["sessionStartTime"]}[/]");
    AnsiConsole.MarkupLine($"  [silver]Total API duration   :[/] [aqua]{sd?["totalApiDurationMs"]}[/]ms");
    AnsiConsole.MarkupLine($"  [silver]Total premium reqs   :[/] [aqua]{sd?["totalPremiumRequests"]}[/]");

    var cc = sd?["codeChanges"];
    if (cc != null)
        AnsiConsole.MarkupLine($"  [silver]Code changes         :[/] [chartreuse2]+{cc["linesAdded"]}[/] / [red1]-{cc["linesRemoved"]}[/] lines in [white]{cc["filesModified"]?.AsArray()?.Count ?? 0}[/] files");

    var curModel  = SafeStr(sd, "currentModel");
    var curTok    = sd?["currentTokens"]?.ToString();
    var sysTok    = sd?["systemTokens"]?.ToString();
    var convTok   = sd?["conversationTokens"]?.ToString();
    var toolDefTok = sd?["toolDefinitionsTokens"]?.ToString();
    if (curModel != null)
        AnsiConsole.MarkupLine($"  [silver]Current model        :[/] [white]{Markup.Escape(curModel)}[/]");
    if (curTok != null)
        AnsiConsole.MarkupLine($"  [silver]Current tokens       :[/] [aqua]{Markup.Escape(curTok)}[/]  [grey](system=[/][silver]{Markup.Escape(sysTok ?? "?")}[/][grey]  conversation=[/][silver]{Markup.Escape(convTok ?? "?")}[/][grey]  toolDefs=[/][silver]{Markup.Escape(toolDefTok ?? "?")}[/][grey])[/]");

    var mm = sd?["modelMetrics"];
    if (mm is JsonObject mmObj && mmObj.Count > 0)
    {
        long totalIn = 0, totalOut = 0, totalCacheRd = 0, totalCacheWr = 0;
        foreach (var kv in mmObj)
        {
            totalIn      += kv.Value?["usage"]?["inputTokens"]?.GetValue<long?>()      ?? 0;
            totalOut     += kv.Value?["usage"]?["outputTokens"]?.GetValue<long?>()     ?? 0;
            totalCacheRd += kv.Value?["usage"]?["cacheReadTokens"]?.GetValue<long?>()  ?? 0;
            totalCacheWr += kv.Value?["usage"]?["cacheWriteTokens"]?.GetValue<long?>() ?? 0;
        }

        Console.WriteLine();
        var tokenTable = new Table()
            .NoBorder()
            .AddColumn(new TableColumn("[bold white]Model[/]").NoWrap())
            .AddColumn(new TableColumn("[bold white]Reqs[/]").RightAligned().NoWrap())
            .AddColumn(new TableColumn("[bold white]Cost[/]").RightAligned().NoWrap())
            .AddColumn(new TableColumn("[bold white]Input[/]").RightAligned().Width(10).NoWrap())
            .AddColumn(new TableColumn("[bold white]Output[/]").RightAligned().Width(8).NoWrap())
            .AddColumn(new TableColumn("[bold white]CacheRd[/]").RightAligned().Width(10).NoWrap())
            .AddColumn(new TableColumn("[bold white]CacheWr[/]").RightAligned().Width(9).NoWrap())
            .AddColumn(new TableColumn("[bold white]Reason[/]").RightAligned().Width(8).NoWrap());

        foreach (var kv in mmObj)
        {
            var model  = kv.Key;
            var mv     = kv.Value;
            var reqs   = mv?["requests"]?["count"]?.ToString() ?? "";
            var cost   = mv?["requests"]?["cost"]?.ToString()  ?? "";
            var usage  = mv?["usage"];
            var costNum = mv?["requests"]?["cost"]?.GetValue<double?>() ?? 0;
            var costMarkup = costNum > 0 ? $"[yellow1]{Markup.Escape(cost)}[/]" : $"[grey]{Markup.Escape(cost)}[/]";
            tokenTable.AddRow(
                $"[white]{Markup.Escape(model)}[/]",
                $"[aqua]{Markup.Escape(reqs)}[/]",
                costMarkup,
                $"[silver]{Markup.Escape(usage?["inputTokens"]?.ToString()      ?? "")}[/]",
                $"[silver]{Markup.Escape(usage?["outputTokens"]?.ToString()     ?? "")}[/]",
                $"[grey]{Markup.Escape(usage?["cacheReadTokens"]?.ToString()  ?? "")}[/]",
                $"[grey]{Markup.Escape(usage?["cacheWriteTokens"]?.ToString() ?? "")}[/]",
                $"[grey]{Markup.Escape(usage?["reasoningTokens"]?.ToString()  ?? "")}[/]");
        }

        tokenTable.AddEmptyRow();
        tokenTable.AddRow(
            "[bold white]TOTAL[/]", "", "",
            $"[bold aqua]{totalIn}[/]",
            $"[bold aqua]{totalOut}[/]",
            $"[bold silver]{totalCacheRd}[/]",
            $"[bold silver]{totalCacheWr}[/]",
            "");

        AnsiConsole.Write(tokenTable);
    }
    else
    {
        AnsiConsole.MarkupLine("  [grey](no modelMetrics found in shutdown event)[/]");
    }
}

AnsiConsole.Write(new Rule().RuleStyle("cyan"));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION I — SUBAGENT DISPATCHES  (only with --dispatches flag)
// ═════════════════════════════════════════════════════════════════════════════

if (showDispatches)
{
    AnsiConsole.Write(new Rule("[bold yellow]SUBAGENT DISPATCHES[/]").RuleStyle("yellow").LeftJustified());

    if (!offsetsByType.TryGetValue("subagent.started", out List<long>? subStartOffsets) || subStartOffsets == null || subStartOffsets.Count == 0)
    {
        AnsiConsole.MarkupLine("  [grey](no subagent events found)[/]");
    }
    else
    {
        var subagentDispatches = subStartOffsets
            .Select(off => (offset: off, ev: SeekLine(off)))
            .OrderBy(x => ParseTimestampStr(SafeStr(x.ev, "timestamp")))
            .ToList();

        var nameCounter = new Dictionary<string, int>(StringComparer.Ordinal);
        var dispatchLabels = new List<string>();
        foreach (var (_, ev) in subagentDispatches)
        {
            var d    = ev["data"];
            var name = SafeStr(d, "agentName") ?? "<unknown>";
            nameCounter[name] = nameCounter.GetValueOrDefault(name) + 1;
            dispatchLabels.Add($"{name} #{nameCounter[name]}");
        }
        nameCounter.Clear();
        for (int idx = 0; idx < subagentDispatches.Count; idx++)
        {
            var d      = subagentDispatches[idx].ev["data"];
            var name   = SafeStr(d, "agentName") ?? "<unknown>";
            var callId = SafeStr(d, "toolCallId") ?? "";
            nameCounter[name] = nameCounter.GetValueOrDefault(name) + 1;
            var label = $"{name} #{nameCounter[name]}";
            dispatchLabels[idx] = label;
            if (callId != "") subagentCallIdToLabel[callId] = label;
        }

        var subCompletedByCallId = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        var subFailedByCallId    = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        if (offsetsByType.TryGetValue("subagent.completed", out var compOffsets))
            foreach (var ev in SeekMany(compOffsets))
            {
                var cid = SafeStr(ev["data"], "toolCallId");
                if (cid != null) subCompletedByCallId[cid] = ev;
            }
        if (offsetsByType.TryGetValue("subagent.failed", out var failOffsets))
            foreach (var ev in SeekMany(failOffsets))
            {
                var cid = SafeStr(ev["data"], "toolCallId");
                if (cid != null) subFailedByCallId[cid] = ev;
            }

        for (int idx = 0; idx < subagentDispatches.Count; idx++)
        {
            var (startOffset, startEv) = subagentDispatches[idx];
            var data      = startEv["data"];
            var callId    = SafeStr(data, "toolCallId") ?? "";
            var label     = dispatchLabels[idx];
            var startTs   = ParseTimestampStr(SafeStr(startEv, "timestamp"));

            string status   = "in-progress";
            string durStr   = "n/a";
            string tokStr   = "n/a";
            string modelStr = "?";
            string tcStr    = "n/a";
            string endTsStr = "";

            if (subCompletedByCallId.TryGetValue(callId, out var compEv))
            {
                var cd   = compEv["data"];
                status   = "completed";
                modelStr = SafeStr(cd, "model") ?? "?";
                var durMs  = cd?["durationMs"]?.GetValue<double?>()  ?? null;
                var tokens = cd?["totalTokens"]?.GetValue<long?>()   ?? null;
                var tc     = cd?["totalToolCalls"]?.GetValue<int?>()  ?? null;
                durStr  = durMs  != null ? $"{durMs.Value / 1000.0:F1}s" : "n/a";
                tokStr  = tokens != null ? tokens.Value.ToString("N0")   : "n/a";
                tcStr   = tc     != null ? tc.Value.ToString()           : "n/a";
                var endTs = ParseTimestampStr(SafeStr(compEv, "timestamp"));
                endTsStr = endTs != DateTimeOffset.MinValue ? $"  Completed: {endTs:HH:mm:ss.fff}" : "";
            }
            else if (subFailedByCallId.ContainsKey(callId))
            {
                status = "FAILED";
            }

            string promptText = "(not found)";
            if (callId != "" && dispatchingMessageOffsetByCallId.TryGetValue(callId, out var msgOffset))
            {
                var msgEv    = SeekLine(msgOffset);
                var toolReqs = msgEv["data"]?["toolRequests"]?.AsArray();
                if (toolReqs != null)
                {
                    foreach (var req in toolReqs)
                    {
                        if (SafeStr(req, "toolCallId") == callId)
                        {
                            var prompt = SafeStr(req?["arguments"], "prompt")
                                      ?? SafeStr(req?["arguments"], "description")
                                      ?? req?["arguments"]?.ToJsonString();
                            if (prompt != null) promptText = prompt;
                            break;
                        }
                    }
                }
            }

            string answerText = "(not found)";
            if (callId != "" && assistantMessageOffsetsByParentCallId.TryGetValue(callId, out var innerMsgOffsets))
            {
                for (int m = innerMsgOffsets.Count - 1; m >= 0; m--)
                {
                    var msgEv   = SeekLine(innerMsgOffsets[m]);
                    var tc      = msgEv["data"]?["toolRequests"]?.AsArray()?.Count ?? 0;
                    var content = SafeStr(msgEv["data"], "content") ?? "";
                    if (tc == 0 && content.Length > 0) { answerText = content; break; }
                }
            }

            string toolsSummary = "none";
            if (callId != "" && childToolCallIdsByParentCallId.TryGetValue(callId, out var childCallIds))
            {
                var toolCounts = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var cid in childCallIds)
                {
                    var tn = toolNameByCallId.GetValueOrDefault(cid, "<unknown>");
                    toolCounts[tn] = toolCounts.GetValueOrDefault(tn) + 1;
                }
                toolsSummary = string.Join(", ", toolCounts.Select(kv => kv.Value > 1 ? $"{kv.Key} ×{kv.Value}" : kv.Key));
            }

            var statusMarkup = status switch
            {
                "completed"   => $"[chartreuse2]{status}[/]",
                "FAILED"      => $"[bold red1]{status}[/]",
                _             => $"[yellow1]{Markup.Escape(status)}[/]"
            };
            AnsiConsole.Write(new Rule($"[bold chartreuse2]{Markup.Escape(label)}[/]").RuleStyle("green").LeftJustified());
            AnsiConsole.MarkupLine($"  [silver]Status   :[/] {statusMarkup}");
            AnsiConsole.MarkupLine($"  [silver]Started  :[/] [aqua]{startTs:HH:mm:ss.fff}[/]{Markup.Escape(endTsStr)}   [silver]Duration:[/] [white]{Markup.Escape(durStr)}[/]");
            AnsiConsole.MarkupLine($"  [silver]Model    :[/] [white]{Markup.Escape(modelStr)}[/]   [silver]Tokens:[/] [aqua]{Markup.Escape(tokStr)}[/]   [silver]Tool calls:[/] [aqua]{Markup.Escape(tcStr)}[/]");
            AnsiConsole.MarkupLine($"  [silver]Tools    :[/] [white]{Markup.Escape(toolsSummary)}[/]");
            AnsiConsole.MarkupLine($"  [silver]Prompt   :[/]");
            foreach (var line in WrapText(promptText, 13))
                AnsiConsole.MarkupLine(Markup.Escape(line));
            AnsiConsole.MarkupLine($"  [silver]Answer   :[/]");
            foreach (var line in WrapText(answerText, 13))
                AnsiConsole.MarkupLine(Markup.Escape(line));
            if (subFailedByCallId.TryGetValue(callId, out var fev))
            {
                var ferr = SafeStr(fev["data"], "error") ?? "?";
                AnsiConsole.MarkupLine($"  [bold red1]Error    :[/] {Markup.Escape(ferr)}");
            }
            Console.WriteLine();
        }
    }

    AnsiConsole.Write(new Rule().RuleStyle("cyan"));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION F — TIMELINE  (only with --timeline flag)
// ═════════════════════════════════════════════════════════════════════════════

if (showTimeline)
{
    AnsiConsole.Write(new Rule("[bold aqua]TIMELINE[/]  [grey](grouped by agent/subagent lane)[/]").RuleStyle("cyan").LeftJustified());

    PrintLane("ORCHESTRATOR", "", orchestratorLane, subagentCallIdToLabel);

    foreach (var (callId, laneEvents) in subagentLanes)
    {
        var laneLabel = subagentCallIdToLabel.GetValueOrDefault(callId, callId[..Math.Min(12, callId.Length)] + "…");
        PrintLane(laneLabel, callId, laneEvents, subagentCallIdToLabel);
    }

    AnsiConsole.Write(new Rule().RuleStyle("cyan"));
}

// ═════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

fs!.Dispose();

// ═════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

string ResolveEventScope(JsonNode ev, string type, JsonNode? data, Dictionary<string, string> callIdToLabel)
{
    var parentCallId = SafeStr(data, "parentToolCallId") ?? "";
    if (parentCallId != "" && callIdToLabel.TryGetValue(parentCallId, out var label))
        return label;
    if (type is "subagent.failed" or "subagent.completed" or "subagent.started")
    {
        var callId = SafeStr(data, "toolCallId") ?? "";
        if (callId != "" && callIdToLabel.TryGetValue(callId, out var saLabel))
            return saLabel;
    }
    return "orchestrator";
}

void PrintLane(string laneTitle, string laneCallId, List<(DateTimeOffset ts, long offset)> events,
               Dictionary<string, string> callIdToLabel)
{
    AnsiConsole.Write(new Rule($"[bold aqua]{Markup.Escape(laneTitle)}[/]").RuleStyle("blue").LeftJustified());

    if (events.Count == 0)
    {
        AnsiConsole.MarkupLine("  [grey](no events)[/]");
        Console.WriteLine();
        return;
    }

    // Detect final answer offset in this lane
    string finalAnswerOffset = "";
    if (laneCallId != "" && assistantMessageOffsetsByParentCallId.TryGetValue(laneCallId, out var innerOffsets))
    {
        for (int m = innerOffsets.Count - 1; m >= 0; m--)
        {
            var msgEv   = SeekLine(innerOffsets[m]);
            var tc      = msgEv["data"]?["toolRequests"]?.AsArray()?.Count ?? 0;
            var content = SafeStr(msgEv["data"], "content") ?? "";
            if (tc == 0 && content.Length > 0) { finalAnswerOffset = innerOffsets[m].ToString(); break; }
        }
    }

    // Build suppression set — start-half of merged pairs
    var suppressedOffsets = new HashSet<long>();
    var endToStartOffset  = new Dictionary<long, long>();
    var laneOffsetToTs    = new Dictionary<long, DateTimeOffset>();
    foreach (var (ts, offset) in events) laneOffsetToTs[offset] = ts;

    foreach (var (ts, offset) in events)
    {
        var ev = SeekLine(offset);
        if ((SafeStr(ev, "type") ?? "") != "tool.execution_start") continue;
        var callId = SafeStr(ev["data"], "toolCallId") ?? "";
        if (callId == "") continue;
        if (!toolCompleteOffsetByCallId.TryGetValue(callId, out var complOffset)) continue;
        if (!laneOffsetToTs.ContainsKey(complOffset)) continue;
        suppressedOffsets.Add(offset);
        endToStartOffset[complOffset] = offset;
    }

    foreach (var (ts, offset) in events)
    {
        var ev = SeekLine(offset);
        if ((SafeStr(ev, "type") ?? "") != "hook.start") continue;
        var invId = SafeStr(ev["data"], "hookInvocationId") ?? "";
        if (invId == "") continue;
        if (!hookEndOffsetByInvId.TryGetValue(invId, out var endOffset)) continue;
        if (!laneOffsetToTs.ContainsKey(endOffset)) continue;
        suppressedOffsets.Add(offset);
        endToStartOffset[endOffset] = offset;
    }

    {
        var pendingTurns = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var (ts, offset) in events)
        {
            var ev   = SeekLine(offset);
            var type = SafeStr(ev, "type") ?? "";
            var turnId = SafeStr(ev["data"], "turnId") ?? "";
            if (turnId == "") continue;
            if (type == "assistant.turn_start")
            {
                pendingTurns[turnId] = offset;
            }
            else if (type == "assistant.turn_end" && pendingTurns.TryGetValue(turnId, out var startOff))
            {
                suppressedOffsets.Add(startOff);
                endToStartOffset[offset] = startOff;
                pendingTurns.Remove(turnId);
            }
        }
    }

    {
        long compStartOff = -1;
        foreach (var (ts, offset) in events)
        {
            var ev   = SeekLine(offset);
            var type = SafeStr(ev, "type") ?? "";
            if (type == "session.compaction_start")
            {
                compStartOff = offset;
            }
            else if (type == "session.compaction_complete" && compStartOff >= 0)
            {
                suppressedOffsets.Add(compStartOff);
                endToStartOffset[offset] = compStartOff;
                compStartOff = -1;
            }
        }
    }

    int count = 0;
    DateTimeOffset? prevTs = null;
    foreach (var (ts, offset) in events)
    {
        if (suppressedOffsets.Contains(offset)) continue;

        if (TimelineMaxEventsPerLane > 0 && count >= TimelineMaxEventsPerLane)
        {
            AnsiConsole.MarkupLine($"  [grey]… {events.Count - count} more events (increase TimelineMaxEventsPerLane to see all)[/]");
            break;
        }
        count++;

        DateTimeOffset rowTs = ts;
        bool isMerged = endToStartOffset.TryGetValue(offset, out var startOff);

        var ev   = SeekLine(offset);
        var type = SafeStr(ev, "type") ?? "<unknown>";
        var data = ev["data"];

        if (isMerged)
        {
            bool useEndTs = type == "assistant.turn_end";
            rowTs = useEndTs ? ts : laneOffsetToTs[startOff];
        }

        var tsStr  = rowTs.ToString("HH:mm:ss.fff");
        var delta  = prevTs.HasValue ? $"+{(rowTs - prevTs.Value).TotalMilliseconds,7:F0}ms" : "        ";
        prevTs     = rowTs;

        EventAnnotation annotation;
        if (isMerged)
        {
            var startEv = SeekLine(startOff);
            annotation  = BuildMergedAnnotation(type, startEv["data"], data, offset, finalAnswerOffset);
        }
        else
        {
            annotation = BuildAnnotation(ev, type, data, offset, finalAnswerOffset);
        }

        var displayType = annotation.DisplayType;
        var isFail      = annotation.IsFail;
        var annot       = ToDisplayString(annotation);

        var typeColor = displayType switch
        {
            var t when t.StartsWith("tool")       => "aqua",
            var t when t.StartsWith("hook")       => "fuchsia",
            var t when t.StartsWith("assistant")  => "dodgerblue2",
            var t when t.StartsWith("subagent")   => "chartreuse2",
            var t when t.StartsWith("user")       => "bold white",
            var t when t.StartsWith("session")    => "grey62",
            var t when t.StartsWith("permission") => "cornflowerblue",
            _                                     => "white"
        };
        if (isFail) typeColor = "red1";

        var tsMarkup    = $"[grey58]{Markup.Escape(tsStr)}[/]";
        var deltaMarkup = delta.Trim().Length > 0 ? $"[grey42]{Markup.Escape(delta)}[/]" : "        ";
        var typeMarkup  = $"[{typeColor}]{Markup.Escape($"{displayType,-30}")}[/]";
        var failMark    = isFail ? " [bold red]✗[/]" : "";

        string AnnotMarkup(string raw)
        {
            var escaped = Markup.Escape(raw);
            escaped = escaped.Replace("[[FINAL ANSWER]]", "[bold yellow1][[FINAL ANSWER]][/]");
            return escaped;
        }

        var annotLines = WrapAnnotation(annot);
        AnsiConsole.MarkupLine($"  {tsMarkup} {deltaMarkup}  {typeMarkup}{failMark}  {AnnotMarkup(annotLines[0])}");
        for (int li = 1; li < annotLines.Count; li++)
            AnsiConsole.MarkupLine(AnnotMarkup(annotLines[li]));
    }
    Console.WriteLine();
}

List<string> WrapAnnotation(string text)
{
    const int lineWidth  = 100;
    const int contIndent = 61;
    var indent = new string(' ', contIndent);
    var result = new List<string>();

    foreach (var rawLine in text.Split('\n'))
    {
        var line = rawLine.TrimEnd('\r');
        if (line.Length == 0)
        {
            if (result.Count > 0) result.Add(indent);
            continue;
        }
        bool first = result.Count == 0;
        while (line.Length > lineWidth)
        {
            int breakAt = lineWidth;
            for (int i = lineWidth; i > lineWidth - 20 && i > 0; i--)
            {
                if (line[i] == ' ') { breakAt = i; break; }
            }
            result.Add(first ? line[..breakAt] : indent + line[..breakAt]);
            line  = line[breakAt..].TrimStart();
            first = false;
        }
        if (line.Length > 0)
            result.Add(first ? line : indent + line);
    }

    if (result.Count == 0) result.Add("");
    return result;
}

IEnumerable<string> WrapText(string text, int indentLen)
{
    var indent = new string(' ', indentLen);
    const int lineWidth = 100;
    foreach (var rawLine in text.Split('\n'))
    {
        var line = rawLine.TrimEnd('\r');
        if (line.Length == 0) continue;
        while (line.Length > lineWidth)
        {
            yield return indent + line[..lineWidth];
            line = line[lineWidth..];
        }
        if (line.Length > 0)
            yield return indent + line;
    }
}
