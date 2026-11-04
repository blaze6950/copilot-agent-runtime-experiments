#!/usr/bin/env dotnet-script
#nullable enable
// usage-records.csx — per-request cost and token accounting from session.usage_record events
//
// LOADED BY:
//   scripts/analyze-events.csx   (#load "./lib/usage-records.csx")
//   scripts/export-events.csx    (#load "./lib/usage-records.csx")
//
// REQUIRES (declared by lib/events-core.csx, loaded first by both scripts):
//   offsetsByType, hookStartOffsetByInvId, hookEndOffsetByInvId, SeekLine, SafeStr, ParseTimestampStr
//
// WHY THIS EXISTS
//   session.shutdown.data.modelMetrics is a CUMULATIVE session counter on current CLI versions (each resume
//   continues the previous totals), and requests made after the last shutdown are in no shutdown at all.
//   Summing the shutdown metrics therefore double counts the earlier segments and misses the open one. The
//   persisted session.usage_record events are one record per model request, so requests, tokens and cost are
//   taken from them. Compaction requests are not usage records; their cost comes from
//   session.compaction_complete.data.compactionTokensUsed.copilotUsage.totalNanoAiu.
//
// UNITS
//   copilotUsage.totalNanoAiu / 1e11 = USD. inputTokens ALREADY includes cacheReadTokens and cacheWriteTokens,
//   so the cache tokens are never added to the input again.
//   Premium request units (UsageRequest.PremiumRequestCost) = usage.cost of user-initiated requests only (initiator
//   "user", or missing: unknown is kept for compatibility). Requests with initiator "agent" or "sub-agent" also carry
//   a cost, but the CLI premium counter does not count it. Requests, tokens, durations and USD use every record.

using System.Text.Json.Nodes;

const double NanoAiuPerUsd = 1e11;
const string KeepAlivePrefix = "[keepalive]";
const string RequestKindUser = "user";
const string RequestKindKeepAlive = "keepalive";
const string RequestKindNotice = "notice";
const string RequestInitiatorUser = "user";
const string PreToolUseHookType = "preToolUse";

// One model request. Kind is set for root requests only (AgentId == null).
record UsageRequest(
    string Timestamp,
    string? AgentId,
    string Model,
    long InputTokens,
    long OutputTokens,
    long CacheReadTokens,
    long CacheWriteTokens,
    long ReasoningTokens,
    double PremiumRequestCost,
    long DurationMs,
    long TotalNanoAiu,
    string? Kind);

record ModelUsageTotals(
    long Requests,
    double PremiumRequestCost,
    long InputTokens,
    long OutputTokens,
    long CacheReadTokens,
    long CacheWriteTokens,
    long ReasoningTokens,
    long TotalNanoAiu);

static double UsdOfNanoAiu(long totalNanoAiu) => totalNanoAiu / NanoAiuPerUsd;

// Premium request units of one request: its cost when the initiator is "user" or missing, else 0.
// The only place that decides which requests count as premium units (export totals, model metrics, analyze).
static double PremiumRequestUnitsOf(string? initiator, double cost)
    => string.IsNullOrEmpty(initiator) || initiator == RequestInitiatorUser ? cost : 0;

// Numeric field of a JSON object; 0 when it is missing or not a number.
static double NumberOf(JsonNode? node, string key)
{
    try
    {
        if (node?[key] is JsonValue value)
        {
            if (value.TryGetValue<long>(out var whole)) return whole;
            if (value.TryGetValue<double>(out var fraction)) return fraction;
        }
    }
    catch { }
    return 0;
}

static string? AgentIdOf(JsonNode ev)
{
    var agentId = SafeStr(ev, "agentId");
    return string.IsNullOrWhiteSpace(agentId) ? null : agentId;
}

// Root user messages (no envelope agentId) in time order, with the kind each one gives to the requests after it.
List<(DateTimeOffset ts, string kind)> LoadRootUserMessageKinds()
{
    var messages = new List<(DateTimeOffset ts, long offset, string kind)>();
    if (offsetsByType.TryGetValue("user.message", out var offsets))
    {
        foreach (var offset in offsets)
        {
            var ev = SeekLine(offset);
            if (AgentIdOf(ev) != null) continue;
            var content = SafeStr(ev["data"], "content") ?? "";
            var kind = content.StartsWith(KeepAlivePrefix, StringComparison.Ordinal) ? RequestKindKeepAlive : RequestKindUser;
            messages.Add((ParseTimestampStr(SafeStr(ev, "timestamp")), offset, kind));
        }
    }
    return messages.OrderBy(m => m.ts).ThenBy(m => m.offset).Select(m => (m.ts, m.kind)).ToList();
}

// All persisted session.usage_record events as requests, in time order. Empty when the CLI wrote none.
List<UsageRequest> LoadUsageRequests()
{
    var loaded = new List<(DateTimeOffset ts, long offset, UsageRequest request)>();
    if (!offsetsByType.TryGetValue("session.usage_record", out var offsets)) return new List<UsageRequest>();

    var rootMessageKinds = LoadRootUserMessageKinds();
    foreach (var offset in offsets)
    {
        var ev = SeekLine(offset);
        var usage = ev["data"]?["usage"];
        if (usage == null) continue;
        var timestamp = SafeStr(ev, "timestamp") ?? "";
        loaded.Add((ParseTimestampStr(timestamp), offset, new UsageRequest(
            timestamp,
            AgentIdOf(ev),
            SafeStr(usage, "model") ?? "<unknown>",
            (long)NumberOf(usage, "inputTokens"),
            (long)NumberOf(usage, "outputTokens"),
            (long)NumberOf(usage, "cacheReadTokens"),
            (long)NumberOf(usage, "cacheWriteTokens"),
            (long)NumberOf(usage, "reasoningTokens"),
            PremiumRequestUnitsOf(SafeStr(usage, "initiator"), NumberOf(usage, "cost")),
            (long)NumberOf(usage, "duration"),
            (long)NumberOf(usage["copilotUsage"], "totalNanoAiu"),
            null)));
    }

    var requests = new List<UsageRequest>(loaded.Count);
    int messageIndex = 0;   // number of root user messages at or before the current request
    foreach (var (ts, _, request) in loaded.OrderBy(l => l.ts).ThenBy(l => l.offset))
    {
        while (messageIndex < rootMessageKinds.Count && rootMessageKinds[messageIndex].ts <= ts) messageIndex++;
        string? kind = null;
        if (request.AgentId == null)
            kind = messageIndex > 0 ? rootMessageKinds[messageIndex - 1].kind : RequestKindNotice;
        requests.Add(request with { Kind = kind });
    }
    return requests;
}

// Totals per model, in the order the models first appear.
Dictionary<string, ModelUsageTotals> AggregateUsageByModel(IEnumerable<UsageRequest> requests)
{
    var totalsByModel = new Dictionary<string, ModelUsageTotals>(StringComparer.Ordinal);
    foreach (var request in requests)
    {
        var current = totalsByModel.GetValueOrDefault(request.Model) ?? new ModelUsageTotals(0, 0, 0, 0, 0, 0, 0, 0);
        totalsByModel[request.Model] = new ModelUsageTotals(
            current.Requests + 1,
            current.PremiumRequestCost + request.PremiumRequestCost,
            current.InputTokens + request.InputTokens,
            current.OutputTokens + request.OutputTokens,
            current.CacheReadTokens + request.CacheReadTokens,
            current.CacheWriteTokens + request.CacheWriteTokens,
            current.ReasoningTokens + request.ReasoningTokens,
            current.TotalNanoAiu + request.TotalNanoAiu);
    }
    return totalsByModel;
}

static long CompactionNanoAiuOf(JsonNode compactionCompleteEvent)
    => (long)NumberOf(compactionCompleteEvent["data"]?["compactionTokensUsed"]?["copilotUsage"], "totalNanoAiu");

long SumCompactionNanoAiu()
{
    long total = 0;
    if (offsetsByType.TryGetValue("session.compaction_complete", out var offsets))
        foreach (var offset in offsets) total += CompactionNanoAiuOf(SeekLine(offset));
    return total;
}

// preToolUse hook windows (hook.start to hook.end, paired by hookInvocationId) with the agent that ran them.
// A start without an end is not a window. agentId is null for the root agent.
List<JsonObject> BuildPreToolUseHookWindows()
{
    var windows = new List<(DateTimeOffset startTs, JsonObject window)>();
    foreach (var (invocationId, startOffset) in hookStartOffsetByInvId)
    {
        if (!hookEndOffsetByInvId.TryGetValue(invocationId, out var endOffset)) continue;
        var startEv = SeekLine(startOffset);
        if (SafeStr(startEv["data"], "hookType") != PreToolUseHookType) continue;
        var endEv = SeekLine(endOffset);
        var startTs = ParseTimestampStr(SafeStr(startEv, "timestamp"));
        var endTs = ParseTimestampStr(SafeStr(endEv, "timestamp"));
        windows.Add((startTs, new JsonObject
        {
            ["hookInvocationId"] = invocationId,
            ["agentId"] = AgentIdOf(startEv),
            ["startTs"] = SafeStr(startEv, "timestamp"),
            ["endTs"] = SafeStr(endEv, "timestamp"),
            ["durationMs"] = (endTs - startTs).TotalMilliseconds
        }));
    }
    return windows.OrderBy(w => w.startTs).Select(w => w.window).ToList();
}

JsonObject UsageRequestToJson(UsageRequest request) => new JsonObject
{
    ["timestamp"] = request.Timestamp,
    ["agentId"] = request.AgentId,
    ["model"] = request.Model,
    ["inputTokens"] = request.InputTokens,
    ["outputTokens"] = request.OutputTokens,
    ["cacheReadTokens"] = request.CacheReadTokens,
    ["cacheWriteTokens"] = request.CacheWriteTokens,
    ["durationMs"] = request.DurationMs,
    ["totalNanoAiu"] = request.TotalNanoAiu,
    ["kind"] = request.Kind
};
