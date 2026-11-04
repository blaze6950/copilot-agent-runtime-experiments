#!/usr/bin/env dotnet-script
#nullable enable
// events-annotations.csx — Structured annotation logic for Copilot CLI session events
//
// LOADED BY:
//   scripts/analyze-events.csx   (#load "./lib/events-annotations.csx")
//   scripts/export-events.csx    (#load "./lib/events-annotations.csx")
//
// REQUIRES: events-core.csx already loaded (uses SafeStr, Truncate, toolNameByCallId, etc.)
//
// PROVIDES:
//   EventAnnotation record  — structured per-event annotation for both display and JSON export
//   BuildAnnotation(...)    — top-level dispatcher; returns EventAnnotation for any event
//   BuildMergedAnnotation(...)  — for start+end pairs (tool, hook, turn, compaction)
//   ToDisplayString(...)    — renders EventAnnotation back to a concise string for Spectre output
//
// DESIGN:
//   All annotation builders return EventAnnotation (a record with nullable fields).
//   JSON serialization uses [JsonIgnore(WhenWritingNull)] so sparse events stay compact.
//   Spectre rendering calls ToDisplayString() which formats the record into a human string.
//   contentSnippet is truncated to 120 chars; full content lives in subagentDispatches[].answer.

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

// ═════════════════════════════════════════════════════════════════════════════
// EventAnnotation record — one per timeline event
// ═════════════════════════════════════════════════════════════════════════════

record EventAnnotation(
    // Display label for the event type (may be simplified, e.g. "tool" instead of "tool.execution_complete")
    string DisplayType,

    // Whether this event represents a failure
    bool IsFail = false,

    // Whether this assistant.message is the final answer in a subagent lane
    bool IsFinalAnswer = false,

    // tool.execution_* fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? ToolName = null,

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? ToolArgs = null,        // compact JSON or prompt snippet

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    bool? ToolSuccess = null,

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    double? DurationMs = null,

    // tool result size in bytes (chars); always set when result.content is present
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    long? ResultBytes = null,

    // hook.* fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? HookType = null,

    // assistant.message fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    int? ToolRequestCount = null,

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string[]? ToolRequestNames = null,

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    long? OutputTokens = null,

    // Content snippet — first 120 chars; full content available in subagentDispatches[].answer
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? ContentSnippet = null,

    // subagent.* fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? AgentName = null,

    // assistant.turn fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? TurnId = null,

    // session.compaction fields
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    long? TokensBefore = null,

    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    long? TokensAfter = null,

    // Catch-all string for rare/unknown types where structured fields aren't available
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? Annotation = null
);

// ═════════════════════════════════════════════════════════════════════════════
// BuildAnnotation — dispatcher for single (unmerged) events
// ═════════════════════════════════════════════════════════════════════════════

EventAnnotation BuildAnnotation(JsonNode ev, string type, JsonNode? data, long offset, string finalAnswerOffset)
{
    return type switch
    {
        "assistant.message"         => BuildAssistantMessageAnnotation(data, offset, finalAnswerOffset),
        "tool.execution_start"      => BuildToolStartAnnotation(data),
        "tool.execution_complete"   => BuildToolCompleteAnnotation(data),
        "subagent.started"          => new EventAnnotation("subagent.started",   AgentName: SafeStr(data, "agentName")),
        "subagent.completed"        => BuildSubagentCompletedAnnotation(data),
        "subagent.failed"           => new EventAnnotation("subagent.failed",    IsFail: true, AgentName: SafeStr(data, "agentName"), Annotation: SafeStr(data, "error")),
        "subagent.selected"         => new EventAnnotation("subagent.selected",  AgentName: SafeStr(data, "agentName")),
        "user.message"              => new EventAnnotation("user.message",        ContentSnippet: Truncate(SafeStr(data, "content") ?? "", 120)),
        "system.message"            => new EventAnnotation("system.message",      Annotation: $"role={SafeStr(data,"role")}  len={SafeStr(data,"content")?.Length ?? 0}"),
        "hook.start"                => new EventAnnotation("hook.start",          HookType: SafeStr(data, "hookType")),
        "hook.end"                  => new EventAnnotation("hook.end",            HookType: SafeStr(data, "hookType"), ToolSuccess: TryGetBool(data, "success")),
        "permission.requested"      => new EventAnnotation("permission.requested", Annotation: SafeStr(data, "description")),
        "permission.completed"      => BuildPermissionCompletedAnnotation(data),
        "session.start"             => new EventAnnotation("session.start",       Annotation: $"v={SafeStr(data,"copilotVersion")}  cwd={SafeStr(data?["context"],"cwd")}"),
        "session.shutdown"          => new EventAnnotation("session.shutdown",    Annotation: $"type={SafeStr(data,"shutdownType")}"),
        "session.model_change"      => new EventAnnotation("session.model_change", Annotation: $"{SafeStr(data,"previousModel")} → {SafeStr(data,"newModel")}"),
        "session.compaction_start"  => BuildCompactionStartAnnotation(data),
        "session.compaction_complete" => BuildCompactionCompleteAnnotation(data),
        "session.info"              => new EventAnnotation("session.info",         Annotation: $"[{SafeStr(data,"infoType")}] {SafeStr(data,"message")??""}"),
        "session.warning"           => new EventAnnotation("session.warning",      Annotation: $"[{SafeStr(data,"warningType")}] {SafeStr(data,"message")??""}"),
        "session.error"             => new EventAnnotation("session.error",        IsFail: true, Annotation: SafeStr(data, "message")),
        "abort"                     => new EventAnnotation("abort",                IsFail: true, Annotation: $"reason={SafeStr(data,"reason")}"),
        "skill.invoked"             => new EventAnnotation("skill.invoked",        Annotation: $"skill={SafeStr(data,"skillName") ?? SafeStr(data,"name")}"),
        "assistant.turn_start"      => new EventAnnotation("assistant.turn_start", TurnId: SafeStr(data, "turnId")),
        "assistant.turn_end"        => new EventAnnotation("assistant.turn_end",   TurnId: SafeStr(data, "turnId")),
        "system.notification"       => new EventAnnotation("system.notification",  Annotation: SafeStr(data, "content") ?? data?["kind"]?["type"]?.ToString()),
        _                           => new EventAnnotation(type,                   Annotation: data?.ToJsonString())
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// BuildMergedAnnotation — for start+end pairs rendered as one timeline row
// Returns EventAnnotation with DisplayType simplified (e.g. "tool", "hook")
// ═════════════════════════════════════════════════════════════════════════════

EventAnnotation BuildMergedAnnotation(
    string endType, JsonNode? startData, JsonNode? endData, long endOffset, string finalAnswerOffset)
{
    bool isFail = false;
    try { isFail = !(endData?["success"]?.GetValue<bool>() ?? true); } catch { }

    if (endType == "tool.execution_complete")
    {
        var callId   = SafeStr(endData, "toolCallId") ?? "";
        var name     = toolNameByCallId.GetValueOrDefault(callId, "?");
        var startId  = toolStartIdByCallId.GetValueOrDefault(callId, "");
        var complId  = toolCompleteIdByCallId.GetValueOrDefault(callId, "");
        var durMs    = ComputeDurationMs(startId, complId);
        var prompt   = SafeStr(startData?["arguments"], "prompt") ?? SafeStr(startData?["arguments"], "description");
        var toolArgs = prompt != null
            ? $"\"{Truncate(prompt, 120)}\""
            : (startData?["arguments"] is JsonNode args ? Truncate(args.ToJsonString(), 120) : null);
        var errAnnotation = isFail
            ? Truncate(SafeStr(endData, "error") ?? SafeStr(endData, "message") ?? "", 120)
            : null;
        var resultStr2    = SafeStr(endData?["result"], "content");
        long? resultBytes2 = resultStr2 != null ? (long)resultStr2.Length : null;
        return new EventAnnotation("tool",
            IsFail:      isFail,
            ToolName:    name,
            ToolArgs:    toolArgs,
            ToolSuccess: !isFail,
            DurationMs:  durMs,
            ResultBytes: resultBytes2,
            Annotation:  errAnnotation);
    }

    if (endType == "hook.end")
    {
        var invId    = SafeStr(endData, "hookInvocationId") ?? SafeStr(startData, "hookInvocationId") ?? "";
        var hookType = SafeStr(endData, "hookType") ?? SafeStr(startData, "hookType") ?? "?";
        var startId  = invId != "" && hookStartOffsetByInvId.TryGetValue(invId, out var sOff)
            ? (SafeStr(SeekLine(sOff), "id") ?? "") : "";
        var endId    = invId != "" && hookEndOffsetByInvId.TryGetValue(invId, out var eOff)
            ? (SafeStr(SeekLine(eOff), "id") ?? "") : "";
        var durMs    = ComputeDurationMs(startId, endId);
        var errAnnotation = isFail ? SafeStr(endData, "message") : null;
        return new EventAnnotation("hook",
            IsFail:      isFail,
            HookType:    hookType,
            ToolSuccess: !isFail,
            DurationMs:  durMs,
            Annotation:  errAnnotation);
    }

    if (endType == "assistant.turn_end")
    {
        var turnId = SafeStr(endData, "turnId") ?? SafeStr(startData, "turnId") ?? "?";
        return new EventAnnotation("assistant.turn", TurnId: turnId);
    }

    if (endType == "session.compaction_complete")
    {
        long? pre  = TryGetLong(startData, "conversationTokens");
        long? post = TryGetLong(endData,   "preCompactionTokens");
        return new EventAnnotation("session.compaction", TokensBefore: pre, TokensAfter: post);
    }

    // Fallback
    return new EventAnnotation(endType, IsFail: isFail, Annotation: endData?.ToJsonString());
}

// ═════════════════════════════════════════════════════════════════════════════
// ToDisplayString — render EventAnnotation to a concise human-readable string
// Used by analyze-events.csx for Spectre Console output
// ═════════════════════════════════════════════════════════════════════════════

string ToDisplayString(EventAnnotation a)
{
    var parts = new System.Text.StringBuilder();

    if (a.ToolName != null)
    {
        parts.Append(a.ToolName);
        if (a.ToolArgs != null) { parts.Append("  "); parts.Append(a.ToolArgs); }
        if (a.ToolSuccess.HasValue) { parts.Append("  success="); parts.Append(a.ToolSuccess.Value); }
        if (a.DurationMs.HasValue) { parts.Append("  →"); parts.Append(a.DurationMs.Value.ToString("F0")); parts.Append("ms"); }
        if (a.ResultBytes.HasValue) { parts.Append("  result="); parts.Append(FormatBytes(a.ResultBytes.Value)); }
        if (a.Annotation != null) { parts.Append("  err="); parts.Append(a.Annotation); }
        return parts.ToString();
    }

    if (a.HookType != null)
    {
        parts.Append('['); parts.Append(a.HookType); parts.Append(']');
        if (a.ToolSuccess.HasValue) { parts.Append("  success="); parts.Append(a.ToolSuccess.Value); }
        if (a.DurationMs.HasValue) { parts.Append("  →"); parts.Append(a.DurationMs.Value.ToString("F0")); parts.Append("ms"); }
        if (a.Annotation != null) { parts.Append("  err="); parts.Append(a.Annotation); }
        return parts.ToString();
    }

    if (a.TurnId != null)
        return $"turnId={a.TurnId}";

    if (a.TokensBefore.HasValue || a.TokensAfter.HasValue)
        return $"tokens: {a.TokensBefore} → {a.TokensAfter}";

    if (a.AgentName != null)
    {
        parts.Append($"agent={a.AgentName}");
        if (a.OutputTokens.HasValue) { parts.Append($"  tokens={a.OutputTokens}"); }
        if (a.DurationMs.HasValue) { parts.Append($"  dur={a.DurationMs.Value:F0}ms"); }
        if (a.Annotation != null) { parts.Append("  "); parts.Append(a.Annotation); }
        return parts.ToString();
    }

    if (a.ToolRequestCount.HasValue && a.ToolRequestCount.Value > 0)
    {
        var tc = a.ToolRequestCount.Value;
        var names = a.ToolRequestNames != null ? string.Join(", ", a.ToolRequestNames) : "";
        parts.Append($"→ {tc} tool{(tc > 1 ? "s" : "")}: {names}");
        if (a.OutputTokens.HasValue) { parts.Append($"  outTok={a.OutputTokens}"); }
        if (a.IsFinalAnswer) { parts.Append("  [FINAL ANSWER]"); }
        return parts.ToString();
    }

    if (a.ContentSnippet != null)
    {
        parts.Append($"\"{a.ContentSnippet}\"");
        if (a.OutputTokens.HasValue) { parts.Append($"  outTok={a.OutputTokens}"); }
        if (a.IsFinalAnswer) { parts.Append("  [FINAL ANSWER]"); }
        return parts.ToString();
    }

    return a.Annotation ?? "";
}

// ═════════════════════════════════════════════════════════════════════════════
// TYPE-SPECIFIC ANNOTATION BUILDERS  (private helpers)
// ═════════════════════════════════════════════════════════════════════════════

EventAnnotation BuildAssistantMessageAnnotation(JsonNode? data, long offset, string finalAnswerOffset)
{
    var tools = data?["toolRequests"]?.AsArray();
    var tc    = tools?.Count ?? 0;
    var outTok = TryGetLong(data, "outputTokens");
    bool isFinalAnswer = offset.ToString() == finalAnswerOffset;

    if (tc > 0)
    {
        var names = tools!.Take(5).Select(t =>
        {
            var tName = SafeStr(t, "name") ?? "?";
            var taskName = SafeStr(t?["arguments"], "name");
            return taskName != null ? $"{tName}({taskName})" : tName;
        }).ToArray();
        if (tc > 5)
        {
            var nameList = names.ToList();
            nameList.Add($"+{tc - 5}");
            names = nameList.ToArray();
        }
        return new EventAnnotation("assistant.message",
            IsFinalAnswer:    isFinalAnswer,
            ToolRequestCount: tc,
            ToolRequestNames: names,
            OutputTokens:     outTok);
    }

    var content = SafeStr(data, "content") ?? "";
    return new EventAnnotation("assistant.message",
        IsFinalAnswer:  isFinalAnswer,
        ContentSnippet: content.Length > 0 ? Truncate(content, 120) : null,
        OutputTokens:   outTok);
}

EventAnnotation BuildToolStartAnnotation(JsonNode? data)
{
    var name   = SafeStr(data, "toolName") ?? "?";
    var prompt = SafeStr(data?["arguments"], "prompt") ?? SafeStr(data?["arguments"], "description");
    var toolArgs = prompt != null
        ? $"\"{Truncate(prompt, 120)}\""
        : (data?["arguments"] is JsonNode args ? Truncate(args.ToJsonString(), 120) : null);
    return new EventAnnotation("tool.execution_start", ToolName: name, ToolArgs: toolArgs);
}

EventAnnotation BuildToolCompleteAnnotation(JsonNode? data)
{
    var callId      = SafeStr(data, "toolCallId") ?? "";
    var name        = toolNameByCallId.GetValueOrDefault(callId, "?");
    var success     = TryGetBool(data, "success");
    var isFail      = success == false;
    var startId     = toolStartIdByCallId.GetValueOrDefault(callId, "");
    var complId     = toolCompleteIdByCallId.GetValueOrDefault(callId, "");
    var durMs       = ComputeDurationMs(startId, complId);
    var resultStr   = SafeStr(data?["result"], "content");
    long? resultBytes = resultStr != null ? (long)resultStr.Length : null;
    var errAnnotation = isFail
        ? Truncate(SafeStr(data, "error") ?? SafeStr(data, "message") ?? "", 120)
        : null;
    return new EventAnnotation("tool.execution_complete",
        IsFail:      isFail,
        ToolName:    name,
        ToolSuccess: success,
        DurationMs:  durMs,
        ResultBytes: resultBytes,
        Annotation:  errAnnotation);
}

EventAnnotation BuildSubagentCompletedAnnotation(JsonNode? data)
{
    var name   = SafeStr(data, "agentName") ?? "<unknown>";
    var tokens = TryGetLong(data, "totalTokens");
    var durMs  = TryGetDouble(data, "durationMs");
    return new EventAnnotation("subagent.completed", AgentName: name, OutputTokens: tokens, DurationMs: durMs);
}

EventAnnotation BuildPermissionCompletedAnnotation(JsonNode? data)
{
    var success = TryGetBool(data, "success");
    var isFail  = success == false;
    var desc    = SafeStr(data, "description") ?? "";
    return new EventAnnotation("permission.completed",
        IsFail:     isFail,
        ToolSuccess: success,
        Annotation: $"result={data?["result"]}  {desc}");
}

EventAnnotation BuildCompactionStartAnnotation(JsonNode? data)
{
    var tokens = TryGetLong(data, "conversationTokens");
    return new EventAnnotation("session.compaction_start", TokensBefore: tokens);
}

EventAnnotation BuildCompactionCompleteAnnotation(JsonNode? data)
{
    var tokens = TryGetLong(data, "preCompactionTokens");
    return new EventAnnotation("session.compaction_complete", TokensAfter: tokens);
}

// ═════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Compute duration in milliseconds between two event IDs using the timestamp index
double? ComputeDurationMs(string startId, string endId)
{
    if (startId == "" || endId == "") return null;
    var sTs = timestampById.GetValueOrDefault(startId, DateTimeOffset.MinValue);
    var eTs = timestampById.GetValueOrDefault(endId,   DateTimeOffset.MinValue);
    if (sTs == DateTimeOffset.MinValue || eTs == DateTimeOffset.MinValue) return null;
    return (eTs - sTs).TotalMilliseconds;
}

// Safe bool extraction
bool? TryGetBool(JsonNode? node, string key)
{
    try
    {
        var v = node?[key];
        if (v == null) return null;
        return v.GetValue<bool>();
    }
    catch { return null; }
}

// Safe long extraction
long? TryGetLong(JsonNode? node, string key)
{
    try
    {
        var v = node?[key];
        if (v == null) return null;
        return v.GetValue<long>();
    }
    catch
    {
        try { return (long)(node?[key]?.GetValue<double>() ?? 0); }
        catch { return null; }
    }
}

// Safe double extraction
double? TryGetDouble(JsonNode? node, string key)
{
    try
    {
        var v = node?[key];
        if (v == null) return null;
        return v.GetValue<double>();
    }
    catch { return null; }
}

// Format byte count as human-readable string (B / KB / MB)
string FormatBytes(long bytes)
{
    if (bytes >= 1_048_576) return $"{bytes / 1_048_576.0:F1}MB";
    if (bytes >= 1_024)     return $"{bytes / 1_024.0:F1}KB";
    return $"{bytes}B";
}
