#!/usr/bin/env dotnet-script
#nullable enable
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
// session-metrics.csx — per-session metrics history built from <dir>/*/export.json (no export-events dependency)
//
// USAGE:
//   dotnet script session-metrics.csx <sessionStateDir> --out <file> [--from yyyy-MM-dd] [--to yyyy-MM-dd]
//   dotnet script session-metrics.csx <sessionStateDir>                 # JSON to stdout
//
// BEHAVIOUR:
//   • Reads each <dir>/<id>/export.json one file at a time (folders without export.json are ignored).
//   • A file that is not valid JSON, or whose root is not an object, is listed in skipped[] with a reason;
//     it never aborts the run.
//   • --from/--to filter on the UTC date of sessionStart (inclusive). Sessions outside the range are dropped.
//   • Exit 1 on usage errors (no directory, bad date). Exit 2 on a stale export (see STALE EXPORT). Exit 0 otherwise.
//
// OUTPUT CONTRACT (shared with render-dashboard.csx — v2 keeps every v1 field unchanged and only adds fields;
// never rename or remove a field):
//   { schemaVersion: 2, generatedAt, source, sessions: [ <session> ], skipped: [ { sessionId, reason } ] }
//   <session>: sessionId, startTime, endTime, cwd, gitRoot, copilotVersion, durationMs, userTurns,
//              premiumRequests, models[], cacheReadRatio, compactions, peakContextTokens, errors,
//              toolCalls, toolFailures, dispatches, dispatchFailures, repeatDispatches, writeAgentCalls,
//              builtinAgentDispatches, readOnlyAgentWriteCalls, mainPowershellCalls, agents[],
//              v2: costUsd, compactionCostUsd, agentUsage[], keepAlive, hookLatency
//   models[]: model, requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, v2: costUsd
//   agents[]: agentName, dispatches, failures, repeatDispatches, totalTokens, medianTokens, medianDurationMs, toolCalls
//   agentUsage[] (v2): agent, requests, costUsd, llmMs, toolMs, wallMs, otherMs
//   keepAlive (v2):    pings, costUsd, chains, wastedChains
//   hookLatency (v2):  count, totalMs, p50Ms, p90Ms
//
// STALE EXPORT: when <dir>/<id>/events.jsonl exists and export.json's sourceEventCount is missing or lower than
// the number of non-blank lines in it, the run stops before writing anything: it prints
// "export.json is stale for <id>: run export-events.csx first" to stderr and exits 2.
// A session folder without events.jsonl cannot be checked and is accepted.
//
// V2 FIELD MAPPING (all from export.json requests[], hookWindows[], timeline; null when the source is absent):
//   costUsd, compactionCostUsd  export costUsd (requests + compaction), compactionCostUsd. costUsd is null when the
//                               export has no per-request records (requests: []; e.g. the shutdown fallback of older
//                               CLIs): the USD cost is unknown, never 0.
//   models[].costUsd            sum of requests[].totalNanoAiu / 1e11 of that model; null without per-request records.
//   agentUsage[]                one row per agent, ordinal order. Agent = "main" for root requests (agentId null);
//                               a sub-agent request takes the agentName of the dispatch that carries its agentId
//                               (exact; exports written by export-events.csx since T20); only for older exports
//                               without dispatch agentId: the only agentName whose dispatch window
//                               [startTs, endTs + 5 s] holds all requests of that agentId; else "unattributed".
//                               costUsd = sum of the agent's request costs; null without per-request records.
//                               llmMs = sum of request durationMs; toolMs = sum of durationMs of timeline "tool"
//                               events in the agent's lane (orchestrator lane = main, other lanes = dispatch callId);
//                               wallMs = durationMs (main) or sum of the agent's dispatch durationMs;
//                               otherMs = max(0, wallMs − llmMs − toolMs).
//   keepAlive                   timeline user.message events of the orchestrator lane whose contentSnippet starts
//                               with "[keepalive]" are keep-alive messages. A ping is only the FIRST root request
//                               (agentId null) after a keep-alive message and before the next root user message;
//                               later root requests of that interaction are not pings. costUsd = pings' cost only;
//                               null without per-request records.
//                               chains = runs of keep-alive messages (with a ping) with no real user message
//                               between them. wastedChains = chains whose next real root request (first root
//                               request after the user message that ends the chain) is a miss:
//                               inputTokens >= 20000 and cacheWriteTokens > 0.5 x inputTokens.
//   hookLatency                 hookWindows[].durationMs: count, total, p50, p90 (nearest rank).
//
// FIELD MAPPING (export.json source → output field):
//   sessionId               sessionId (falls back to the folder name when absent)
//   startTime, endTime      sessionStart, sessionEnd (passed through unchanged)
//   cwd, copilotVersion     cwd, copilotVersion
//   gitRoot                 not present in export.json (only in events.jsonl) → always null
//   durationMs              durationMs
//   premiumRequests         totalPremiumRequests
//   errors                  errorCount
//   userTurns               count of timeline events with displayType "user.message" (all lanes)
//   models[]                modelMetrics { <model>: { requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
//   cacheReadRatio          sum(cacheReadTokens) / sum(inputTokens) over all models (inputTokens already includes the
//                           cache tokens, so the cache is counted once);
//                           null when any value is absent or the input total is 0
//   compactions             count of compactionEvents
//   peakContextTokens       max(compactionEvents[].tokensBefore, currentTokens) — a LOWER BOUND on the peak,
//                           because export.json has no per-turn context series
//   toolCalls, toolFailures toolStats[].calls summed; toolFailures = sum(calls − successes)
//   dispatches              subagentDispatches[] count
//   dispatchFailures        dispatches with status ≠ "completed"
//   repeatDispatches        dispatches whose agentName was already dispatched earlier in the same user turn.
//                           A dispatch's turn = the last timeline user.message at or before its startTs.
//   writeAgentCalls         toolStats["write_agent"].calls (0 when the tool has no entry)
//   builtinAgentDispatches  agentName in: explore, task, general-purpose, code-review, research,
//                           rubber-duck, security-review
//   readOnlyAgentWriteCalls edit + create counts in tools[] of read-only dispatches. A dispatch is read-only when
//                           agentName equals sub-expert, sub-explorer, sub-reviewer or sub-debugger, or starts with
//                           sub-expert-, sub-explorer-, sub-reviewer- or sub-researcher- (legacy/bare names,
//                           AGENTS.md §4). sub-expert-ado-writer and sub-writer-ado are NOT read-only.
//   mainPowershellCalls     timeline "tool" events with toolName "powershell" in the "orchestrator" lane only
//                           (subagent lanes excluded)
//   agents[]                one row per agentName (ordinal order): dispatches, failures (status ≠ completed),
//                           repeatDispatches, totalTokens (sum of totalTokens), medianTokens (median of
//                           totalTokens), medianDurationMs (median of durationMs), toolCalls (sum of toolCallCount)
//
// NULL RULE: an absent source field → null, never a guessed value. An aggregate is null when any value that
// feeds it is absent (e.g. totalTokens missing on one dispatch → agent totalTokens/medianTokens are null).
// Dispatches without agentName cannot be attributed: the agent-based fields are null for the session.

// ── arguments ─────────────────────────────────────────────────────────────────
string? outPath = null;
string? fromArg = null;
string? toArg = null;
var positional = new List<string>();
for (int argIndex = 0; argIndex < Args.Count; argIndex++)
{
    var token = Args[argIndex];
    if (token == "--out" && argIndex + 1 < Args.Count) outPath = Args[++argIndex];
    else if (token == "--from" && argIndex + 1 < Args.Count) fromArg = Args[++argIndex];
    else if (token == "--to" && argIndex + 1 < Args.Count) toArg = Args[++argIndex];
    else positional.Add(token);
}

var usage = "usage: dotnet script session-metrics.csx <sessionStateDir> [--out <file>] [--from yyyy-MM-dd] [--to yyyy-MM-dd]";
if (positional.Count != 1 || !Directory.Exists(positional[0]))
{
    Console.Error.WriteLine(usage);
    Environment.Exit(1);
}
if (!SessionMetrics.TryDay(fromArg, out var fromDay) || !SessionMetrics.TryDay(toArg, out var toDay))
{
    Console.Error.WriteLine(usage);
    Environment.Exit(1);
}

// ── build and write ───────────────────────────────────────────────────────────
MetricsRoot result;
try
{
    result = SessionMetrics.Build(positional[0], fromDay, toDay);
}
catch (StaleExportException stale)
{
    Console.Error.WriteLine($"export.json is stale for {string.Join(", ", stale.SessionIds)}: run export-events.csx first");
    Environment.Exit(2);
    return;
}
var json = JsonSerializer.Serialize(result, new JsonSerializerOptions
{
    WriteIndented = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
});

if (outPath == null)
{
    Console.WriteLine(json);
}
else
{
    var parent = Path.GetDirectoryName(Path.GetFullPath(outPath));
    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
    File.WriteAllText(outPath, json + "\n");
    Console.Error.WriteLine($"Wrote session metrics: {result.Sessions.Count} session(s), {result.Skipped.Count} skipped → {outPath}");
}

// ── output types (PascalCase here, camelCase on the wire) ─────────────────────
public sealed class MetricsRoot
{
    public int SchemaVersion { get; set; } = 2;
    public string GeneratedAt { get; set; } = "";
    public string Source { get; set; } = "";
    public List<SessionRow> Sessions { get; set; } = new();
    public List<SkipRow> Skipped { get; set; } = new();
}

public sealed class SkipRow
{
    public string SessionId { get; set; } = "";
    public string Reason { get; set; } = "";
}

public sealed class SessionRow
{
    public string SessionId { get; set; } = "";
    public string? StartTime { get; set; }
    public string? EndTime { get; set; }
    public string? Cwd { get; set; }
    public string? GitRoot { get; set; }
    public string? CopilotVersion { get; set; }
    public double? DurationMs { get; set; }
    public long? UserTurns { get; set; }
    public double? PremiumRequests { get; set; }
    public List<ModelRow>? Models { get; set; }
    public double? CacheReadRatio { get; set; }
    public long? Compactions { get; set; }
    public double? PeakContextTokens { get; set; }
    public long? Errors { get; set; }
    public long? ToolCalls { get; set; }
    public long? ToolFailures { get; set; }
    public long? Dispatches { get; set; }
    public long? DispatchFailures { get; set; }
    public long? RepeatDispatches { get; set; }
    public long? WriteAgentCalls { get; set; }
    public long? BuiltinAgentDispatches { get; set; }
    public long? ReadOnlyAgentWriteCalls { get; set; }
    public long? MainPowershellCalls { get; set; }
    public List<AgentRow>? Agents { get; set; }
    // schema v2
    public double? CostUsd { get; set; }
    public double? CompactionCostUsd { get; set; }
    public List<AgentUsageRow>? AgentUsage { get; set; }
    public KeepAliveRow? KeepAlive { get; set; }
    public HookLatencyRow? HookLatency { get; set; }
}

public sealed class StaleExportException : Exception
{
    public IReadOnlyList<string> SessionIds { get; }
    public StaleExportException(IReadOnlyList<string> sessionIds)
        : base("export.json is stale for " + string.Join(", ", sessionIds)) { SessionIds = sessionIds; }
}

public sealed class AgentUsageRow
{
    public string Agent { get; set; } = "";
    public long Requests { get; set; }
    public double? CostUsd { get; set; }
    public double? LlmMs { get; set; }
    public double? ToolMs { get; set; }
    public double? WallMs { get; set; }
    public double? OtherMs { get; set; }
}

public sealed class KeepAliveRow
{
    public long Pings { get; set; }
    public double? CostUsd { get; set; }
    public long Chains { get; set; }
    public long WastedChains { get; set; }
}

public sealed class HookLatencyRow
{
    public long Count { get; set; }
    public double TotalMs { get; set; }
    public double? P50Ms { get; set; }
    public double? P90Ms { get; set; }
}

public sealed class ModelRow
{
    public string Model { get; set; } = "";
    public double? Requests { get; set; }
    public double? InputTokens { get; set; }
    public double? OutputTokens { get; set; }
    public double? CacheReadTokens { get; set; }
    public double? CacheWriteTokens { get; set; }
    public double? CostUsd { get; set; }
}

public sealed class AgentRow
{
    public string AgentName { get; set; } = "";
    public long? Dispatches { get; set; }
    public long? Failures { get; set; }
    public long? RepeatDispatches { get; set; }
    public double? TotalTokens { get; set; }
    public double? MedianTokens { get; set; }
    public double? MedianDurationMs { get; set; }
    public double? ToolCalls { get; set; }
}

// ── logic ─────────────────────────────────────────────────────────────────────
public static class SessionMetrics
{
    static readonly HashSet<string> BuiltinAgents = new(StringComparer.Ordinal)
    {
        "explore", "task", "general-purpose", "code-review", "research", "rubber-duck", "security-review"
    };
    // Read-only by role (AGENTS.md §4 name drift): current and legacy bare/prefixed names.
    static readonly string[] ReadOnlyPrefixes = { "sub-expert-", "sub-explorer-", "sub-reviewer-", "sub-researcher-" };
    static readonly HashSet<string> ReadOnlyNames = new(StringComparer.Ordinal)
    {
        "sub-expert", "sub-explorer", "sub-reviewer", "sub-debugger"
    };
    const string AdoWriter = "sub-expert-ado-writer";

    sealed record LaneEvents(string? LaneId, List<JsonElement> Events);

    public static bool TryDay(string? text, out DateOnly? day)
    {
        day = null;
        if (text == null) return true;
        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)) return false;
        day = parsed;
        return true;
    }

    public static MetricsRoot Build(string dir, DateOnly? from, DateOnly? to)
    {
        var root = new MetricsRoot
        {
            GeneratedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            Source = Path.GetFullPath(dir)
        };
        var folders = Directory.GetDirectories(dir).OrderBy(d => Path.GetFileName(d), StringComparer.Ordinal);
        var staleSessionIds = new List<string>();
        foreach (var sessionDir in folders)
        {
            var folder = Path.GetFileName(sessionDir) ?? sessionDir;
            var file = Path.Combine(sessionDir, "export.json");
            if (!File.Exists(file)) continue;
            try
            {
                using var stream = File.OpenRead(file);
                using var doc = JsonDocument.Parse(stream);
                var el = doc.RootElement;
                if (el.ValueKind != JsonValueKind.Object) throw new InvalidDataException("export root is not a JSON object");

                if (from != null || to != null)
                {
                    if (!TryTs(el, "sessionStart", out var start))
                    {
                        root.Skipped.Add(new SkipRow { SessionId = folder, Reason = "sessionStart missing or unparseable; required for --from/--to" });
                        continue;
                    }
                    var day = DateOnly.FromDateTime(start.UtcDateTime);
                    if ((from != null && day < from.Value) || (to != null && day > to.Value)) continue;
                }

                // Stale exports are collected, not summarized: the run fails once, naming every stale session.
                if (!IsFresh(sessionDir, el))
                {
                    staleSessionIds.Add(folder);
                    continue;
                }
                root.Sessions.Add(Summarize(folder, el));
            }
            catch (JsonException ex)
            {
                root.Skipped.Add(new SkipRow { SessionId = folder, Reason = "export.json is not valid JSON: " + ex.Message });
            }
            catch (Exception ex)
            {
                root.Skipped.Add(new SkipRow { SessionId = folder, Reason = "export.json could not be summarized: " + ex.Message });
            }
        }
        if (staleSessionIds.Count > 0) throw new StaleExportException(staleSessionIds);
        return root;
    }

    // The export is stale when events.jsonl has more non-blank lines than the export read (sourceEventCount),
    // or when the export predates sourceEventCount. Without events.jsonl nothing can be compared.
    static bool IsFresh(string sessionDir, JsonElement el)
    {
        var eventsFile = Path.Combine(sessionDir, "events.jsonl");
        if (!File.Exists(eventsFile)) return true;
        long lines = 0;
        // The CLI may still be appending to the file: open it shared.
        using (var stream = new FileStream(eventsFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(stream))
        {
            string? line;
            while ((line = reader.ReadLine()) != null)
                if (!string.IsNullOrWhiteSpace(line)) lines++;
        }
        var recorded = Int(el, "sourceEventCount");
        return recorded != null && recorded.Value >= lines;
    }

    static SessionRow Summarize(string folder, JsonElement el)
    {
        var row = new SessionRow
        {
            SessionId = Str(el, "sessionId") ?? folder,
            StartTime = Str(el, "sessionStart"),
            EndTime = Str(el, "sessionEnd"),
            Cwd = Str(el, "cwd"),
            GitRoot = null,
            CopilotVersion = Str(el, "copilotVersion"),
            DurationMs = Num(el, "durationMs"),
            PremiumRequests = Num(el, "totalPremiumRequests"),
            Errors = Int(el, "errorCount"),
            Models = ModelsOf(el)
        };
        row.CacheReadRatio = CacheReadRatio(row.Models);

        var comps = ArrOf(el, "compactionEvents");
        row.Compactions = comps == null ? null : (long?)comps.Count;
        row.PeakContextTokens = Peak(el, comps);

        // timeline: user turns, orchestrator powershell calls
        var lanes = LanesOf(el);
        var userTs = new List<DateTimeOffset>();
        var userTsKnown = lanes != null;
        if (lanes != null)
        {
            long userMessages = 0;
            foreach (var lane in lanes)
                foreach (var ev in lane.Events)
                {
                    if (Str(ev, "displayType") != "user.message") continue;
                    userMessages++;
                    if (TryTs(ev, "ts", out var ts)) userTs.Add(ts);
                    else userTsKnown = false;
                }
            row.UserTurns = userMessages;
        }
        var orchestrator = lanes?.FirstOrDefault(l => l.LaneId == "orchestrator");
        row.MainPowershellCalls = orchestrator == null
            ? null
            : (long?)orchestrator.Events.Count(ev => Str(ev, "displayType") == "tool" && Str(ev, "toolName") == "powershell");

        var toolStats = ArrOf(el, "toolStats");
        if (toolStats != null)
        {
            double calls = 0, failures = 0;
            var ok = true;
            foreach (var t in toolStats)
            {
                var c = Num(t, "calls");
                var s = Num(t, "successes");
                if (c == null || s == null) { ok = false; break; }
                calls += c.Value;
                failures += c.Value - s.Value;
            }
            row.ToolCalls = ok ? (long?)calls : null;
            row.ToolFailures = ok ? (long?)failures : null;
            var write = toolStats.FirstOrDefault(t => Str(t, "name") == "write_agent");
            row.WriteAgentCalls = write.ValueKind == JsonValueKind.Undefined ? 0L : Int(write, "calls");
        }

        var disp = ArrOf(el, "subagentDispatches");
        if (disp != null)
        {
            row.Dispatches = disp.Count;
            row.DispatchFailures = AllHave(disp, "status")
                ? (long?)disp.Count(d => Str(d, "status") != "completed")
                : null;
            var flags = RepeatFlags(disp, userTsKnown ? userTs : null);
            row.RepeatDispatches = flags == null ? null : (long?)flags.Count(f => f);
            row.BuiltinAgentDispatches = AllHave(disp, "agentName")
                ? (long?)disp.Count(d => BuiltinAgents.Contains(Str(d, "agentName") ?? ""))
                : null;
            row.ReadOnlyAgentWriteCalls = ReadOnlyWrites(disp);
            row.Agents = AgentRows(disp, flags);
        }

        AddUsageFields(row, el, lanes);
        return row;
    }

    // ── schema v2: cost, time split, keep-alive chains and hook latency (from requests[], hookWindows[], timeline) ──

    const double NanoAiuPerUsd = 1e11;
    // Same rule as extensions/cache-keeper/lib/tracker.mjs isMiss, with the defaults of its lib/config.mjs miss section
    // (minContextTokens 20000, writeRatio 0.5).
    const double MissMinContextTokens = 20000;   // context size below which a cache miss is not counted as waste
    const double MissCacheWriteShare = 0.5;      // a miss re-writes more than this share of its context
    const string KeepAlivePrefix = "[keepalive]";
    const string MainAgent = "main";
    const string UnattributedAgent = "unattributed";
    static readonly TimeSpan DispatchWindowSlack = TimeSpan.FromSeconds(5);

    sealed record Req(DateTimeOffset Ts, string? AgentId, string Model, double? Input, double? CacheWrite, double? DurationMs, double? NanoAiu);
    sealed record Dispatch(string? CallId, string? Name, string? AgentId, DateTimeOffset? Start, DateTimeOffset? End, double? DurationMs);
    sealed record UserMessage(DateTimeOffset Ts, bool IsKeepAlive);

    static void AddUsageFields(SessionRow row, JsonElement el, List<LaneEvents>? lanes)
    {
        row.CostUsd = Num(el, "costUsd");
        row.CompactionCostUsd = Num(el, "compactionCostUsd");
        row.HookLatency = HookLatencyOf(el);

        var requests = RequestsOf(el);
        if (requests == null) return;
        // No per-request records (shutdown fallback): the USD total is unknown, so it is null, not 0.
        if (requests.Count == 0) row.CostUsd = null;
        var hasRecords = requests.Count > 0;

        if (row.Models != null)
            foreach (var model in row.Models)
                model.CostUsd = CostUsd(requests.Where(r => r.Model == model.Model), hasRecords);
        var dispatches = DispatchesOf(el);
        row.AgentUsage = AgentUsageOf(el, requests, dispatches, lanes);
        row.KeepAlive = KeepAliveOf(requests, lanes);
    }

    static List<Req>? RequestsOf(JsonElement el)
    {
        var items = ArrOf(el, "requests");
        if (items == null) return null;
        return items
            .Select(r => new Req(
                TryTs(r, "timestamp", out var ts) ? ts : DateTimeOffset.MinValue,
                Str(r, "agentId"),
                Str(r, "model") ?? "",
                Num(r, "inputTokens"),
                Num(r, "cacheWriteTokens"),
                Num(r, "durationMs"),
                Num(r, "totalNanoAiu")))
            .OrderBy(r => r.Ts)
            .ToList();
    }

    static List<Dispatch> DispatchesOf(JsonElement el) =>
        (ArrOf(el, "subagentDispatches") ?? new List<JsonElement>())
            .Select(d => new Dispatch(
                Str(d, "callId"),
                Str(d, "agentName"),
                Str(d, "agentId"),
                TryTs(d, "startTs", out var start) ? start : null,
                TryTs(d, "endTs", out var end) ? end : null,
                Num(d, "durationMs")))
            .ToList();

    // Sum of the request costs in USD. Null when the export has no per-request records (the cost is unknown) or a
    // record has no totalNanoAiu; 0 only when records exist and the set is empty.
    static double? CostUsd(IEnumerable<Req> requests, bool hasRecords)
    {
        if (!hasRecords) return null;
        double nano = 0;
        foreach (var r in requests)
        {
            if (r.NanoAiu is not double n) return null;
            nano += n;
        }
        return nano / NanoAiuPerUsd;
    }

    // agentId of a sub-agent request → agent name. A dispatch that carries the agentId wins; otherwise the only
    // agentName whose dispatch window holds every request of that agentId.
    static Dictionary<string, string> AgentNamesById(List<Req> requests, List<Dispatch> dispatches)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in requests.Where(r => r.AgentId != null).GroupBy(r => r.AgentId!, StringComparer.Ordinal))
        {
            var exact = dispatches.FirstOrDefault(d => d.AgentId == group.Key && d.Name != null);
            if (exact != null) { names[group.Key] = exact.Name!; continue; }
            var first = group.Min(r => r.Ts);
            var last = group.Max(r => r.Ts);
            var candidates = dispatches
                .Where(d => d.Name != null && d.Start != null && d.End != null
                            && d.Start.Value <= first && last <= d.End.Value + DispatchWindowSlack)
                .Select(d => d.Name!)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            names[group.Key] = candidates.Count == 1 ? candidates[0] : UnattributedAgent;
        }
        return names;
    }

    static List<AgentUsageRow> AgentUsageOf(JsonElement el, List<Req> requests, List<Dispatch> dispatches, List<LaneEvents>? lanes)
    {
        var namesById = AgentNamesById(requests, dispatches);
        string LabelOf(Req r) => r.AgentId == null ? MainAgent : namesById[r.AgentId];

        // tool time per agent from the timeline lanes (orchestrator lane = main; other lanes are dispatch call ids)
        var toolMs = new Dictionary<string, double>(StringComparer.Ordinal);
        if (lanes != null)
        {
            foreach (var lane in lanes)
            {
                var label = lane.LaneId == "orchestrator"
                    ? MainAgent
                    : dispatches.FirstOrDefault(d => d.CallId != null && d.CallId == lane.LaneId)?.Name ?? UnattributedAgent;
                double total = 0;
                foreach (var ev in lane.Events.Where(e => Str(e, "displayType") == "tool"))
                    total += Num(ev, "durationMs") ?? 0;
                toolMs[label] = toolMs.GetValueOrDefault(label) + total;
            }
        }

        var labels = requests.Select(LabelOf).Concat(toolMs.Keys).Distinct(StringComparer.Ordinal)
            .OrderBy(l => l, StringComparer.Ordinal).ToList();
        var rows = new List<AgentUsageRow>();
        foreach (var label in labels)
        {
            var own = requests.Where(r => LabelOf(r) == label).ToList();
            double? llm = own.All(r => r.DurationMs != null) ? own.Sum(r => r.DurationMs!.Value) : null;
            double? wall = label == MainAgent ? Num(el, "durationMs") : DispatchWallMs(dispatches, label);
            double? tools = lanes == null ? null : toolMs.GetValueOrDefault(label);
            rows.Add(new AgentUsageRow
            {
                Agent = label,
                Requests = own.Count,
                CostUsd = CostUsd(own, requests.Count > 0),
                LlmMs = llm,
                ToolMs = tools,
                WallMs = wall,
                OtherMs = wall == null || llm == null || tools == null ? null : Math.Max(0, wall.Value - llm.Value - tools.Value)
            });
        }
        return rows;
    }

    static double? DispatchWallMs(List<Dispatch> dispatches, string agentName)
    {
        var own = dispatches.Where(d => d.Name == agentName).ToList();
        if (own.Count == 0 || own.Any(d => d.DurationMs == null)) return null;
        return own.Sum(d => d.DurationMs!.Value);
    }

    static bool IsMiss(Req request) =>
        request.Input is double context && request.CacheWrite is double written
        && context >= MissMinContextTokens && written > MissCacheWriteShare * context;

    static KeepAliveRow? KeepAliveOf(List<Req> requests, List<LaneEvents>? lanes)
    {
        var orchestrator = lanes?.FirstOrDefault(l => l.LaneId == "orchestrator");
        if (orchestrator == null) return null;

        var messages = new List<UserMessage>();
        foreach (var ev in orchestrator.Events)
        {
            if (Str(ev, "displayType") != "user.message" || !TryTs(ev, "ts", out var ts)) continue;
            messages.Add(new UserMessage(ts, (Str(ev, "contentSnippet") ?? "").StartsWith(KeepAlivePrefix, StringComparison.Ordinal)));
        }
        messages = messages.OrderBy(m => m.Ts).ToList();
        var rootRequests = requests.Where(r => r.AgentId == null).ToList();

        long pings = 0, chains = 0, wastedChains = 0;
        double pingNanoAiu = 0;
        var pingCostKnown = true;
        var inChain = false;
        for (int i = 0; i < messages.Count; i++)
        {
            var until = i + 1 < messages.Count ? messages[i + 1].Ts : DateTimeOffset.MaxValue;
            // the first root request of this message's interaction
            var first = rootRequests.FirstOrDefault(r => r.Ts >= messages[i].Ts && r.Ts < until);
            if (messages[i].IsKeepAlive)
            {
                if (first == null) continue;
                pings++;
                if (first.NanoAiu is double nano) pingNanoAiu += nano; else pingCostKnown = false;
                if (!inChain) { chains++; inChain = true; }
            }
            else if (inChain)
            {
                inChain = false;
                if (first != null && IsMiss(first)) wastedChains++;
            }
        }
        return new KeepAliveRow
        {
            Pings = pings,
            CostUsd = requests.Count > 0 && pingCostKnown ? pingNanoAiu / NanoAiuPerUsd : null,
            Chains = chains,
            WastedChains = wastedChains
        };
    }

    static HookLatencyRow? HookLatencyOf(JsonElement el)
    {
        var windows = ArrOf(el, "hookWindows");
        if (windows == null) return null;
        var durations = windows.Select(w => Num(w, "durationMs")).OfType<double>().OrderBy(d => d).ToList();
        return new HookLatencyRow
        {
            Count = durations.Count,
            TotalMs = durations.Sum(),
            P50Ms = NearestRank(durations, 0.5),
            P90Ms = NearestRank(durations, 0.9)
        };
    }

    static double? NearestRank(List<double> sorted, double quantile) =>
        sorted.Count == 0 ? null : sorted[(int)Math.Ceiling(quantile * sorted.Count) - 1];

    // ── helpers: source access (every accessor is null-safe) ──────────────────

    static bool TryProp(JsonElement el, string name, out JsonElement value)
    {
        value = default;
        return el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out value);
    }

    static string? Str(JsonElement el, string name) =>
        TryProp(el, name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

    static double? Num(JsonElement el, string name) =>
        TryProp(el, name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetDouble() : (double?)null;

    static long? Int(JsonElement el, string name)
    {
        var v = Num(el, name);
        return v.HasValue ? (long)v.Value : (long?)null;
    }

    static bool TryTs(JsonElement el, string name, out DateTimeOffset ts)
    {
        ts = default;
        var text = Str(el, name);
        return text != null && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out ts);
    }

    static List<JsonElement>? ArrOf(JsonElement el, string name)
    {
        if (!TryProp(el, name, out var p) || p.ValueKind != JsonValueKind.Array) return null;
        return p.EnumerateArray().ToList();
    }

    static bool AllHave(List<JsonElement> items, string name) => items.All(i => Str(i, name) != null);

    static double? SumAll(List<JsonElement> items, string name)
    {
        double total = 0;
        foreach (var item in items)
        {
            var v = Num(item, name);
            if (v == null) return null;
            total += v.Value;
        }
        return total;
    }

    static double? MedianAll(List<JsonElement> items, string name)
    {
        var values = new List<double>();
        foreach (var item in items)
        {
            var v = Num(item, name);
            if (v == null) return null;
            values.Add(v.Value);
        }
        if (values.Count == 0) return null;
        values.Sort();
        var n = values.Count;
        return n % 2 == 1 ? values[n / 2] : (values[n / 2 - 1] + values[n / 2]) / 2.0;
    }

    // ── helpers: derived fields ───────────────────────────────────────────────

    static List<ModelRow>? ModelsOf(JsonElement el)
    {
        if (!TryProp(el, "modelMetrics", out var mm) || mm.ValueKind != JsonValueKind.Object) return null;
        var list = new List<ModelRow>();
        foreach (var m in mm.EnumerateObject())
        {
            list.Add(new ModelRow
            {
                Model = m.Name,
                Requests = Num(m.Value, "requests"),
                InputTokens = Num(m.Value, "inputTokens"),
                OutputTokens = Num(m.Value, "outputTokens"),
                CacheReadTokens = Num(m.Value, "cacheReadTokens"),
                CacheWriteTokens = Num(m.Value, "cacheWriteTokens")
            });
        }
        return list;
    }

    // inputTokens already includes cacheReadTokens and cacheWriteTokens (usage-records.csx), so the cache is counted once.
    static double? CacheReadRatio(List<ModelRow>? models)
    {
        if (models == null || models.Count == 0) return null;
        double input = 0, cacheRead = 0;
        foreach (var m in models)
        {
            if (m.InputTokens is not double i || m.CacheReadTokens is not double c) return null;
            input += i;
            cacheRead += c;
        }
        return input > 0 ? cacheRead / input : (double?)null;
    }

    static double? Peak(JsonElement el, List<JsonElement>? comps)
    {
        double? peak = Num(el, "currentTokens");
        if (comps != null)
        {
            foreach (var c in comps)
            {
                var before = Num(c, "tokensBefore");
                if (before.HasValue && (!peak.HasValue || before.Value > peak.Value)) peak = before;
            }
        }
        return peak;
    }

    static List<LaneEvents>? LanesOf(JsonElement el)
    {
        if (!TryProp(el, "timeline", out var timeline) || timeline.ValueKind != JsonValueKind.Object) return null;
        var lanes = ArrOf(timeline, "lanes");
        if (lanes == null) return null;
        return lanes.Select(l => new LaneEvents(Str(l, "laneId"), ArrOf(l, "events") ?? new List<JsonElement>())).ToList();
    }

    // Per dispatch: true when agentName was already dispatched earlier in the same user turn.
    // Returns null when the answer cannot be determined (no timeline/user turns, or missing agentName/startTs).
    static bool[]? RepeatFlags(List<JsonElement> disp, List<DateTimeOffset>? userTs)
    {
        var flags = new bool[disp.Count];
        if (disp.Count == 0) return flags;
        if (userTs == null || userTs.Count == 0) return null;
        var bounds = userTs.OrderBy(t => t).ToList();
        var seen = new HashSet<(int Turn, string Agent)>();
        for (int i = 0; i < disp.Count; i++)
        {
            var agent = Str(disp[i], "agentName");
            if (agent == null || !TryTs(disp[i], "startTs", out var start)) return null;
            var turn = bounds.Count(b => b <= start) - 1; // -1 = before the first user.message
            flags[i] = !seen.Add((turn, agent));
        }
        return flags;
    }

    static bool IsReadOnlyAgent(string agent) =>
        agent != AdoWriter
        && (ReadOnlyNames.Contains(agent) || ReadOnlyPrefixes.Any(p => agent.StartsWith(p, StringComparison.Ordinal)));

    static long? ReadOnlyWrites(List<JsonElement> disp)
    {
        long total = 0;
        foreach (var d in disp)
        {
            var agent = Str(d, "agentName");
            if (agent == null) return null;
            if (!IsReadOnlyAgent(agent)) continue;
            var tools = ArrOf(d, "tools");
            if (tools == null) return null;
            foreach (var t in tools)
            {
                var name = Str(t, "name");
                if (name != "edit" && name != "create") continue;
                var count = Num(t, "count");
                if (count == null) return null;
                total += (long)count.Value;
            }
        }
        return total;
    }

    static List<AgentRow> AgentRows(List<JsonElement> disp, bool[]? flags)
    {
        var names = disp.Select(d => Str(d, "agentName")).OfType<string>()
            .Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();
        var rows = new List<AgentRow>();
        foreach (var name in names)
        {
            var indices = new List<int>();
            for (int i = 0; i < disp.Count; i++)
            {
                if (Str(disp[i], "agentName") == name) indices.Add(i);
            }
            var items = indices.Select(i => disp[i]).ToList();
            rows.Add(new AgentRow
            {
                AgentName = name,
                Dispatches = items.Count,
                Failures = AllHave(items, "status") ? (long?)items.Count(d => Str(d, "status") != "completed") : null,
                RepeatDispatches = flags == null ? null : (long?)indices.Count(i => flags[i]),
                TotalTokens = SumAll(items, "totalTokens"),
                MedianTokens = MedianAll(items, "totalTokens"),
                MedianDurationMs = MedianAll(items, "durationMs"),
                ToolCalls = SumAll(items, "toolCallCount")
            });
        }
        return rows;
    }
}
