#!/usr/bin/env dotnet-script
#nullable enable
// events-core.csx — Shared parsing infrastructure for Copilot CLI session telemetry
//
// LOADED BY:
//   scripts/analyze-events.csx   (#load "./lib/events-core.csx")
//   scripts/export-events.csx    (#load "./lib/events-core.csx")
//
// PROVIDES:
//   - All index variable declarations (filled by RunPass1)
//   - RunPass1(path)     — streaming forward scan; populates all indexes
//   - OpenEventFile(path) — opens pass-2 FileStream (closed-over by SeekLine)
//   - SortTimeline()     — sorts sortedByTime; builds hookEndIds; computes total
//   - ResetIndexes()     — clears all indexes
//   - SeekLine(offset)   — seek + parse one JSONL line via pass-2 FileStream
//   - SeekMany(offsets)  — convenience wrapper around SeekLine
//   - SafeStr / ParseTimestampStr / Truncate  — pure helpers
//
// ARCHITECTURE: Two-pass streaming design
//   Pass 1 — raw byte scan; stores only byte offsets + lightweight metadata per line.
//             JsonNode is parsed then released immediately. RAM = O(index), not O(file).
//   Pass 2 — SeekLine seeks to stored byte offsets and parses only needed lines.
//             Supports files >1 GB without buffering the whole file.
//
// SCHEMA NOTES (reverse-engineered — no official documentation exists)
//   • Every event: type, id (UUID), timestamp (ISO-8601 UTC), parentId (UUID|null), data{}
//   • parentId=null only on session.start
//   • tool.execution_complete has no toolName — resolve via toolCallId cross-reference
//   • hook.start/end match via hookInvocationId, NOT parentId
//   • tool.execution_complete events form a serial chain even for parallel dispatches
//   • subagent.started.data.toolCallId == the subagent's identity callId
//   • Subagents can be nested: a subagent.started whose parentId resolves to another
//     subagent.started was spawned by that parent subagent, not the orchestrator
//   • session.shutdown.data.modelMetrics has dynamic model-name keys

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

// ═════════════════════════════════════════════════════════════════════════════
// PASS-1 COUNTERS
// ═════════════════════════════════════════════════════════════════════════════

int totalLines    = 0;
int parseErrors   = 0;
int skippedBlanks = 0;
bool isJsonArray  = false;

// ═════════════════════════════════════════════════════════════════════════════
// SCHEMA INDEXES  (populated by RunPass1)
// ═════════════════════════════════════════════════════════════════════════════

// event type → count
var typeCounts       = new Dictionary<string, int>(StringComparer.Ordinal);
// top-level JSON field name → count across all events
var topLevelFields   = new Dictionary<string, int>(StringComparer.Ordinal);
// event type → (data field name → count)
var dataFieldsByType = new Dictionary<string, Dictionary<string, int>>();

// ═════════════════════════════════════════════════════════════════════════════
// OFFSET INDEXES  (all keyed by event id or call id; values are byte offsets)
// ═════════════════════════════════════════════════════════════════════════════

// id → byte offset of the line in the file (primary seek index)
var offsetById = new Dictionary<string, long>(StringComparer.Ordinal);

// type → list of byte offsets for all events of that type (batch seek)
var offsetsByType = new Dictionary<string, List<long>>(StringComparer.Ordinal);

// id → type string (allows graph traversal without seeking)
var typeById = new Dictionary<string, string>(StringComparer.Ordinal);

// id → parsed timestamp (allows duration math without re-seeking)
var timestampById = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);

// chronological list of (timestamp, fileOffset) — sorted by SortTimeline()
var sortedByTime = new List<(DateTimeOffset ts, long offset)>();

// parent-child graph (built from parentId fields)
var childIndex  = new Dictionary<string, List<string>>(StringComparer.Ordinal);
var parentIndex = new Dictionary<string, string>(StringComparer.Ordinal);
var roots       = new List<string>();    // events with parentId == null
var orphans     = new List<string>();    // events whose parentId was not seen

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-REFERENCE INDEXES  (type-specific; avoid double-seeking in output sections)
// ═════════════════════════════════════════════════════════════════════════════

// toolCallId → tool name (from tool.execution_start; used to label tool.execution_complete)
var toolNameByCallId            = new Dictionary<string, string>(StringComparer.Ordinal);
// toolCallId → event id of tool.execution_start
var toolStartIdByCallId         = new Dictionary<string, string>(StringComparer.Ordinal);
// toolCallId → byte offset of tool.execution_start
var toolStartOffsetByCallId     = new Dictionary<string, long>(StringComparer.Ordinal);
// toolCallId → byte offset of tool.execution_complete
var toolCompleteOffsetByCallId  = new Dictionary<string, long>(StringComparer.Ordinal);
// toolCallId → event id of tool.execution_complete
var toolCompleteIdByCallId      = new Dictionary<string, string>(StringComparer.Ordinal);
// hookInvocationId → byte offset of hook.start
var hookStartOffsetByInvId      = new Dictionary<string, long>(StringComparer.Ordinal);
// hookInvocationId → byte offset of hook.end
var hookEndOffsetByInvId        = new Dictionary<string, long>(StringComparer.Ordinal);
// hookInvocationId → event id of hook.end (used to build hookEndIds set)
var hookEndIdByInvId            = new Dictionary<string, string>(StringComparer.Ordinal);
// subagent toolCallId → byte offset of subagent.started
var subagentStartOffsetByCallId = new Dictionary<string, long>(StringComparer.Ordinal);
// subagent toolCallId → list of child tool callIds dispatched inside that subagent
var childToolCallIdsByParentCallId = new Dictionary<string, List<string>>(StringComparer.Ordinal);
// child toolCallId → its parent subagent toolCallId (empty string = orchestrator)
var toolParentCallId = new Dictionary<string, string>(StringComparer.Ordinal);
// subagent toolCallId → list of byte offsets of assistant.message events inside that subagent
var assistantMessageOffsetsByParentCallId = new Dictionary<string, List<long>>(StringComparer.Ordinal);
// any toolCallId (subagent or tool) → byte offset of the assistant.message that dispatched it
var dispatchingMessageOffsetByCallId = new Dictionary<string, long>(StringComparer.Ordinal);

// ═════════════════════════════════════════════════════════════════════════════
// POST-SORT DERIVED VALUES  (set by SortTimeline())
// ═════════════════════════════════════════════════════════════════════════════

// IDs of all hook.end events — used to skip them during tree DFS (rendered collapsed)
var hookEndIds = new HashSet<string>(StringComparer.Ordinal);
// total event count across all types
int total = 0;

// ═════════════════════════════════════════════════════════════════════════════
// PASS-2 FILE STREAM  (opened by OpenEventFile; closed-over by SeekLine)
// ═════════════════════════════════════════════════════════════════════════════

FileStream? fs = null;

// Open (or reopen) the pass-2 FileStream for random-access seeking.
// Call after RunPass1.
void OpenEventFile(string path)
{
    fs?.Dispose();
    fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 18);
}

// ═════════════════════════════════════════════════════════════════════════════
// ResetIndexes — clear all state so RunPass1 can be called again cleanly
// ═════════════════════════════════════════════════════════════════════════════

void ResetIndexes()
{
    totalLines    = 0;
    parseErrors   = 0;
    skippedBlanks = 0;
    isJsonArray   = false;
    total         = 0;

    typeCounts.Clear();
    topLevelFields.Clear();
    dataFieldsByType.Clear();
    offsetById.Clear();
    offsetsByType.Clear();
    typeById.Clear();
    timestampById.Clear();
    sortedByTime.Clear();
    childIndex.Clear();
    parentIndex.Clear();
    roots.Clear();
    orphans.Clear();
    toolNameByCallId.Clear();
    toolStartIdByCallId.Clear();
    toolStartOffsetByCallId.Clear();
    toolCompleteOffsetByCallId.Clear();
    toolCompleteIdByCallId.Clear();
    hookStartOffsetByInvId.Clear();
    hookEndOffsetByInvId.Clear();
    hookEndIdByInvId.Clear();
    subagentStartOffsetByCallId.Clear();
    childToolCallIdsByParentCallId.Clear();
    toolParentCallId.Clear();
    assistantMessageOffsetsByParentCallId.Clear();
    dispatchingMessageOffsetByCallId.Clear();
    hookEndIds.Clear();
}

// ═════════════════════════════════════════════════════════════════════════════
// RunPass1 — streaming forward scan
//
// Reads the file as raw bytes to track exact byte offsets per line (a StreamReader's
// read-ahead buffer makes BaseStream.Position unreliable for offset tracking).
// Processes 256 KB at a time; lineBuf accumulates bytes until a \n is found.
// Each JsonNode is parsed, mined for lightweight metadata, then set to null for GC.
// No JsonNode survives after this function returns.
// ═════════════════════════════════════════════════════════════════════════════

void RunPass1(string inputPath)
{
    ResetIndexes();

    var passStream = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 18);
    var readBuf    = new byte[1 << 18];   // 256 KB read buffer
    var lineBuf    = new System.Collections.Generic.List<byte>(4096);
    long fileOffset = 0;      // byte position of the current read-buffer's first byte in the file
    long lineStart  = 0;      // byte position of the current line's first byte
    int  bufStart   = 0;      // index into readBuf where unprocessed data starts
    int  bufEnd     = 0;      // index into readBuf where valid data ends (exclusive)

    bool isFirstContentLine = true;

    while (true)
    {
        // Refill buffer when all bytes have been consumed
        if (bufStart >= bufEnd)
        {
            fileOffset += bufEnd;   // fileOffset now points to where the new read starts
            bufEnd   = passStream.Read(readBuf, 0, readBuf.Length);
            bufStart = 0;
            if (bufEnd == 0) break; // EOF
        }

        // Scan forward for a newline character in the current buffer window
        int nl = Array.IndexOf(readBuf, (byte)'\n', bufStart, bufEnd - bufStart);

        if (nl >= 0)
        {
            // Accumulate bytes from bufStart up to (not including) the newline
            for (int i = bufStart; i < nl; i++) lineBuf.Add(readBuf[i]);

            // Strip trailing \r for Windows CRLF files
            if (lineBuf.Count > 0 && lineBuf[lineBuf.Count - 1] == (byte)'\r')
                lineBuf.RemoveAt(lineBuf.Count - 1);

            long thisLineStart = lineStart;
            lineStart = fileOffset + nl + 1;  // next line starts immediately after this \n
            bufStart  = nl + 1;

            totalLines++;
            if (lineBuf.Count == 0) { skippedBlanks++; lineBuf.Clear(); continue; }

            // First non-blank byte '[' means the file is a JSON array, not JSONL
            if (isFirstContentLine)
            {
                isFirstContentLine = false;
                if (lineBuf[0] == (byte)'[') { isJsonArray = true; break; }
            }

            // Parse JSON; emit a parse error and skip on failure
            JsonNode? node;
            try
            {
                node = JsonNode.Parse(Encoding.UTF8.GetString(lineBuf.ToArray()));
            }
            catch (JsonException ex)
            {
                parseErrors++;
                var preview = lineBuf.Count > 80
                    ? Encoding.UTF8.GetString(lineBuf.ToArray(), 0, 80) + "…"
                    : Encoding.UTF8.GetString(lineBuf.ToArray());
                Console.Error.WriteLine($"  [PARSE ERROR line {totalLines}] {ex.Message} | {preview}");
                lineBuf.Clear();
                continue;
            }

            lineBuf.Clear();
            if (node == null) continue;

            // Extract the four universal fields present on every event
            var id       = SafeStr(node, "id");
            var parentId = SafeStr(node, "parentId");
            var type     = SafeStr(node, "type") ?? "<unknown>";
            var data     = node["data"];

            if (id == null) { node = null; continue; }

            // Populate primary offset indexes
            offsetById[id] = thisLineStart;
            typeById[id]   = type;
            if (!offsetsByType.TryGetValue(type, out var tList))
                offsetsByType[type] = tList = new List<long>();
            tList.Add(thisLineStart);

            // Timestamp — stored for duration math; also added to sortedByTime
            var ts = ParseTimestampStr(SafeStr(node, "timestamp"));
            timestampById[id] = ts;
            if (ts != DateTimeOffset.MinValue)
                sortedByTime.Add((ts, thisLineStart));

            // Schema frequency counts
            typeCounts[type] = typeCounts.GetValueOrDefault(type) + 1;
            if (node is JsonObject nodeObj)
                foreach (var kv in nodeObj)
                    topLevelFields[kv.Key] = topLevelFields.GetValueOrDefault(kv.Key) + 1;
            if (data is JsonObject dataObj)
            {
                if (!dataFieldsByType.TryGetValue(type, out var tf))
                    dataFieldsByType[type] = tf = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var kv in dataObj)
                    tf[kv.Key] = tf.GetValueOrDefault(kv.Key) + 1;
            }

            // Parent-child graph
            if (parentId == null)
            {
                roots.Add(id);
            }
            else
            {
                if (!offsetById.ContainsKey(parentId)) orphans.Add(id);
                if (!childIndex.TryGetValue(parentId, out var ch))
                    childIndex[parentId] = ch = new List<string>();
                ch.Add(id);
                parentIndex[id] = parentId;
            }

            // Type-specific cross-reference indexes
            IndexEventByType(id, type, data, thisLineStart);

            node = null;  // release to GC; no JsonNode survives past this point
        }
        else
        {
            // No newline found in remaining buffer — accumulate and refill
            for (int i = bufStart; i < bufEnd; i++) lineBuf.Add(readBuf[i]);
            bufStart = bufEnd;  // mark entire buffer as consumed
        }
    }

    // Handle last line when the file has no trailing newline
    if (lineBuf.Count > 0 && !isJsonArray)
    {
        if (lineBuf[lineBuf.Count - 1] == (byte)'\r') lineBuf.RemoveAt(lineBuf.Count - 1);
        totalLines++;
        JsonNode? node;
        try   { node = JsonNode.Parse(Encoding.UTF8.GetString(lineBuf.ToArray())); }
        catch { node = null; parseErrors++; }

        if (node != null)
        {
            var id   = SafeStr(node, "id");
            var type = SafeStr(node, "type") ?? "<unknown>";
            var data = node["data"];
            if (id != null)
            {
                offsetById[id] = lineStart;
                typeById[id]   = type;
                if (!offsetsByType.TryGetValue(type, out var tList))
                    offsetsByType[type] = tList = new List<long>();
                tList.Add(lineStart);
                var ts = ParseTimestampStr(SafeStr(node, "timestamp"));
                timestampById[id] = ts;
                if (ts != DateTimeOffset.MinValue) sortedByTime.Add((ts, lineStart));
                typeCounts[type] = typeCounts.GetValueOrDefault(type) + 1;
                var parentId = SafeStr(node, "parentId");
                if (parentId == null) roots.Add(id);
                else
                {
                    if (!offsetById.ContainsKey(parentId)) orphans.Add(id);
                    if (!childIndex.TryGetValue(parentId, out var ch))
                        childIndex[parentId] = ch = new List<string>();
                    ch.Add(id);
                    parentIndex[id] = parentId;
                }
                IndexEventByType(id, type, data, lineStart);
            }
        }
        lineBuf.Clear();
    }

    passStream.Dispose();
}

// Extracted cross-reference indexing — called for every successfully parsed event.
void IndexEventByType(string id, string type, JsonNode? data, long offset)
{
    switch (type)
    {
        case "tool.execution_start":
        {
            var callId = SafeStr(data, "toolCallId");
            if (callId != null)
            {
                toolNameByCallId[callId]        = SafeStr(data, "toolName") ?? "<unknown>";
                toolStartOffsetByCallId[callId] = offset;
                toolStartIdByCallId[callId]     = id;

                var parentCallId = SafeStr(data, "parentToolCallId");
                toolParentCallId[callId] = parentCallId ?? "";
                if (parentCallId != null)
                {
                    if (!childToolCallIdsByParentCallId.TryGetValue(parentCallId, out var childList))
                        childToolCallIdsByParentCallId[parentCallId] = childList = new List<string>();
                    childList.Add(callId);
                }
            }
            break;
        }
        case "tool.execution_complete":
        {
            var callId = SafeStr(data, "toolCallId");
            if (callId != null)
            {
                toolCompleteOffsetByCallId[callId] = offset;
                toolCompleteIdByCallId[callId]     = id;
            }
            break;
        }
        case "hook.start":
        {
            var invId = SafeStr(data, "hookInvocationId");
            if (invId != null)
                hookStartOffsetByInvId[invId] = offset;
            break;
        }
        case "hook.end":
        {
            var invId = SafeStr(data, "hookInvocationId");
            if (invId != null)
            {
                hookEndOffsetByInvId[invId] = offset;
                hookEndIdByInvId[invId]     = id;
            }
            break;
        }
        case "subagent.started":
        {
            var callId = SafeStr(data, "toolCallId");
            if (callId != null)
                subagentStartOffsetByCallId[callId] = offset;
            break;
        }
        case "assistant.message":
        {
            var parentCallId = SafeStr(data, "parentToolCallId");
            if (parentCallId != null)
            {
                if (!assistantMessageOffsetsByParentCallId.TryGetValue(parentCallId, out var msgList))
                    assistantMessageOffsetsByParentCallId[parentCallId] = msgList = new List<long>();
                msgList.Add(offset);
            }
            var toolReqs = data?["toolRequests"]?.AsArray();
            if (toolReqs != null)
            {
                foreach (var req in toolReqs)
                {
                    var reqCallId = SafeStr(req, "toolCallId");
                    if (reqCallId != null)
                        dispatchingMessageOffsetByCallId[reqCallId] = offset;
                }
            }
            break;
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SortTimeline — call once after RunPass1
// Sorts sortedByTime by (timestamp, file-offset) for stable tie-breaking.
// Builds hookEndIds and computes total.
// ═════════════════════════════════════════════════════════════════════════════

void SortTimeline()
{
    // Tie-break by file offset so same-millisecond events appear in file order
    sortedByTime.Sort((a, b) =>
    {
        int c = a.ts.CompareTo(b.ts);
        return c != 0 ? c : a.offset.CompareTo(b.offset);
    });

    // Collect all hook.end event IDs — used to skip them in tree DFS
    hookEndIds.Clear();
    foreach (var id in hookEndIdByInvId.Values) hookEndIds.Add(id);

    total = typeCounts.Values.Sum();
}

// ═════════════════════════════════════════════════════════════════════════════
// SeekLine — seek to a byte offset in the pass-2 FileStream and parse the line
//
// Uses raw bytes (no StreamReader) to avoid read-ahead buffer corruption.
// Buffer starts at 256 KB and doubles if the line is longer (handles the
// 07061697 session which has lines >256 KB due to large tool result payloads).
// ═════════════════════════════════════════════════════════════════════════════

JsonNode SeekLine(long offset)
{
    fs!.Seek(offset, SeekOrigin.Begin);
    int bufSize   = 1 << 18;   // start at 256 KB
    byte[] buf    = new byte[bufSize];
    int totalRead = 0;

    while (true)
    {
        // Fill buffer from current position
        while (totalRead < buf.Length)
        {
            int read = fs.Read(buf, totalRead, buf.Length - totalRead);
            if (read == 0) break;
            totalRead += read;
        }

        // Locate the newline that terminates this line
        int nl = Array.IndexOf(buf, (byte)'\n', 0, totalRead);
        if (nl >= 0)
        {
            int end = (nl > 0 && buf[nl - 1] == (byte)'\r') ? nl - 1 : nl;
            return JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, end))!;
        }

        // No newline yet and buffer is full — this is a very long line; double the buffer
        if (totalRead == buf.Length)
        {
            bufSize *= 2;
            var newBuf = new byte[bufSize];
            Array.Copy(buf, newBuf, totalRead);
            buf = newBuf;
            continue;
        }

        // EOF reached without a newline — the entire buffer is the last line
        int trimEnd = totalRead;
        while (trimEnd > 0 && (buf[trimEnd - 1] == (byte)'\r' || buf[trimEnd - 1] == (byte)'\n')) trimEnd--;
        return JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, trimEnd))!;
    }
}

// Convenience: seek and parse multiple offsets in sequence
IEnumerable<JsonNode> SeekMany(IEnumerable<long> offsets)
{
    foreach (var off in offsets)
        yield return SeekLine(off);
}

// ═════════════════════════════════════════════════════════════════════════════
// PURE HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

// Safe string extraction from a JsonNode by key; returns null on any failure
static string? SafeStr(JsonNode? node, string key)
{
    if (node == null) return null;
    try
    {
        var v = node[key];
        if (v == null) return null;
        if (v is JsonValue jv && jv.TryGetValue<string>(out var s)) return s;
        return v.ToString();
    }
    catch { return null; }
}

// Parse ISO-8601 timestamp string; returns DateTimeOffset.MinValue on failure
static DateTimeOffset ParseTimestampStr(string? ts)
{
    if (ts == null) return DateTimeOffset.MinValue;
    if (DateTimeOffset.TryParse(ts, out var dto)) return dto;
    return DateTimeOffset.MinValue;
}

// Truncate a string to maxLen characters, appending ellipsis if truncated
static string Truncate(string s, int maxLen)
    => s.Length <= maxLen ? s : s[..maxLen] + "…";
