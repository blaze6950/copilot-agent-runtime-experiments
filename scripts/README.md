# Session Telemetry Scripts

Tools for analyzing Copilot CLI session telemetry (`events.jsonl`).

## File Layout

```
scripts/
  analyze-events.csx        Human-readable Spectre Console output
  export-events.csx         Structured JSON export (no Spectre dependency)
  lib/
    events-core.csx         Shared parsing infrastructure (two-pass streaming)
    events-annotations.csx  EventAnnotation record + annotation builders
```

## Quick Start

```powershell
# Human-readable analysis
dotnet script scripts\analyze-events.csx C:\Users\USER\.copilot\session-state\<id>\events.jsonl

# With full subagent dispatch detail
dotnet script scripts\analyze-events.csx <path> --dispatches

# With timeline (per-lane event list)
dotnet script scripts\analyze-events.csx <path> --timeline

# Both flags together
dotnet script scripts\analyze-events.csx <path> --dispatches --timeline

# JSON export (writes export.json beside input; also prints to stdout)
dotnet script scripts\export-events.csx <path>

# JSON export to explicit output file
dotnet script scripts\export-events.csx <path> --out C:\tmp\my-export.json
```

You can pass either a path to `events.jsonl` directly, or the session directory
(the script will find `events.jsonl` inside it).

## Requirements

- .NET 9 SDK
- `dotnet-script` 2.x: `dotnet tool install -g dotnet-script`
- `Spectre.Console` 0.49.1 (NuGet; auto-restored by dotnet-script)

## Architecture

### Two-pass streaming design

Both consumer scripts use a two-pass approach implemented in `lib/events-core.csx`:

**Pass 1** — forward byte-level scan of the entire file. For each line:
- Parses the JSON, extracts lightweight metadata (id, type, timestamp, parentId)
- Stores only the byte offset of that line in the file
- Builds cross-reference indexes (toolCallId → name, hookInvocationId → offsets, etc.)
- Releases the JsonNode immediately — no JsonNode survives after Pass 1
- RAM usage: O(number of events), not O(file size)

**Pass 2** — random-access seeking. Output sections call `SeekLine(offset)` to parse
exactly the lines they need. The FileStream is kept open between seeks.

This design supports files > 1 GB (the `5201768c` session is 108 MB). The `SeekLine`
buffer starts at 256 KB and doubles if a line is longer (handles `07061697` which has
lines > 256 KB due to large tool result payloads).

### EventAnnotation record

`lib/events-annotations.csx` defines a `record EventAnnotation(...)` with nullable
structured fields for every known event type. All annotation builders return this record.

- `analyze-events.csx` calls `ToDisplayString(annotation)` to render it for Spectre
- `export-events.csx` serializes the fields directly into the timeline JSON
- `[JsonIgnore(WhenWritingNull)]` keeps sparse events compact in the JSON output

## Output Sections (analyze-events.csx)

| Section | Flag | Description |
|---------|------|-------------|
| C | always | Event type summary — counts and percentages |
| E | always | Graph statistics — depth, orphans, tool chain length |
| H | always | Tool usage — calls, success rate, avg/min/max duration |
| J | always | Error / warning report with scope labels |
| K | always | Token / cost table from session.shutdown modelMetrics |
| I | `--dispatches` | Full subagent dispatch detail (prompt + answer + tools) |
| F | `--timeline` | Per-lane chronological event list |

## export.json Schema

```jsonc
{
  "sessionId": "...",
  "sessionStart": "2026-05-17T10:00:00Z",
  "sessionEnd":   "2026-05-17T12:00:00Z",
  "durationMs":   7200000,
  "shutdownType": "normal",
  "cwd":          "C:\\project",
  "copilotVersion": "1.2.3",

  "eventTypeCounts": { "tool.execution_complete": 120, ... },

  "graphStats": {
    "total": 808, "totalEdges": 807, "roots": 1, "orphans": 0,
    "maxDepth": 45, "avgBranching": 1.23, "internalNodes": 300,
    "leafNodes": 508, "maxToolChainLen": 12,
    "hookPairs": 24, "unmatchedHookEnds": 0
  },

  "hookPairs": [ { "hookType": "PreToolExecution", "durationMs": 42.0, "success": true } ],

  "modelChanges": [ { "ts": "...", "previousModel": "claude-haiku-4.5", "newModel": "claude-sonnet-4.6" } ],

  "compactionEvents": [ { "ts": "...", "tokensBefore": 148000, "tokensAfter": null } ],

  "modelMetrics": {
    "claude-sonnet-4.6": {
      "requests": 12, "cost": 0.42,
      "inputTokens": 50000, "outputTokens": 8000,
      "cacheReadTokens": 120000, "cacheWriteTokens": 5000,
      "reasoningTokens": null
    }
  },

  "toolStats": [
    { "name": "read", "calls": 40, "successes": 38, "avgDurationMs": 120.5, "minDurationMs": 10.0, "maxDurationMs": 800.0 }
  ],

  "errorCount": 2,
  "errors": [ { "ts": "...", "type": "tool.execution_complete", "scope": "orchestrator", "detail": "File not found" } ],

  "subagentDispatches": [
    {
      "label": "sub-explorer #1",
      "agentName": "sub-explorer",
      "callId": "abc-123",
      "status": "completed",          // "completed" | "failed" | "in-progress"
      "model": "claude-haiku-4.5",
      "startTs": "...", "endTs": "...", "durationMs": 12000.0,
      "inputTokens": 3000, "outputTokens": 800, "totalTokens": 3800,
      "toolCallCount": 5,
      "tools": [ { "name": "read", "count": 3 }, { "name": "glob", "count": 2 } ],
      "prompt": "Full prompt text...",
      "answer": "Full final answer text..."
    }
  ],

  "timeline": {
    "lanes": [
      {
        "laneId": "orchestrator",
        "label":  "ORCHESTRATOR",
        "events": [
          {
            "ts": "2026-05-17T10:00:01.234Z",
            "deltaMs": 1234.0,
            "merged": true,            // only present when true (start+end pair merged)
            "displayType": "tool",     // simplified type label
            "isFail": true,            // only present when true
            "isFinalAnswer": true,     // only present when true
            "toolName": "read",
            "toolArgs": "\"src/foo.cs\"",
            "toolSuccess": false,
            "durationMs": 42.0,
            "hookType": null,          // null fields are omitted in output
            "toolRequestCount": null,
            "toolRequestNames": null,
            "outputTokens": null,
            "contentSnippet": "First 120 chars...",  // TRUNCATED — full text in subagentDispatches[].answer
            "agentName": null,
            "turnId": null,
            "tokensBefore": null,
            "tokensAfter": null,
            "annotation": "File not found"   // catch-all for unknown types or error detail
          }
        ]
      }
    ]
  }
}
```

### contentSnippet truncation note

`contentSnippet` in timeline events is truncated to **120 characters**. Full content
for subagent final answers is available in `subagentDispatches[].answer`. To find
the full text corresponding to a snippet, search `answer` fields by substring.

## Known Constraints

| Constraint | Reason |
|---|---|
| No `using` for resource disposal — explicit `.Dispose()` | dotnet-script lifetime model |
| `#load` directives before all code tokens | dotnet-script 2.0 parser requirement |
| `SeekLine` buffer doubles dynamically | `07061697` has lines > 256 KB |
| `StreamReader.BaseStream.Position` not used | Read-ahead makes it unreliable for offset tracking |
| `dotnet-script 2.0` switch expression: no multi-statement arms | Use helper methods instead |
| `tool.execution_complete` has no `toolName` | Resolve via `toolCallId` cross-reference |
| `hook.start`/`hook.end` match via `hookInvocationId` | Not via `parentId` |
| Subagent `assistant.message` scoped via `parentToolCallId` | Not in the orchestrator lane |
