# Session Telemetry Scripts

Tools for analyzing Copilot CLI session telemetry (`events.jsonl`), for cross-session
metrics and dashboards, and for checking the health of the Copilot setup.

## File Layout

```
scripts/
  analyze-events.csx        Human-readable Spectre Console output
  export-events.csx         Structured JSON export (no Spectre dependency)
  session-metrics.csx       Cross-session metrics JSON (schema v2) built from each session's export.json
  render-dashboard.csx      Self-contained HTML dashboard from a metrics JSON (inline SVG, no JavaScript)
  lib/
    events-core.csx         Shared parsing infrastructure (two-pass streaming)
    events-annotations.csx  EventAnnotation record + annotation builders
    usage-records.csx       Per-request usage records (session.usage_record), compaction cost, preToolUse hook windows;
                            loaded by export-events.csx and analyze-events.csx
  tests/
    export-events.Tests.ps1      tests for export-events.csx
    session-metrics.Tests.ps1    tests for session-metrics.csx (needs PowerShell 7.5+)
    render-dashboard.Tests.ps1   tests for render-dashboard.csx
    fixtures/                    test fixtures for the tests above
  workflow/
    plan-check.ps1          plan.md validation + drift detection for the 1main agent (/make-plan, /implement)
    plan-check.Tests.ps1    dependency-free tests (pwsh -NoProfile -File plan-check.Tests.ps1)
    map-check.ps1           Mermaid map evidence check for the planner and reviewer; JSON on stdout (see "Map check")
    map-check.Tests.ps1     dependency-free tests (pwsh -NoProfile -File map-check.Tests.ps1)
    setup-check.ps1         read-only setup health check; JSON on stdout (see "Setup check")
    setup-check.Tests.ps1   tests for setup-check.ps1
    fixtures/               test fixtures (plan-check)
    fixtures/setup/         test fixtures (setup-check)
    fixtures/map/           test fixtures (map-check)
```

See `~/.copilot/docs/agent-workflow.md` for the workflow that uses `workflow/`.

## Quick Start

```powershell
# Human-readable analysis
dotnet script scripts\analyze-events.csx C:\Users\USER\.copilot\session-state\<id>\events.jsonl

# With full subagent dispatch detail
dotnet script scripts\analyze-events.csx <path> --dispatches

# With timeline (per-lane event list)
dotnet script scripts\analyze-events.csx <path> --timeline

# With per-segment token/cost breakdown in Section K
dotnet script scripts\analyze-events.csx <path> --segments

# Both flags together
dotnet script scripts\analyze-events.csx <path> --dispatches --timeline

# All flags together
dotnet script scripts\analyze-events.csx <path> --dispatches --timeline --segments

# JSON export (writes export.json beside input; also prints to stdout)
dotnet script scripts\export-events.csx <path>

# JSON export to explicit output file
dotnet script scripts\export-events.csx <path> --out C:\tmp\my-export.json

# Cross-session metrics from every <id>\export.json under session-state (schema v2)
dotnet script scripts\session-metrics.csx C:\Users\USER\.copilot\session-state --out C:\tmp\metrics.json

# Only sessions that started between two UTC dates (inclusive)
dotnet script scripts\session-metrics.csx C:\Users\USER\.copilot\session-state --out C:\tmp\metrics.json --from 2026-05-01 --to 2026-05-17

# HTML dashboard from a metrics file (schema v2: cost from costUsd; no --pricing needed)
dotnet script scripts\render-dashboard.csx C:\tmp\metrics.json --out C:\tmp\dashboard.html

# Dashboard with one working directory and a focus session (schema v1 files need --pricing for USD)
dotnet script scripts\render-dashboard.csx C:\tmp\metrics.json --out C:\tmp\dashboard.html --pricing C:\tmp\pricing.json --group cwd:C:\project --focus <sessionId>

# Setup health check (read-only; prints JSON; default root is ~\.copilot)
pwsh -NoProfile -File scripts\workflow\setup-check.ps1
pwsh -NoProfile -File scripts\workflow\setup-check.ps1 -Root C:\Users\USER\.copilot
```

You can pass either a path to `events.jsonl` directly, or the session directory
(the script will find `events.jsonl` inside it).

## Requirements

- .NET 9 SDK
- `dotnet-script` 2.x: `dotnet tool install -g dotnet-script`
- `Spectre.Console` 0.49.1 (NuGet; auto-restored by dotnet-script)
- PowerShell 7 (`pwsh`) for `workflow/*.ps1` and the `tests/*.ps1` files; `session-metrics.Tests.ps1` needs PowerShell 7.5+
- `git` on PATH for `setup-check.ps1` (it asks git whether paths are ignored and which files are tracked)

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
| K | always | Token / cost table — from the per-request usage records (requests, tokens, cost), not from the summed shutdown counters; shows session wall-clock span, total API duration, premium units and code changes; a session without usage records (older CLI) shows the summed shutdown counters in a `Premium units` column and `Total cost: n/a`; note shown if session has multiple segments |
| K | `--segments` | Also renders a per-segment breakdown before the totals: each segment shows resume/shutdown timestamps, duration, and its own model metrics table |
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
  "segmentCount": 1,             // number of session.shutdown events (>1 if session was resumed)
  "cwd":          "C:\\project",
  "copilotVersion": "1.2.3",
  "sessionStartTime": "...",
  "codeChanges": { "linesAdded": 12, "linesRemoved": 3, "filesModified": ["src/foo.cs"] },  // null when no code-change data
  "currentModel": "...",
  "currentTokens": 148000,
  "systemTokens": 12000,
  "conversationTokens": 136000,
  "toolDefinitionsTokens": 8000,
  // Aggregated across ALL session segments (not just the last shutdown)
  "totalPremiumRequests": 42,
  "totalApiDurationMs":   9876543,

  "eventTypeCounts": { "tool.execution_complete": 120, ... },

  "graphStats": {
    "total": 808, "totalEdges": 807, "roots": 1, "orphans": 0,
    "maxDepth": 45, "avgBranching": 1.23, "internalNodes": 300,
    "leafNodes": 508, "maxToolChainLen": 12,
    "hookPairs": 24, "unmatchedHookEnds": 0
  },

  "hookPairs": [ { "hookType": "PreToolExecution", "durationMs": 42.0, "success": true } ],

  "modelChanges": [ { "ts": "...", "previousModel": "claude-haiku-5.5", "newModel": "claude-sonnet-5.5" } ],

  "compactionEvents": [ { "ts": "...", "tokensBefore": 148000, "tokensAfter": null } ],

  // One entry per session segment (each session resume → shutdown pair).
  // resumeTs is null if the corresponding session.start event is missing (e.g. crash recovery).
  // Paired positionally: segment[0] = start[0] → shutdown[0], etc.
  "segments": [
    {
      "index": 1,
      "resumeTs":             "2026-05-17T10:00:00Z",
      "shutdownTs":           "2026-05-17T11:30:00Z",
      "durationMs":           5400000,
      "totalPremiumRequests": 20,
      "totalApiDurationMs":   4321000,
      "codeChanges": { "linesAdded": 12, "linesRemoved": 3, "filesModified": ["src/foo.cs"] },
      "modelMetrics": {
        "claude-opus-5.5": {
          "requests": 20, "cost": 3.0,
          "inputTokens": 520903, "outputTokens": 8218,
          "cacheReadTokens": 390103, "cacheWriteTokens": 130411,
          "reasoningTokens": null
        }
      }
    }
  ],

  // Aggregated across ALL session segments
  "modelMetrics": {
    "claude-sonnet-5.5": {
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
      "label": "sub-explorer-code #1",
      "agentName": "sub-explorer-code",
      "callId": "abc-123",
      "status": "completed",          // "completed" | "failed" | "in-progress"
      "model": "claude-haiku-5.5",
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

### Cost and usage fields

- `requests`: one entry per `session.usage_record` (one model request). Fields: `timestamp`, `agentId` (null = root), `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `durationMs`, `totalNanoAiu`, and `kind` (root only: `user`, `keepalive` or `notice`).
- `inputTokens` already includes `cacheReadTokens` and `cacheWriteTokens`. Do not add them again.
- `costUsd` (top level, and per model in `modelMetrics`): sum of `totalNanoAiu` / 1e11. The top-level value also includes the compaction cost. `null` means unknown, not 0: the session has no `session.usage_record` events (older CLI versions).
- `compactionCostUsd`: the compaction part of `costUsd`, from `session.compaction_complete`.
- `modelMetrics.cost` is the premium-request count (user-initiated records only, see `totalPremiumRequests`), not USD.
- `totalPremiumRequests` and `totalApiDurationMs`: with usage records, the premium units are the `cost` of the user-initiated records (`initiator` `"user"`, or missing; records with `initiator` `"agent"` or `"sub-agent"` are not counted), and the API time is the `durationMs` sum over all records. Without them (older CLI), the sum of the per-segment shutdown values. Shutdown counters are cumulative on current CLI versions, so they are never added up when usage records exist.
- `hookWindows`: one entry per `preToolUse` hook (`hookInvocationId`, `agentId`, `startTs`, `endTs`, `durationMs`).
- `subagentDispatches[].agentId`: the envelope `agentId` of the sub-agent. It joins the dispatch to its `requests` and `hookWindows`. Omitted when the event has none.
- `sourceEventCount`: the number of non-blank lines read from `events.jsonl`. `session-metrics.csx` compares it with the file (see the staleness check below).

## Metrics and Dashboard

### session-metrics.csx

```
dotnet script session-metrics.csx <sessionStateDir> --out <file> [--from yyyy-MM-dd] [--to yyyy-MM-dd]
dotnet script session-metrics.csx <sessionStateDir>          # JSON to stdout
```

- Reads `<dir>/<id>/export.json` one session at a time. It does **not** run `export-events.csx`.
  If a session has no `export.json`, or the file is stale, run `export-events.csx` on it first.
  The analyst agent does this itself when it is missing or older than `events.jsonl`.
- Folders without `export.json` are ignored. A file that is not valid JSON, or whose root is not an
  object, is listed in `skipped[]` with a reason. It never stops the run.
- **Staleness check.** For each folder that has `events.jsonl`, `export.json` must have a `sourceEventCount` at least as large as the number of non-blank lines in `events.jsonl`. A missing or lower value means the export is stale. The script checks every session in range, then stops before it writes anything and prints one message to stderr that names all stale sessions: `export.json is stale for <id>[, <id>...]: run export-events.csx first`. It exits `2`. A folder without `events.jsonl` cannot be checked and is accepted.
- `--from` / `--to` filter on the **UTC date of `sessionStart`** (inclusive).
- Exit codes: `0` ok; `1` usage error (no directory, bad date); `2` stale export (see the staleness check). A run that exits `2` writes nothing.

#### Metrics JSON schema (schemaVersion 2)

`render-dashboard.csx` and the analyst read this schema. Do not rename or remove fields without
bumping `schemaVersion`. Schema v2 only adds fields: every v1 field keeps its name and meaning.

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-05-18T09:00:00Z",
  "source": "C:\\Users\\USER\\.copilot\\session-state",   // full path of <sessionStateDir>
  "sessions": [
    {
      "sessionId": "...",              // falls back to the folder name when absent
      "startTime": "...", "endTime": "...",   // sessionStart / sessionEnd, unchanged
      "cwd": "C:\\project",
      "gitRoot": null,                 // always null: gitRoot is not in export.json
      "copilotVersion": "1.2.3",
      "durationMs": 7200000,
      "userTurns": 14,                 // timeline user.message events, all lanes
      "premiumRequests": 42,           // totalPremiumRequests
      "models": [
        { "model": "claude-opus-5.5", "requests": 20, "inputTokens": 520903, "outputTokens": 8218,
          "cacheReadTokens": 390103, "cacheWriteTokens": 130411 }
      ],
      "cacheReadRatio": 0.43,          // 0..1 fraction: cacheRead / input (inputTokens already includes the cache); null if absent or input is 0
      "compactions": 1,
      "peakContextTokens": 148000,     // LOWER BOUND: max(compaction tokensBefore, currentTokens)
      "errors": 2,                     // errorCount
      "toolCalls": 120,
      "toolFailures": 3,
      "dispatches": 13,                // subagentDispatches
      "dispatchFailures": 1,           // status other than "completed"
      "repeatDispatches": 2,           // HEURISTIC: same agentName again within one user turn
      "writeAgentCalls": 0,
      "builtinAgentDispatches": 4,     // explore, task, general-purpose, code-review, research, rubber-duck, security-review
      "readOnlyAgentWriteCalls": 0,    // edit/create by read-only agents: sub-expert, sub-explorer, sub-reviewer, sub-debugger, sub-expert-*, sub-explorer-*, sub-reviewer-*, sub-researcher-*
      "mainPowershellCalls": 35,       // orchestrator lane only; subagent lanes excluded
      "agents": [
        { "agentName": "sub-explorer-code", "dispatches": 5, "failures": 0, "repeatDispatches": 1,
          "totalTokens": 19000, "medianTokens": 3800, "medianDurationMs": 12000.0, "toolCalls": 22 }
      ]
    }
  ],
  "skipped": [ { "sessionId": "...", "reason": "..." } ]
}
```

Null rules: an absent source field gives `null`, never a guessed value. An aggregate is `null` when any
value it needs is missing. For example, a dispatch without `totalTokens` makes that agent's
`totalTokens` and `medianTokens` `null`. A dispatch without `agentName` makes the agent-based fields
`null` for that session.

#### Schema v2 fields

- Session: `costUsd` and `compactionCostUsd` (USD; `null` without per-request records), and `models[].costUsd`.
- `agentUsage[]`: one row per agent. `agent` is `main` for root requests. A sub-agent request takes the `agentName` of its dispatch. An older export without dispatch `agentId` is matched by time window; a request that cannot be matched gives `unattributed`. Fields: `agent`, `requests`, `costUsd`, `llmMs` (sum of request `durationMs`), `toolMs` (sum of tool event `durationMs` in the agent's lane), `wallMs` (`durationMs` for main; the sum of the dispatch `durationMs` for a sub-agent), `otherMs` (`max(0, wallMs − llmMs − toolMs)`).
- `keepAlive`: `pings` (the first root request after each `[keepalive]` message), `costUsd` (the pings only), `chains` (runs of keep-alive messages that have a ping and no real user message between them), `wastedChains` (a chain whose next real root request is a cache miss: `inputTokens` ≥ 20000 and `cacheWriteTokens` > 0.5 × `inputTokens`).
- `hookLatency`: `count`, `totalMs`, `p50Ms`, `p90Ms` (nearest rank) over the `preToolUse` hook windows.

### render-dashboard.csx

```
dotnet script render-dashboard.csx <metrics.json> --out <file.html> [--pricing <pricing.json>]
    [--from yyyy-MM-dd] [--to yyyy-MM-dd] [--group all|cwd:<path>] [--focus <sessionId>]
```

- Writes one self-contained HTML file: inline CSS and inline SVG, no JavaScript, no external URLs.
- Seven series, each a line chart: cost (USD) or total tokens, cache read ratio, compactions per session,
  dispatch failure rate, repeat-dispatch rate, errors per session, user turns per session.
  Schema v2: cost is the file's `costUsd`; `--pricing` is ignored (a note says so). Schema v1: `--pricing` gives the cost; without it the cost chart shows total tokens. Sessions with a null cost are n/a. `inputTokens` includes the cache tokens, so total tokens = input + output, and v1 cost = (input − cacheRead − cacheWrite) × input rate + output × output rate + cacheRead × cache-read rate + cacheWrite × cache-write rate (per million tokens).
- Buckets: one per day when the range is 45 days or fewer, otherwise one per ISO week.
- Sections: per-agent table, rule-signal table, and (with `--focus`) a Focus vs baseline section with the
  median and p25–p75 of the other sessions.
- `--group cwd:<path>` keeps only sessions whose `cwd` matches. `all` (the default) keeps every session.
- Exit codes: `0` written; `2` usage error (for example, missing `--out`); `1` unreadable or invalid input.

### pricing.json (schema v1 only)

```jsonc
{
  "source": "where the prices came from (a URL or a note)",
  "retrieved": "2026-05-18",
  "models": {
    "<model name as in export.json>": { "input": 0.00, "output": 0.00, "cacheRead": 0.00, "cacheWrite": 0.00 }
  }
}
```

- All rates are **USD per million tokens**. The zeros above are placeholders, not prices.
- A model needs all four rates. A model with any rate missing is left out of the cost series, and the
  dashboard notes it. Unpriced models do not count as zero cost.
- Schema v2 metrics do not need this file. No agent writes it any more.

## Setup check

`workflow/setup-check.ps1 [-Root <dir>]` (default `~\.copilot`) checks the Copilot setup: agents, skills,
hooks, settings, and git ignore rules. It is read-only and automates the mechanical part of the review
checklist in AGENTS.md §13.

- Output: one JSON object on stdout:
  `{ ok, root, generatedAt, summary: { pass, fail, warn }, checks: [ { id, severity, subject, status, message, evidence: [ { path, line } ] } ] }`.
  `summary.fail` counts error-severity failures. `summary.warn` counts warn-severity failures. Info results are not counted.
- Exit codes: `0` no error-severity failure; `1` at least one error-severity failure (a valid result, not a crash);
  `2` internal error or missing root.
- It never opens secret paths (`mcp-secrets/`, `mcp-oauth-config/`, `entra-broker-*`, `config.json`,
  `mcp-config.json`). Git-tracked secret-adjacent files are reported by name only.

| Check ID | Severity | What it checks |
|---|---|---|
| AGT-FRONTMATTER | error | Every `agents/*.agent.md` has `name` and `description` |
| AGT-NAME-FILE | warn | Agent `name` matches the file name |
| AGT-MODEL-DESC | error | The model named in `description` matches the `model` field |
| AGT-AGENT-TOOL | error | The `agent` tool is limited to allowed agents |
| AGT-SHELL-DISCIPLINE | error | Top-level agents (`disable-model-invocation: true`) with `powershell` have their own "Shell discipline" section; `cli-tools/_shell.json` has a `Shell discipline:` rule and `subagent-context/shared-rules.md` has the four shared headings (`Reports`, `NEEDS-INPUT`, `Evidence`, `Secrets`). Sub-agents get these rules by injection and need no heading. |
| AGT-CLITOOLS | warn | Agents with `powershell` have a `cli-tools/<agent>.json` file |
| REF-AGENT-NAMES | error | Every agent name referenced in the docs and agents resolves to a file |
| REF-SKIPLIST | warn | The `util-plugin-sync` skip-list names every agent |
| HOOK-SCRIPT | error | Every script path in `hooks/*.json` exists |
| SKILL-FOLDER | error | Every enabled skill folder has a `SKILL.md` with `name` and `description` |
| SKILL-ORPHAN | info | Every `settings.json` `disabledSkills` entry names an existing skill folder (info only, never changes the exit code) |
| SET-EXT | error | `settings.json` has extensions enabled, a mode set, and an existing `statusLine` target |
| JSON-VALID | error | `settings`, hooks, cli-tools and cache-keeper JSON files parse |
| GIT-IGNORE | error | Runtime paths are git-ignored |
| GIT-TRACKED-SENSITIVE | warn | No secret-adjacent files are git-tracked (names only) |

## Map check

`workflow/map-check.ps1 -MapPath <map.md> [-RepoRoot <dir>]` checks the evidence of Mermaid "map" documents
(current and target state) against the repository. It is read-only and deterministic, so the planner and the
reviewer use it instead of model judgment.

- Input: fenced ```` ```mermaid ```` blocks. Supported kinds: `classDiagram`, `flowchart` / `graph`, `sequenceDiagram`.
  A leading front-matter block (`---` ... `---`) is skipped. Any other kind is a warning (`diagram N: kind 'x' not
  checked`); a map with no supported diagram is an error. Each supported block is followed by an evidence table with
  the header `Element | Evidence | Note`; the first such table before the next Mermaid block is used. A diagram
  without that table is one error (`no evidence table`).
- Table cells: one pair of surrounding backticks is removed (`` `Greeter` `` matches `Greeter`). A `|` inside a cell
  must be escaped as `\|`, so an arrow such as `<\|--` stays in its cell.
- Coverage: every node needs a row in its diagram's table. Structural edges (classDiagram, flowchart) need a row
  `A -> B` with any arrow text, the endpoints in the order written in the diagram. Sequence messages need no row.
  Flowchart `A --> B & C` and `A & B --> C` give one edge per pair; labelled arrows (`-- text -->`, `-. text .->`,
  `== text ==>`) keep the label out of the node set.
- Not understood: a diagram line the grammar does not parse (for example `Greeter ==> Cli`) is a warning
  (`diagram N line L: not understood, not checked: ...`). Keywords such as `alt`, `loop`, `Note`, `subgraph`, `style`
  and class-body members are recognised and produce no warning.
- Evidence: `path:line` or `path:start-end` (repo-relative file; absolute and escaping paths are errors), `inferred`
  (warning) or `new (T<n>)`. `new` needs the element (for an edge: its target) styled `added`: `class X:::added`,
  `class X added` or `X:::added`. Line numbers beyond the file are reported as "outside the file".
- Name rule: the evidence name is the node's label, verbatim: the class name for classDiagram, the label for flowchart
  (`A[Cli]` gives `Cli`), the alias for sequence (`participant G as Greeter` gives `Greeter`). Use identifiers as they
  appear in the cited code. The name must occur as a whole word, case-sensitively, within 3 lines of the cited range.
  Generics are ignored for names: `Foo<T>`, `Foo~T~` and `Foo` are one node `Foo`.
- A row element matches a node by its id, label or alias (generics ignored).
- `-RepoRoot` defaults to the git root above the map's `Repository:` header value (forms: `Repository: X`,
  `**Repository:** X`, list items `- ...` / `* ...`, backticked value); it is required when that line is absent.
- Output: one JSON object on stdout: `{ ok, errors, warnings, stats: { diagrams, nodes, edges, rows, inferred } }`.
  `nodes` and `edges` are summed over the supported diagrams.
- Exit codes: `0` no errors; `1` at least one error (a valid result); `2` usage or internal error (the message is
  in `errors`).
- Not checked: subgraph membership; diagram kinds other than the three above.


## Tests

| Command | Covers |
|---|---|
| `pwsh -NoProfile -File workflow\plan-check.Tests.ps1` | plan-check.ps1 |
| `pwsh -NoProfile -File workflow\map-check.Tests.ps1` | map-check.ps1 (fixtures under workflow\fixtures\map) |
| `pwsh -NoProfile -File workflow\setup-check.Tests.ps1` | setup-check.ps1 (good and bad fixtures) |
| `pwsh -NoProfile -File tests\session-metrics.Tests.ps1` | session-metrics.csx (needs PowerShell 7.5+) |
| `pwsh -NoProfile -File tests\export-events.Tests.ps1` | export-events.csx (usage records, hook windows, `sourceEventCount`) |
| `pwsh -NoProfile -File tests\render-dashboard.Tests.ps1` | render-dashboard.csx |

Each test script exits with its failure count, so `0` means all pass.

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

## Test Sessions

| Session ID | Size | Notes |
|---|---|---|
| `d05a4c88-88e0-4ccc-be9a-8b36f6827d55` | ~808 events | Primary test; 13 subagents |
| `65e0fe77-cba3-4fac-b9dd-4dc4aaa0e9f5` | ~1632 events | Has abort, compaction, subagent.failed |
| `6f1e66f1-75ff-427a-8642-65c19f93861d` | ~3709 events | 4 session segments; multi-model; good test for --segments and aggregation |
| `07061697-bbea-499e-aee0-87da13085544` | 14.5 MB | Lines > 256 KB; SeekLine buffer stress test |
| `5201768c-8da9-46c2-8276-40f9bc203f24` | 108 MB | Stress test (low priority) |
