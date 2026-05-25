#!/usr/bin/env dotnet-script
#nullable enable
#pragma warning disable CS8601  // TryGetValue out vars in nullable context — false positives in scripts
#load "./lib/events-core.csx"
#load "./lib/events-annotations.csx"
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
// export-events.csx — JSON export of Copilot CLI session telemetry (no Spectre dependency)
//
// USAGE:
//   dotnet script export-events.csx                               # uses events.jsonl next to this script; writes export.json beside it; also stdout
//   dotnet script export-events.csx path\to\events.jsonl          # explicit path
//   dotnet script export-events.csx path\to\session-dir\          # directory — finds events.jsonl inside
//   dotnet script export-events.csx <path> --out                  # write to <session-dir>\export.json (same as default)
//   dotnet script export-events.csx <path> --out <file>           # write to explicit output path
//
// OUTPUT:
//   • JSON written to stdout (always)
//   • JSON written to file (default: <session-dir>\export.json, or --out <path>)
//   • Confirmation line on stderr: "Wrote export.json → <path>"
//
// SCHEMA (top-level keys):
//   sessionId, sessionStart, sessionEnd, durationMs, shutdownType, cwd, copilotVersion
//   eventTypeCounts       — { type: count }
//   graphStats            — { total, totalEdges, roots, orphans, maxDepth, avgBranching,
//                             internalNodes, leafNodes, maxToolChainLen, hookPairs,
//                             unmatchedHookEnds }
//   hookPairs             — [ { hookType, durationMs, success } ]
//   modelChanges          — [ { ts, previousModel, newModel } ]
//   compactionEvents      — [ { ts, tokensBefore, tokensAfter } ]
//   modelMetrics          — { modelName: { requests, cost, inputTokens, outputTokens,
//                                          cacheReadTokens, cacheWriteTokens, reasoningTokens } }
//   toolStats             — [ { name, calls, successes, avgDurationMs, minDurationMs, maxDurationMs } ]
//   errors                — [ { ts, type, scope, detail } ]
//   errorCount            — int
//   subagentDispatches    — [ { label, agentName, callId, status, model, startTs, endTs,
//                               durationMs, inputTokens, outputTokens, totalTokens,
//                               toolCallCount, tools[], prompt, answer } ]
//   timeline              — { lanes: [ { laneId, label, events: [ EventAnnotation + ts/deltaMs/merged ] } ] }
//
// NOTE: contentSnippet in timeline events is truncated to 120 chars.
//       Full answer text lives in subagentDispatches[].answer.

// ── resolve input path ────────────────────────────────────────────────────────
var scriptDir = Path.GetDirectoryName(Path.GetFullPath(Environment.GetCommandLineArgs()
    .FirstOrDefault(a => a.EndsWith(".csx", StringComparison.OrdinalIgnoreCase))
    ?? "export-events.csx")) ?? Directory.GetCurrentDirectory();

// Parse --out flag
string? outputPath = null;
int outIdx = Args.IndexOf("--out");
if (outIdx >= 0)
{
    Args.RemoveAt(outIdx);
    if (outIdx < Args.Count && !Args[outIdx].StartsWith("--"))
    {
        outputPath = Args[outIdx];
        Args.RemoveAt(outIdx);
    }
    // --out with no argument → default beside input file (handled below)
}

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
    Console.Error.WriteLine("Usage: dotnet script export-events.csx [path/to/events.jsonl] [--out [path]]");
    return;
}

// Default output path: export.json beside the input file
outputPath ??= Path.Combine(Path.GetDirectoryName(inputPath)!, "export.json");

// ═════════════════════════════════════════════════════════════════════════════
// PASS 1 + SORT
// ═════════════════════════════════════════════════════════════════════════════

RunPass1(inputPath);
SortTimeline();

if (isJsonArray)
{
    Console.Error.WriteLine("ERROR: JSON array format is not supported.");
    return;
}

OpenEventFile(inputPath);

// ═════════════════════════════════════════════════════════════════════════════
// SESSION-LEVEL METADATA
// ═════════════════════════════════════════════════════════════════════════════

string? sessionId       = null;
string? sessionStart    = null;
string? sessionEnd      = null;
double? sessionDuration = null;
string? shutdownType    = null;
string? cwd             = null;
string? copilotVersion  = null;
int?    totalPremiumRequests   = null;
long?   totalApiDurationMs     = null;
long?   sessionStartTime       = null;
int?    codeChangesLinesAdded  = null;
int?    codeChangesLinesRemoved = null;
List<string>? codeChangesFiles = null;
string? currentModel           = null;
int?    currentTokens          = null;
int?    systemTokens           = null;
int?    conversationTokens     = null;
int?    toolDefinitionsTokens  = null;

if (offsetsByType.TryGetValue("session.start", out List<long> startOffsets) && startOffsets?.Count > 0)
{
    var ev = SeekLine(startOffsets[0]);
    var d  = ev["data"];
    sessionId      = SafeStr(d, "sessionId");
    sessionStart   = SafeStr(ev, "timestamp");
    copilotVersion = SafeStr(d, "copilotVersion");
    cwd            = SafeStr(d?["context"], "cwd");
}

if (offsetsByType.TryGetValue("session.shutdown", out List<long> shutOffsets) && shutOffsets?.Count > 0)
{
    var ev = SeekLine(shutOffsets[^1]);
    var d  = ev["data"];
    sessionEnd   = SafeStr(ev, "timestamp");
    shutdownType = SafeStr(d, "shutdownType");
    if (sessionStart != null && sessionEnd != null &&
        DateTimeOffset.TryParse(sessionStart, out var s) &&
        DateTimeOffset.TryParse(sessionEnd, out var e))
    {
        sessionDuration = (e - s).TotalMilliseconds;
    }
    try { totalPremiumRequests  = d?["totalPremiumRequests"]?.GetValue<int?>(); }  catch { }
    try { totalApiDurationMs    = d?["totalApiDurationMs"]?.GetValue<long?>();  }  catch { }
    try { sessionStartTime      = d?["sessionStartTime"]?.GetValue<long?>();    }  catch { }
    try { currentModel          = SafeStr(d, "currentModel"); }                    catch { }
    try { currentTokens         = d?["currentTokens"]?.GetValue<int?>();        }  catch { }
    try { systemTokens          = d?["systemTokens"]?.GetValue<int?>();         }  catch { }
    try { conversationTokens    = d?["conversationTokens"]?.GetValue<int?>();   }  catch { }
    try { toolDefinitionsTokens = d?["toolDefinitionsTokens"]?.GetValue<int?>(); } catch { }
    var cc = d?["codeChanges"];
    if (cc != null)
    {
        try { codeChangesLinesAdded   = cc["linesAdded"]?.GetValue<int?>();   } catch { }
        try { codeChangesLinesRemoved = cc["linesRemoved"]?.GetValue<int?>(); } catch { }
        var modArr = cc["filesModified"]?.AsArray();
        if (modArr != null)
            codeChangesFiles = modArr.Select(n => n?.GetValue<string>() ?? "").ToList();
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// GRAPH STATS
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
foreach (var id in orphans) if (!depth.ContainsKey(id)) ComputeDepths(id, 0);

int maxDepth   = depth.Values.Count > 0 ? depth.Values.Max() : 0;
int totalEdges = parentIndex.Count;
double avgBranch = childIndex.Values.Count > 0 ? childIndex.Values.Average(c => (double)c.Count) : 0;

int maxChainLen = 0;
{
    var visited = new HashSet<string>(StringComparer.Ordinal);
    foreach (var id in typeById.Keys)
    {
        if (typeById.GetValueOrDefault(id) != "tool.execution_complete") continue;
        var childrenOfId = childIndex.GetValueOrDefault(id);
        if (childrenOfId != null && childrenOfId.Any(c => typeById.GetValueOrDefault(c) == "tool.execution_complete")) continue;
        if (visited.Contains(id)) continue;
        int chainLen = 1;
        var curId = id;
        visited.Add(curId);
        while (parentIndex.TryGetValue(curId, out var pid) &&
               typeById.GetValueOrDefault(pid) == "tool.execution_complete" &&
               !visited.Contains(pid))
        { curId = pid; visited.Add(curId); chainLen++; }
        if (chainLen > maxChainLen) maxChainLen = chainLen;
    }
}

int unmatchedHookEnds = hookEndOffsetByInvId.Keys.Count(k => !hookStartOffsetByInvId.ContainsKey(k));

// ═════════════════════════════════════════════════════════════════════════════
// HOOK PAIRS
// ═════════════════════════════════════════════════════════════════════════════

var hookPairsList = new List<object>();
foreach (var (invId, startOff) in hookStartOffsetByInvId)
{
    var startEv  = SeekLine(startOff);
    var hookType = SafeStr(startEv["data"], "hookType") ?? "?";
    double? durMs = null;
    bool? success = null;
    if (hookEndOffsetByInvId.TryGetValue(invId, out var endOff))
    {
        var endEv = SeekLine(endOff);
        var startId = SafeStr(startEv, "id") ?? "";
        var endId   = SafeStr(endEv,   "id") ?? "";
        durMs   = ComputeDurationMs(startId, endId);
        success = TryGetBool(endEv["data"], "success");
    }
    hookPairsList.Add(new { hookType, durationMs = durMs, success });
}

// ═════════════════════════════════════════════════════════════════════════════
// MODEL CHANGES
// ═════════════════════════════════════════════════════════════════════════════

var modelChangesList = new List<object>();
if (offsetsByType.TryGetValue("session.model_change", out List<long> mcOffsets))
{
    foreach (var ev in SeekMany(mcOffsets).OrderBy(e => ParseTimestampStr(SafeStr(e, "timestamp"))))
    {
        var d = ev["data"];
        modelChangesList.Add(new
        {
            ts            = SafeStr(ev, "timestamp"),
            previousModel = SafeStr(d, "previousModel"),
            newModel      = SafeStr(d, "newModel")
        });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPACTION EVENTS
// ═════════════════════════════════════════════════════════════════════════════

var compactionList = new List<object>();
if (offsetsByType.TryGetValue("session.compaction_complete", out List<long> compOffsets2))
{
    foreach (var endEv in SeekMany(compOffsets2).OrderBy(e => ParseTimestampStr(SafeStr(e, "timestamp"))))
    {
        var d = endEv["data"];
        compactionList.Add(new
        {
            ts           = SafeStr(endEv, "timestamp"),
            tokensBefore = TryGetLong(d, "preCompactionTokens"),
            tokensAfter  = (long?)null   // post-compaction tokens not in this event
        });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// MODEL METRICS  (from session.shutdown)
// ═════════════════════════════════════════════════════════════════════════════

var modelMetricsDict = new Dictionary<string, object>(StringComparer.Ordinal);
if (offsetsByType.TryGetValue("session.shutdown", out List<long> shutOffsets2) && shutOffsets2?.Count > 0)
{
    var sd = SeekLine(shutOffsets2[^1])["data"];
    var mm = sd?["modelMetrics"];
    if (mm is JsonObject mmObj)
    {
        foreach (var kv in mmObj)
        {
            var mv = kv.Value;
            modelMetricsDict[kv.Key] = new
            {
                requests        = mv?["requests"]?["count"]?.GetValue<int?>(),
                cost            = mv?["requests"]?["cost"]?.GetValue<double?>(),
                inputTokens     = mv?["usage"]?["inputTokens"]?.GetValue<long?>(),
                outputTokens    = mv?["usage"]?["outputTokens"]?.GetValue<long?>(),
                cacheReadTokens  = mv?["usage"]?["cacheReadTokens"]?.GetValue<long?>(),
                cacheWriteTokens = mv?["usage"]?["cacheWriteTokens"]?.GetValue<long?>(),
                reasoningTokens  = mv?["usage"]?["reasoningTokens"]?.GetValue<long?>()
            };
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// TOOL STATS
// ═════════════════════════════════════════════════════════════════════════════

var toolStatsDict = new Dictionary<string, (int calls, int succ, List<double> durs)>(StringComparer.Ordinal);
foreach (var (callId, _) in toolStartOffsetByCallId)
{
    var name = toolNameByCallId.GetValueOrDefault(callId, "<unknown>");
    if (!toolStatsDict.TryGetValue(name, out var stat))
        toolStatsDict[name] = stat = (0, 0, new List<double>());

    int calls = stat.calls + 1;
    int succ  = stat.succ;
    var durs  = stat.durs;

    if (toolCompleteOffsetByCallId.TryGetValue(callId, out var complOff))
    {
        var complEv = SeekLine(complOff);
        try { if (complEv["data"]?["success"]?.GetValue<bool>() == true) succ++; } catch { }
        var startId = toolStartIdByCallId.GetValueOrDefault(callId, "");
        var complId = toolCompleteIdByCallId.GetValueOrDefault(callId, "");
        var d = ComputeDurationMs(startId, complId);
        if (d.HasValue) durs.Add(d.Value);
    }
    toolStatsDict[name] = (calls, succ, durs);
}

var toolStatsList = toolStatsDict
    .OrderByDescending(kv => kv.Value.calls)
    .Select(kv =>
    {
        var (calls, succ, durs) = kv.Value;
        return (object)new
        {
            name         = kv.Key,
            calls,
            successes    = succ,
            avgDurationMs = durs.Count > 0 ? (double?)durs.Average() : null,
            minDurationMs = durs.Count > 0 ? (double?)durs.Min()     : null,
            maxDurationMs = durs.Count > 0 ? (double?)durs.Max()     : null
        };
    }).ToList();

// ═════════════════════════════════════════════════════════════════════════════
// ERRORS
// ═════════════════════════════════════════════════════════════════════════════

var errorsList = new List<object>();
var errorEventTypes = new HashSet<string>(StringComparer.Ordinal)
    { "session.error", "abort", "session.warning" };

// Build subagent label map
var subagentCallIdToLabel = new Dictionary<string, string>(StringComparer.Ordinal);
{
    var nc = new Dictionary<string, int>(StringComparer.Ordinal);
    if (offsetsByType.TryGetValue("subagent.started", out var preOff) && preOff != null)
    {
        foreach (var off in preOff
            .Select(o => (o, ts: ParseTimestampStr(SafeStr(SeekLine(o), "timestamp"))))
            .OrderBy(x => x.ts).Select(x => x.o))
        {
            var ev = SeekLine(off);
            var d  = ev["data"];
            var name   = SafeStr(d, "agentName") ?? "<unknown>";
            var callId = SafeStr(d, "toolCallId") ?? "";
            nc[name] = nc.GetValueOrDefault(name) + 1;
            if (callId != "") subagentCallIdToLabel[callId] = $"{name} #{nc[name]}";
        }
    }
}

string ResolveScope(JsonNode ev, string type, JsonNode? data)
{
    var parentCallId = SafeStr(data, "parentToolCallId") ?? "";
    if (parentCallId != "" && subagentCallIdToLabel.TryGetValue(parentCallId, out var lbl)) return lbl;
    if (type is "subagent.failed" or "subagent.completed" or "subagent.started")
    {
        var callId = SafeStr(data, "toolCallId") ?? "";
        if (callId != "" && subagentCallIdToLabel.TryGetValue(callId, out var sl)) return sl;
    }
    return "orchestrator";
}

foreach (var (ts, offset) in sortedByTime)
{
    var ev   = SeekLine(offset);
    var type = SafeStr(ev, "type") ?? "";
    var data = ev["data"];
    bool isError = false;
    string detail = "";

    if (errorEventTypes.Contains(type)) { isError = true; detail = SafeStr(data,"message") ?? SafeStr(data,"reason") ?? ""; }
    else if (type == "subagent.failed")  { isError = true; detail = $"agent={SafeStr(data,"agentName")}  {SafeStr(data,"error")}"; }
    else if (type is "tool.execution_complete" or "permission.completed" or "hook.end")
    {
        try { if (data?["success"]?.GetValue<bool>() == false) { isError = true; detail = SafeStr(data,"error") ?? SafeStr(data,"message") ?? ""; } }
        catch { }
    }

    if (isError)
    {
        errorsList.Add(new
        {
            ts     = ts.ToString("o"),
            type,
            scope  = ResolveScope(ev, type, data),
            detail
        });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUBAGENT DISPATCHES
// ═════════════════════════════════════════════════════════════════════════════

var dispatchesList = new List<object>();

if (offsetsByType.TryGetValue("subagent.started", out List<long> subStartOffsets) && subStartOffsets?.Count > 0)
{
    var subagentDispatches = subStartOffsets
        .Select(off => (offset: off, ev: SeekLine(off)))
        .OrderBy(x => ParseTimestampStr(SafeStr(x.ev, "timestamp")))
        .ToList();

    // Assign labels
    var nc2 = new Dictionary<string, int>(StringComparer.Ordinal);
    var labels = new List<string>();
    foreach (var (_, ev) in subagentDispatches)
    {
        var name = SafeStr(ev["data"], "agentName") ?? "<unknown>";
        nc2[name] = nc2.GetValueOrDefault(name) + 1;
        labels.Add($"{name} #{nc2[name]}");
    }
    nc2.Clear();
    for (int i = 0; i < subagentDispatches.Count; i++)
    {
        var name   = SafeStr(subagentDispatches[i].ev["data"], "agentName") ?? "<unknown>";
        var callId = SafeStr(subagentDispatches[i].ev["data"], "toolCallId") ?? "";
        nc2[name] = nc2.GetValueOrDefault(name) + 1;
        labels[i] = $"{name} #{nc2[name]}";
        if (callId != "") subagentCallIdToLabel[callId] = labels[i];
    }

    // Build completed/failed lookups
    var subComp = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
    var subFail = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
    if (offsetsByType.TryGetValue("subagent.completed", out var co))
        foreach (var ev in SeekMany(co)) { var c = SafeStr(ev["data"],"toolCallId"); if (c!=null) subComp[c]=ev; }
    if (offsetsByType.TryGetValue("subagent.failed", out var fo))
        foreach (var ev in SeekMany(fo)) { var c = SafeStr(ev["data"],"toolCallId"); if (c!=null) subFail[c]=ev; }

    for (int idx = 0; idx < subagentDispatches.Count; idx++)
    {
        var (_, startEv)  = subagentDispatches[idx];
        var sd            = startEv["data"];
        var callId        = SafeStr(sd, "toolCallId") ?? "";
        var agentName     = SafeStr(sd, "agentName")  ?? "<unknown>";
        var label         = labels[idx];
        var startTs       = SafeStr(startEv, "timestamp");

        string status     = "in-progress";
        string? model     = null;
        string? endTs     = null;
        double? durMs     = null;
        long?   inputTok  = null;
        long?   outputTok = null;
        long?   totalTok  = null;
        int?    tcCount   = null;

        if (subComp.TryGetValue(callId, out var compEv))
        {
            var cd  = compEv["data"];
            status  = "completed";
            model   = SafeStr(cd, "model");
            endTs   = SafeStr(compEv, "timestamp");
            durMs   = cd?["durationMs"]?.GetValue<double?>();
            totalTok = cd?["totalTokens"]?.GetValue<long?>();
            tcCount  = cd?["totalToolCalls"]?.GetValue<int?>();
            inputTok = cd?["inputTokens"]?.GetValue<long?>();
            outputTok= cd?["outputTokens"]?.GetValue<long?>();
        }
        else if (subFail.ContainsKey(callId))
        {
            status = "failed";
        }

        // Prompt
        string? promptText = null;
        if (callId != "" && dispatchingMessageOffsetByCallId.TryGetValue(callId, out var msgOff))
        {
            var msgEv = SeekLine(msgOff);
            var toolReqs = msgEv["data"]?["toolRequests"]?.AsArray();
            if (toolReqs != null)
            {
                foreach (var req in toolReqs)
                {
                    if (SafeStr(req, "toolCallId") == callId)
                    {
                        promptText = SafeStr(req?["arguments"], "prompt")
                                  ?? SafeStr(req?["arguments"], "description")
                                  ?? req?["arguments"]?.ToJsonString();
                        break;
                    }
                }
            }
        }

        // Answer
        string? answerText = null;
        if (callId != "" && assistantMessageOffsetsByParentCallId.TryGetValue(callId, out var innerMsgOff))
        {
            for (int m = innerMsgOff.Count - 1; m >= 0; m--)
            {
                var msgEv   = SeekLine(innerMsgOff[m]);
                var tc      = msgEv["data"]?["toolRequests"]?.AsArray()?.Count ?? 0;
                var content = SafeStr(msgEv["data"], "content") ?? "";
                if (tc == 0 && content.Length > 0) { answerText = content; break; }
            }
        }

        // Tools used
        var toolsList = new List<object>();
        if (callId != "" && childToolCallIdsByParentCallId.TryGetValue(callId, out var childIds))
        {
            var toolCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var cid in childIds)
                toolCounts[toolNameByCallId.GetValueOrDefault(cid, "<unknown>")] =
                    toolCounts.GetValueOrDefault(toolNameByCallId.GetValueOrDefault(cid, "<unknown>")) + 1;
            foreach (var kv in toolCounts)
                toolsList.Add(new { name = kv.Key, count = kv.Value });
        }

        // Error (if failed)
        string? errorMsg = null;
        if (subFail.TryGetValue(callId, out var failEv))
            errorMsg = SafeStr(failEv["data"], "error");

        dispatchesList.Add(new
        {
            label,
            agentName,
            callId,
            status,
            model,
            startTs,
            endTs,
            durationMs   = durMs,
            inputTokens  = inputTok,
            outputTokens = outputTok,
            totalTokens  = totalTok,
            toolCallCount = tcCount,
            tools        = toolsList,
            prompt       = promptText,
            answer       = answerText,
            error        = errorMsg
        });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// TIMELINE — build lanes
// ═════════════════════════════════════════════════════════════════════════════

var orchestratorLane = new List<(DateTimeOffset ts, long offset)>();
var subagentLanes    = new Dictionary<string, List<(DateTimeOffset ts, long offset)>>(StringComparer.Ordinal);

if (offsetsByType.TryGetValue("subagent.started", out List<long> laneStartOffsets2) && laneStartOffsets2 != null)
{
    foreach (var off in laneStartOffsets2
        .Select(o => (o, ts: ParseTimestampStr(SafeStr(SeekLine(o), "timestamp"))))
        .OrderBy(x => x.ts).Select(x => x.o))
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

List<object> BuildLaneEvents(string laneCallId, List<(DateTimeOffset ts, long offset)> laneEvents)
{
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

    // Suppression sets
    var suppressedOffsets = new HashSet<long>();
    var endToStartOffset  = new Dictionary<long, long>();
    var laneOffsetToTs    = new Dictionary<long, DateTimeOffset>();
    foreach (var (ts, offset) in laneEvents) laneOffsetToTs[offset] = ts;

    foreach (var (ts, offset) in laneEvents)
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
    foreach (var (ts, offset) in laneEvents)
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
        foreach (var (ts, offset) in laneEvents)
        {
            var ev   = SeekLine(offset);
            var type = SafeStr(ev, "type") ?? "";
            var turnId = SafeStr(ev["data"], "turnId") ?? "";
            if (turnId == "") continue;
            if (type == "assistant.turn_start") pendingTurns[turnId] = offset;
            else if (type == "assistant.turn_end" && pendingTurns.TryGetValue(turnId, out var so))
            { suppressedOffsets.Add(so); endToStartOffset[offset] = so; pendingTurns.Remove(turnId); }
        }
    }
    {
        long compStartOff = -1;
        foreach (var (ts, offset) in laneEvents)
        {
            var ev   = SeekLine(offset);
            var type = SafeStr(ev, "type") ?? "";
            if (type == "session.compaction_start") compStartOff = offset;
            else if (type == "session.compaction_complete" && compStartOff >= 0)
            { suppressedOffsets.Add(compStartOff); endToStartOffset[offset] = compStartOff; compStartOff = -1; }
        }
    }

    var result = new List<object>();
    DateTimeOffset? prevTs = null;
    foreach (var (ts, offset) in laneEvents)
    {
        if (suppressedOffsets.Contains(offset)) continue;

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

        double? deltaMs = prevTs.HasValue ? (rowTs - prevTs.Value).TotalMilliseconds : null;
        prevTs = rowTs;

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

        // Serialize EventAnnotation fields + envelope fields as a flat anonymous object
        result.Add(new
        {
            ts          = rowTs.ToString("o"),
            deltaMs,
            merged      = isMerged ? (bool?)true : null,
            displayType = annotation.DisplayType,
            isFail      = annotation.IsFail ? (bool?)true : null,
            isFinalAnswer = annotation.IsFinalAnswer ? (bool?)true : null,
            toolName    = annotation.ToolName,
            toolArgs    = annotation.ToolArgs,
            toolSuccess = annotation.ToolSuccess,
            durationMs  = annotation.DurationMs,
            resultBytes = annotation.ResultBytes,
            hookType    = annotation.HookType,
            toolRequestCount = annotation.ToolRequestCount,
            toolRequestNames = annotation.ToolRequestNames,
            outputTokens = annotation.OutputTokens,
            contentSnippet = annotation.ContentSnippet,
            agentName   = annotation.AgentName,
            turnId      = annotation.TurnId,
            tokensBefore = annotation.TokensBefore,
            tokensAfter  = annotation.TokensAfter,
            annotation  = annotation.Annotation
        });
    }
    return result;
}

var timelineLanes = new List<object>();
timelineLanes.Add(new
{
    laneId = "orchestrator",
    label  = "ORCHESTRATOR",
    events = BuildLaneEvents("", orchestratorLane)
});
foreach (var (callId, laneEvts) in subagentLanes)
{
    var laneLabel = subagentCallIdToLabel.GetValueOrDefault(callId, callId[..Math.Min(12, callId.Length)] + "…");
    timelineLanes.Add(new
    {
        laneId = callId,
        label  = laneLabel,
        events = BuildLaneEvents(callId, laneEvts)
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSEMBLE + SERIALIZE
// ═════════════════════════════════════════════════════════════════════════════

var output = new
{
    sessionId,
    sessionStart,
    sessionEnd,
    durationMs   = sessionDuration,
    shutdownType,
    totalPremiumRequests,
    totalApiDurationMs,
    sessionStartTime,
    codeChanges  = codeChangesLinesAdded == null && codeChangesLinesRemoved == null ? null : (object)new
    {
        linesAdded    = codeChangesLinesAdded,
        linesRemoved  = codeChangesLinesRemoved,
        filesModified = codeChangesFiles ?? new List<string>()
    },
    currentModel,
    currentTokens,
    systemTokens,
    conversationTokens,
    toolDefinitionsTokens,
    cwd,
    copilotVersion,
    eventTypeCounts = typeCounts.OrderByDescending(kv => kv.Value)
                                .ToDictionary(kv => kv.Key, kv => kv.Value),
    graphStats = new
    {
        total         = total,
        totalEdges,
        roots         = roots.Count,
        orphans       = orphans.Count,
        maxDepth,
        avgBranching  = Math.Round(avgBranch, 2),
        internalNodes = childIndex.Count,
        leafNodes     = total - childIndex.Count,
        maxToolChainLen = maxChainLen,
        hookPairs     = hookStartOffsetByInvId.Count,
        unmatchedHookEnds
    },
    hookPairs        = hookPairsList,
    modelChanges     = modelChangesList,
    compactionEvents = compactionList,
    modelMetrics     = modelMetricsDict,
    toolStats        = toolStatsList,
    errorCount       = errorsList.Count,
    errors           = errorsList,
    subagentDispatches = dispatchesList,
    timeline         = new { lanes = timelineLanes }
};

var jsonOptions = new JsonSerializerOptions
{
    WriteIndented        = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

var json = JsonSerializer.Serialize(output, jsonOptions);

// ── Write to file ─────────────────────────────────────────────────────────────
File.WriteAllText(outputPath, json, Encoding.UTF8);
Console.Error.WriteLine($"Wrote export.json → {outputPath}");

// ── Write to stdout ───────────────────────────────────────────────────────────
Console.WriteLine(json);

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs!.Dispose();
