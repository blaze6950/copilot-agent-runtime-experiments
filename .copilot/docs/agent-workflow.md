# Agent Workflow — Main Orchestrator

One persistent orchestrator (`1main`) owns a task from first discussion to verified completion.
Phase transitions are explicit user commands; specialized subagents do all tool-heavy and write work.

```
                         you        /save  /stop  (user-only shortcuts)
                          │  /agent 1main  (Brainstorm by default)
                          ▼
            ┌──────────────────────────┐   plan.md  (# Plan + # Working Memory)
            │  1main (Opus 5.5, high)  │── implementation-state.md (execution state)
            └──────────────────────────┘
      /1make-plan │            │ /1implement            /save → sub-manager-docs (single instance)
                 ▼            ▼
 ── context quarantine: raw tool output and all writes stay below this line (flat: only main dispatches) ──
  sub-explorer-* · sub-reviewer-* · sub-expert-*          sub-worker-main  (main working tree, Rider/Roslyn, one at a time)
  sub-manager-docs · sub-manager-history                  sub-worker-wt ×N (own worktree + branch, parallel, no IDE)
```

## Quick start

1. `copilot --agent 1main` (or `/agent 1main`). There is no "default agent" setting; use the flag or the picker.
2. **Brainstorm** — describe the goal. Main decomposes the request, researches through subagents, assesses options as a principal engineer, recommends one. Run **`/save`** whenever you want the agreed facts and decisions persisted: Main sends a SAVE PACKET to `sub-manager-docs`, which updates `plan.md` → `# Working Memory` without duplicating or silently overwriting decisions.
3. **`/1make-plan`** — when decisions have converged. Main writes the high-level `# Plan`; the implementation planner (`sub-planner-implementation`) writes the task blocks; Main checks them; `plan-check.ps1` validates the result. Status `DRAFT`. Unresolved decisions are asked, never invented. See [Planning flow](#planning-flow).
4. Review or edit `plan.md` — it is authoritative. Re-run `/1make-plan` after material changes (revision is bumped).
5. **`/1implement`** — approves the current revision and executes it in the same session: setup → main-tree and parallel worktree Workers (each task by its [Method](#worker-methods)) → integration by a main-tree Worker → [Review](#review) → final verification → report. Work lands on the plan's target branch; nothing is pushed or merged elsewhere without your approval. Do not edit the working tree or IDE while it runs.

`/plan` is a built-in CLI command (it switches the session into plan mode and prefixes every later message with `[[PLAN]]`), so the planning skill is named `/1make-plan`. If you type `/plan …`, Main treats the first message as `/1make-plan`; press Shift+Tab to leave plan mode before `/1implement`.

## Agent categories

Sub-agent names carry their category prefix. Main's prompt holds only the category table; each agent's frontmatter `description` (the only part Main sees in the `task` tool) states purpose, limits and **Dispatch:** notes. Output formats live only in the agents' own instructions. Only `1main` has the `agent` tool, so the topology stays flat.

| Prefix | Category | Agents | Rights |
|--------|----------|--------|--------|
| `sub-worker-*` | Workers | `sub-worker-main` (main tree, IDE, one at a time), `sub-worker-wt` (worktree, parallel), `sub-worker-docker`, `sub-worker-media` | write within the assigned scope |
| `sub-expert-*` | Domain experts | ADO (+ `sub-expert-ado-writer`), GitHub, Backstage, EDM, docs (Context7), Scalr, ArgoCD prod/nonprod, New Relic, Miro, web, k8s prod/nonprod, Snowflake prod/nonprod, db (usql), az, aws, hetzner, gws | read-only; writes only with `AUTHORIZED WRITE` where the description allows |
| `sub-explorer-*` | Explorers | `sub-explorer-code` (codebase, local data, plan-check), `sub-explorer-debug` (failure diagnosis) | read-only |
| `sub-reviewer-*` | Reviewers | `sub-reviewer-code` (claude-sonnet-5.5, effort high) | read-only (may run builds/tests); verdict APPROVE, CHANGES_REQUIRED or BLOCKED |
| `sub-planner-*` | Planner | `sub-planner-implementation` (claude-opus-5.5, effort high) | read-only on repositories; writes only its map files, its plan-tasks file and its report, during `/1make-plan` |
| `sub-manager-*` | Managers | `sub-manager-docs` (Working Memory of the current session, only via `/save`), `sub-manager-history` (read-only research across all past sessions) | docs: session folder only; history: read-only |

`1main`: brainstorm, assess, plan, coordinate, review evidence, report; writes `# Plan` and `implementation-state.md`; PowerShell only when no sub-agent fits, and the shell governor decides each call (see [Shell and approvals](#shell-and-approvals)); `claude-opus-5.5`, effort `high`. Sub-agents default to `claude-haiku-5.5`, except the planner (`claude-opus-5.5`, effort `high`) and the reviewer (`claude-sonnet-5.5`, effort `high`).

**Communication:** Main's second goal is shared understanding: you should be able to judge its conclusions without repeating its research. It explains at checkpoints (before dispatch batches, after results, before decisions and phase changes, on surprises and failures), in clear B2-level English, separates verified facts, interpretations, assumptions and unknowns, and gives sources (code `path:line @ commit`, docs, full URLs; local files as one Markdown link: readable `C:\...\File.cs:120-135` text with a `file:///` URL target, which Windows Terminal can open). The CLI's built-in brevity rules are overridden for these explanations. Details: "Communicating with the user" in `agents/1main.agent.md`.

Every sub-agent report ends with an `## Evidence` section (sources, queries/commands, raw excerpts, confirmed vs inferred, gaps); the chat answer only points to it. Every agent with shell access follows the shell rules: top-level agents carry a "Shell discipline" block, and sub-agents get the same rules injected from `cli-tools/_shell.json` (see [Injected context](#injected-context)). The `subagentStart` hook (`subagent-context/inject.ps1`) also injects the shared rules, the session block with the reports folder, and each agent's CLI tool list. Reports and `NEEDS-INPUT` are described in [Reports and NEEDS-INPUT](#reports-and-needs-input).

## Planning flow

`/1make-plan` (skill `1make-plan`) runs in `1main`. Main keeps the decisions; the planner does the code-base design.

| Step | Who | Output |
|---|---|---|
| 1. Readiness | Main | Decisions to encode; blocking questions asked first |
| 2. Facts | `sub-explorer-code`, keepers (background) | Reports with sources; the facts go into `## Context` |
| 3. High-level plan | Main | `# Plan` without tasks: goal, scope with a feature outline, context, constraints, decisions, acceptance criteria |
| 4. Implementation design | `sub-planner-implementation` (background, `claude-opus-5.5`, effort high) | Phase 1: `files\map-asis-r<N>.md`, then a stop for your review. Phase 2: `files\map-target-r<N>.md` and `files\plan-tasks-r<N>.md` with `## Integration design` and `## Tasks` (each task has a `Map` line), plus its report |
| 5. Self-review | Main | Every task has one valid Method, valid workspace, exclusive or ordered ownership and AC coverage; every `added`, `changed` or `removed` target-map element is in some task's `Map` and every `Map` entry is in the target map; corrections go back to the planner |
| 6–7. Write and validate | Main, `sub-explorer-code` | Tasks copied into `# Plan`; `plan-check.ps1` must exit 0 |

- The planner never changes goal, scope or accepted decisions. Conflicts and missing facts come back as `NEEDS-INPUT`; Main answers them with `write_agent` or asks you one question.
- Planner output is versioned: `plan-tasks-r<N>.md`, and corrections use `-2`, `-3`, … New paths only; earlier versions stay on disk. `- Design file:` in `## Engineering Assessment` names the latest one.
- Maps are standalone Markdown documents with Mermaid diagrams and evidence tables, written by the planner (never retold or redrawn by Main) and checked by `session-state/scripts/workflow/map-check.ps1` (see `session-state/scripts/README.md`, "Map check"). Phase 1 writes the current-state map and stops with `NEEDS-INPUT`; Main gives you only the file path and asks what is wrong or missing. Open it in VS Code (Markdown preview) and edit it if needed; phase 2 reads the file as it is on disk. Map files live directly in `files\`. One rule for every map version: Main names the `r<N>` paths of a new revision only; the planner names the next `-<k>` version of any map (as-is or target) itself and reports the paths, and Main records them in `- Current-state map:` and `- Target map:`. A task-only revision passes the latest as-is and target maps as existing maps (no new as-is review); the planner writes a new `-<k>` target version only if the target structure changes. A goal, scope or decision revision passes new `r<N>` paths for both maps, unless the touched code area looks unchanged: Main proposes reuse from the changed feature outline and passes the existing as-is map; the planner re-reads the code and confirms whether the map still covers the touched area, otherwise it asks for a new as-is review (you review the as-is map again then). `- Current-state map:` and `- Target map:` in `## Engineering Assessment` name the latest versions (or `none`).
- Task rules (Method, unit, workspaces, ownership, Model, Review, Verify) are defined once in `agents/sub-planner-implementation.agent.md`, section "Rules for the task blocks". The `Map` field lists the target-map elements a task adds, changes or removes (`none` for a task that builds no mapped element: verify, git-ops, pure test or documentation task); plan-check accepts it as an unknown field and it feeds the task hash.

## Review

The reviewer `sub-reviewer-code` (claude-sonnet-5.5, effort high) is read-only and may run builds and tests. It reads every changed file fully, checks plan and requirement alignment, the planner design, correctness, repository conventions, maintainability and tests, and returns `APPROVE`, `CHANGES_REQUIRED` or `BLOCKED` with evidence. It does not trust Worker summaries.

- `Review: per-task` tasks are reviewed before they are marked merged. The final review covers the whole range before the final report.
- Dispatch templates: `skills/1implement/references/reviewer-dispatch.md`. Missing `repo`, `range`, `plan_path` or `design_path` → `BLOCKED`. The reviewer also receives `asis_map_path` and `target_map_path` (each a path or `none`; an absent plan line → `none`); with a target map it re-runs `map-check.ps1` on the as-is map (drift = only errors on rows whose file is not in `git diff --name-only <range>`; rows in changed files are expected to move and are ignored; drift is a Warning "as-is map drift", never BLOCKED) and compares the implemented structure with the target map (per-task review: the task's `Map` elements; final review: the whole map). It reports the result in the `maps:` line of the verdict header; an unreadable or missing map file given in the dispatch is a gap noted in `maps:`, never BLOCKED.
- `CHANGES_REQUIRED` goes to the Worker, not to the reviewer. The Worker's fix comes back to the same reviewer as a delta re-review (`write_agent`).
- A task without a new commit gets no per-task review; Main checks its `method_evidence` instead.

## User shortcuts: /save and /stop

| Skill | Effect |
|-------|--------|
| `/save [notes]` | Main builds a SAVE PACKET (typed records: decisions with status and confirmation, facts, rejections, task states, verification results) since the last save and hands it to the single `sub-manager-docs` instance — reused via `write_agent` when idle, awaited when running, dispatched only when none exists. Repeating `/save` adds nothing twice. No commits. |
| `/stop [agents]` | Cooperative stop at the next safe point: nothing new is started, a checkpoint (done, unfinished, running agents, risks) is reported, then Main waits. `/stop agents` also asks running sub-agents to stop via `write_agent`. Hard cancel remains `/tasks` → `x` or double-Esc (double-Esc while Main is busy interrupts only Main's turn). |

Both are `disable-model-invocation: true` — only you trigger them. A message typed while Main is busy is steering (folded into the running turn); whether a slash skill typed mid-turn is steered or queued must be checked in a live session.

## Prompt-cache keeper (extension)

The provider prompt cache lives 5 minutes, measured from the **start** of the last request that used it. When you take longer to read Main's output, or Main waits for background Workers, the next request rewrites the whole context (Opus: ~$2.20 at 440K tokens) instead of reading it from cache (~$0.09). `extensions/cache-keeper/` (Copilot CLI extension, experimental feature flag) prevents this. The logic lives in `extensions/cache-keeper/lib/` (pure decision rules in `policy.mjs`, unit-tested); `extension.mjs` only wires it to the session. The module map is in `AGENTS.md` §7.

| Mode | When | Action |
|---|---|---|
| Idle ladder | Main idle, no background task running; fires `marginSec` before the CLI-reported `cacheExpiresAt` | 1. keep-alives first: `ladder.keepalives` (10), keep-alive `[keepalive] …` (Main replies `ok` without tools) · 2. then the actions of `ladder.actions` in order, one per deadline: `/save` only for agents in `when.agents` (`1main`) and only if you said something since the last save (`when.changedSinceLastRun`); `/compact` only at ≥ `when.minContextTokens` (150000) context tokens; a command runs only when the model is idle and the queue is empty · 3. then nothing until you return; the status line then shows `ladder done, waiting for you` (wait keep-alives follow only while a background task runs, see Wait mode) |
| Wait mode | Main idle while background agents or shells run (`tasks.list`) | keep-alives that do **not** consume the idle ladder, up to `wait.maxRefreshes` (~3.75 h); never compacts |
| Unblock | A ladder command the keeper queued is still pending at the re-check about 10 s after queueing (or at any later deadline) and holds your queue back | removes that command from the queue (only items the keeper queued itself), then runs your first waiting message or sends a keep-alive. A removed action follows its `ifRemoved` rule. While the command is held the keeper re-checks every 10 s (also after the cache expired; not while Main's root tool runs, and right after it has finished); an enqueue whose outcome is unclear is re-checked every 10 s while it stays unknown, also during a root tool (the rescue still runs); after 5 failed removals every 60 s; a held item that is not the keeper's own gets one keep-alive and is not tracked further. |
| Rescue | Main busy inside a sync tool, `rescue.marginSec` before expiry | promotes Main's own sync `powershell`/`task` to background (`tasks.promoteToBackground`), so the turn continues and the next request refreshes the cache. The tool result then reads "moved to background by the user" (rule in `1main.agent.md`). Ambiguous shells and `ask_user` waits are only logged. |

- The keeper keeps one timer at `marginSec` (30 s) before the cache expires; `rescue.marginSec` (45 s) while a root tool runs. When the timer fires, it reads the session and applies the decision table in `lib/policy.mjs` (first match wins). If the model, queue or task state cannot be read, it does nothing and checks again 10 s later.
- Any message from you resets the ladder and the wait counter. An action is skipped when your input is already queued, and nothing is sent once the cache has already expired. Before the first model request of a session (for example after resume), nothing is sent: the keeper does not guess the expiry.
- Why the `/save` gate and the unblock step exist: live tests on CLI 1.0.98 showed that a keeper-queued `/save` blocks the queue and suppresses `assistant.idle` while background work runs. The old keeper acted only after `assistant.idle`, so it stayed silent for hours. Normal keep-alive prompts run at once, even during background work.
- Ladder actions: the order, the action fields (`id`, `command` or `text`, `when`, `ifRemoved`) and the ten decision rows are described in AGENTS.md §7.
- Known trade-off (your decision): if an enqueue takes more than 5 s and you type the same command in the same ~20 s window, the keeper may remove your command. The action then follows its `ifRemoved` rule.
- Compaction does not reuse the conversation cache (it is billed as fresh input), so keep-alives — not compaction — are what save money on short absences; compaction only shrinks later requests.
- Status line (`statusLine.command` → `extensions/cache-keeper/statusline.mjs`, `refreshInterval: 5`): label `main`, shown in every view, including the full-screen sub-agent view. It shows clock times, for example `main cache until 17:31:45 | next keepalive 17:31:15 (2/12)` or `next /save 17:41:15 (11/12)`; `(refreshing)` while a request is in flight, `(wait 3/50)` in wait mode, `busy in powershell, rescue 17:30:00` while Main waits in a sync tool. When the cache has expired: `!! main cache expired !!` in red. The whole line is green for 6 s after a keeper refresh. A keep-alive shows the cache saving, with its ping cost in parentheses (AGENTS.md §7). `NO_COLOR` turns colours off. ASCII only, because wide glyphs break column math in some consoles. Set it in the user `settings.json`: a repo-level `.github/copilot/settings.json` is ignored by the CLI. A running CLI needs a new window to pick up settings changes. `statusLine.countdown` (default `false`) adds the remaining time in brackets; with `refreshInterval` 5 the countdown moves in 5 s steps (pairing and cost: AGENTS.md §7). A 5 s refresh cuts the cost of the refresh (the CLI starts cmd and node each time, about 100 ms) by 5×.
- Log (`extensions/cache-keeper/logs/`): every Main request as `hit`/`MISS` with context, cache read/write, gap and whether it followed an idle period; every action, wait keep-alive and rescue decision.
- Config: `extensions/cache-keeper/config.json` (`marginSec`, `fallbackTtlSec`, `ladder.*`, `statusLine.*`, `rescue.*`, `wait.*`, `miss.*`); `COPILOT_CACHE_KEEPER_CONFIG=<file>` overrides it, `COPILOT_CACHE_KEEPER=off` disables it.
- Tests: `node --test "extensions/cache-keeper/tests/*.test.mjs"` (run from `C:\Users\USER\.copilot`; 318 tests; on Node 24 use the glob, a directory argument does not work).
- Requires `settings.json` → `"enabledFeatureFlags": { "EXTENSIONS": true }` (only this flag, not full `/experimental`) and `"extensions": { "mode": "load_only" }` (the agent gets no extension-management tools). Extensions load at session start; the CLI launches only `extension.mjs` of each extension folder.
- Rescue uses `@experimental` SDK calls (`tasks.list`, `tasks.promoteToBackground`); if they fail, the failure is logged, nothing is promoted and the turn continues as it is.
- Not covered: sub-agents' own caches (a Haiku rewrite costs < $0.01) and `ask_user` waits (Main is blocked on you). In `-p` mode the CLI defers wait-mode keep-alives until background tasks finish and does not deliver `session.shutdown` (a stale state file remains; the status line ignores it after 24 h).

## Turn statistics (extension)

`extensions/turn-cost/` adds turn statistics to the timeline. After each real turn it writes one cyan line, or a short table when a sub-agent ran or the turn cost more than $0.50: time, cost, session total and per-agent figures. Keep-alive turns get no line; their cost appears in the next header. Each metric can be switched on or off in `extensions/turn-cost/config.json`. The lines go to the session log only and never reach the model. `COPILOT_TURN_COST=off` switches the extension off. Details, module map and examples: [AGENTS.md §7c](../AGENTS.md).

## Workspaces

| | `sub-worker-main` (Workspace `main`) | `sub-worker-wt` (Workspace `worktree`) |
|---|---|---|
| Where | main working tree, target branch | `<repo>/.worktrees/<slug>/<Tid>` on `wf/<slug>/<Tid>`, created by the Worker from the given base commit |
| Concurrency | one at a time (single writer of the main tree) | parallel (default max 3), may run while a `sub-worker-main` task runs |
| IDE | Rider MCP write tools (atomic, semantic refactorings) | none — the IDE shows the main tree |
| Best for | small/sequential work, renames/signature changes/moves, shared hot-spots, solution-wide refactorings (`Owns: **`) | independent, additive, well-bounded tasks worth parallelizing |
| Integration | commits land directly on the target branch | merged by a `sub-worker-main` in `integrate` mode: gate (commit, clean tree, ownership, plan hash, verify) → merge → conflict resolution preserving both tasks' intent (unresolvable → abort and report to Main, decided with you) → verification → worktree removal |

`.worktrees/` is ignored through `.git/info/exclude` (local only). Worktrees isolate workspaces, **not permissions**.

## Worker methods

Each plan task has one `Method`. The Worker follows that Method only and never switches it. A Method that does not fit the task → `NEEDS-INPUT` with options; a missing or invalid Method → `BLOCKED`. The Method's proof of done goes into the HANDOFF field `method_evidence`.

| Method | Use for | Proof of done | Worker |
|---|---|---|---|
| `tdd` | behaviour change | RED run (failing test names and reason), GREEN run, REFACTOR re-run | main, wt |
| `refactor` | structure change, behaviour unchanged | covering tests before and after | main, wt |
| `mechanical` | renames, version bumps, docs, config | `Verify` before and after; the second run passes | main, wt |
| `git-ops` | local git operations (merge into the target branch, tags, branch creation) | read-back (for example `git log --oneline -1`, `git tag --list`, `git branch --show-current`) | main only |
| `verify` | checks only; changes no files | each command with exit code and summary counts | main only |

- Worktree tasks (`sub-worker-wt`) accept only `tdd`, `refactor` and `mechanical`; `git-ops` and `verify` are `BLOCKED` there.
- Pushing needs `push: yes (user approved: "<quote>")` in the dispatch, whatever the Method. Main-tree dispatches carry `allow_dirty`: `yes` only when you approved working with pre-existing uncommitted changes.
- `/1implement` checks each HANDOFF: `method` equals the plan task's Method and `method_evidence` is present. A legacy `TDD: exempt — <reason>` counts as `mechanical`.
- Rules: `agents/sub-worker-main.agent.md` and `agents/sub-worker-wt.agent.md`, section "Methods"; plan requirements: `skills/1make-plan/SKILL.md`, Step 6.

## Reports and NEEDS-INPUT

Every sub-agent that completes a request writes its full result to one new Markdown file in the reports folder named on the `reports:` line of its `## Session` block (`<session folder>\files\reports`; the hook creates the folder). The rules are in `subagent-context/shared-rules.md`.

- Name: `<yyyyMMdd-HHmm>-<agent>-<slug>.md`, local time. Created with `create` only, also by read-only sub-agents; a taken name gets `-2`, `-3`, and so on.
- Header: `# <request>`, then `- request:`, `- status:` (DONE, NEEDS-INPUT, BLOCKED or FAILED) and `- sources:`. The report ends with `## Evidence`.
- The chat answer is 5–15 lines and points to the report. Workers keep their HANDOFF as the final answer and give the report path in `report:`.
- Main passes knowledge to an agent by report path (with a one-line note of what it proves), not by pasting report content into the prompt.
- `NEEDS-INPUT`: the agent stops before the affected work, writes what it did so far to its report, and returns numbered questions with 2–4 options each (recommended option marked). Main answers with `write_agent` to the same agent, or asks you one question when it is a real decision. Assumptions are stated, never made silently.

## Injected context

`subagent-context/inject.ps1` (the `subagentStart` hook) gives every sub-agent a common base. Sections, in order; details and the log are in [AGENTS.md §3](../AGENTS.md):

1. **Shared rules**: `subagent-context/shared-rules.md` (Reports, NEEDS-INPUT, Evidence, Secrets), for every sub-agent.
2. **Session**: id, folder, events and reports folder, for every sub-agent.
3. **CLI tools and rules**: `cli-tools/_shell.json` (generic shell rules, including the `Shell discipline:` rule) plus `cli-tools/<agent>.json` (tool list). Tool-specific rules live in each tool's `UseCase`, for example `git --no-pager` for git and GraphQL for GitHub review threads.
4. **Code roles only** (`sub-planner-implementation`, `sub-worker-main`, `sub-worker-wt`, `sub-reviewer-code`, from `conventions/profiles.json`): the convention packs and the repository instructions.

The hook writes one cyan progress line per sub-agent (UI rule, [AGENTS.md §3](../AGENTS.md)).

Convention packs (`conventions/`): `general.md` for every code role; `dotnet.md` only when the repository root has `*.sln`, `*.slnx` or `*.csproj`. The packs hold gold-standard rules only, and repository conventions override them.

Repository instructions (`AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/**`) reach the code roles through the CLI, because they set `include-custom-instructions: true`. The live probe verified this (`tests/hooks/live/RESULTS.md`). `profiles.json` sets both instruction modes to `native`, so the hook injects no repository-instruction text.

Each section fails on its own: a failing section is logged and the other sections are still emitted.

## Shell and approvals

- Main has no per-command approval rule. Its PowerShell is for work that no sub-agent fits. The shell governor (`extensions/shell-governor/`, [AGENTS.md §7b](../AGENTS.md)) decides every `powershell` call: allow, AI judge, or your approval dialog. The dialog can cut long script lines with `dialog.maxLineChars`; the review file always has the full script.
- Read-only sub-agents have governor overrides (26 agents, AGENTS.md §7b): `repo` read and execute; plan and implementation state read-only. Writing agents (`sub-worker-*`, `sub-manager-docs`) have no override.
- The governor is a guard, not a sandbox (AGENTS.md §7b).

## Model configuration

| What | Where |
|------|-------|
| Main model + effort | `agents/1main.agent.md` → `model`, `reasoning-effort` (used for Main's requests regardless of the managed `auto` default; edit the frontmatter to change it) |
| Planner model + effort | `agents/sub-planner-implementation.agent.md` → `claude-opus-5.5`, `reasoning-effort: high`; Main also passes both on each dispatch |
| Reviewer model + effort | `agents/sub-reviewer-code.agent.md` → `claude-sonnet-5.5`, `reasoning-effort: high`; Main also passes both on each dispatch (`skills/1implement/references/reviewer-dispatch.md`) |
| Worker default | `claude-haiku-5.5` (frontmatter + description); Main passes the model explicitly |
| Sonnet for a task | plan field `- **Model:** claude-sonnet-5.5 — <reason>`, an escalation after two Haiku failures, or your request; recorded in `implementation-state.md` |
| After a Sonnet failure | Main stops and asks you |

## State files (session folder)

| File | Owner | Content |
|------|-------|---------|
| `plan.md` → `# Plan` | `/1make-plan` | Title, Revision, Status, Repository, **Target branch**, Base ref, goal, scope, context (facts + sources), constraints, decisions, **engineering assessment**, `AC-n`, unresolved decisions, tasks `### T<n>: …` (`Depends on`, `Workspace`, `Owns`, `Reads`, `Acceptance`, `Method`, `Map`, `Tests`, `Implementation notes`, `Verify`, `Model`, `Review`, optional `IDE`; a legacy `TDD: exempt` reads as `mechanical`), external writes `W<n>`, execution graph, final verification, revision history |
| `plan.md` → `# Working Memory` | `sub-manager-docs` (via `/save`) | objective, facts, assumptions, rejected hypotheses, constraints, open questions, decisions (with trade-offs), risks, reasoning log |
| `implementation-state.md` | `/1implement` | phase, revision, target branch, setup/current head, IDE status, task table, running agents, external writes, verification/integration/review logs, escalations, event log |
| `files/plan-snapshot-r<N>.json` | setup Worker / Main | `plan-check` snapshot for drift detection |
| `files/plan-tasks-r<N>[-<k>].md` | `sub-planner-implementation` (output path given by Main) | `## Integration design` and `## Tasks`; corrections get a new `-<k>` path |
| `files/map-asis-r<N>[-<k>].md`, `files/map-target-r<N>[-<k>].md` | `sub-planner-implementation` (path of a new revision given by Main; corrections named by the planner) | Current-state and target maps; checked by `map-check.ps1`; corrections get a new `-<k>` path |
| `files/reports/` | every sub-agent that completes a request | one report per request, `<yyyyMMdd-HHmm>-<agent>-<slug>.md` ([Reports and NEEDS-INPUT](#reports-and-needs-input)) |

## Plan validation and change control

`session-state/scripts/workflow/plan-check.ps1` parses the plan; validates header, ACs, task fields (`Method` is required and must be `tdd`, `refactor`, `mechanical`, `git-ops` or `verify`), workspaces, dependencies (unknown/cycles) and ownership (including globs; unordered overlapping owners are errors); computes waves and per-task / per-AC hashes; and with `-Compare` reports drift (affected, downstream, added, removed tasks; changed ACs; scope changes). A plan without task headings returns a JSON error (`no tasks found`) and exit 1.

- `/1make-plan` validates through `sub-explorer-code`; setup writes the snapshot.
- Every Worker checks its task hash against the current plan before starting; the integrating Worker re-checks before each merge. Mismatch → `STALE`, nothing is changed.
- Main re-reads `plan.md` before every dispatch; on change or `STALE` it freezes, gets a drift report via `sub-explorer-code`, stops affected Workers, reclassifies tasks and resumes only after the new revision is valid and confirmed.

```powershell
pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\plan-check.ps1" -PlanPath <session>\plan.md [-SnapshotOut <file>] [-Compare <snapshot>] [-FailOnDrift]
pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\plan-check.Tests.ps1"   # 50 tests
```

## External writes

Only through write-capable Domain Experts (`sub-expert-ado-writer`), only if listed in the approved plan (`W<n>`) or explicitly approved by you. The writer requires an `AUTHORIZED WRITE` block, pre-reads the target, executes exactly the listed operations, re-reads to verify and returns IDs/URLs with before/after evidence. Read keepers stay read-only. The MCP gateway currently publishes only work-item write tools on `adops`; PR/wiki/GitHub writes are reported as `UNSUPPORTED`.

## Design notes

- **Single orchestrator, explicit phases:** one agent and one model across the lifecycle avoid hand-offs between sessions and keep the system prompt stable. Prompt-cache reuse is still not guaranteed (TTL, compaction, prompt changes) — measure it with the telemetry scripts.
- **Skills have `disable-model-invocation: true`:** only the user triggers phases. After compaction Main re-reads the skill files with `view`.
- **Main does not touch the shell by default:** routine git/build/test/merge work belongs to Workers, so Main's context stays clean and every change is made by an agent specialized for it.
- **Two Worker types:** IDE refactorings (Roslyn) are atomic and semantically correct but only work in the tree the IDE has open; parallel work needs separate worktrees without IDE access. Integration runs in the main tree so the IDE can validate merged code.
- **Haiku 5.5 cannot run as Main:** the static prompt (system prompt, skill list, tools) exceeds its usable context budget. It works for subagents.

## Workflow analysis

`util-workflow-analyst` is a separate, report-only agent. It reads the telemetry of past sessions and the current setup, and reports where the workflow loses time, tokens or reliability. It states findings with evidence and does not recommend changes. It writes only to `~\.copilot\reports\` (git-ignored), plus the derived `export.json` files beside `events.jsonl`. It never edits agents, skills, docs, scripts or configuration.

1. **Start it on its own**, not from `1main`: `copilot --agent util-workflow-analyst` (or `/agent util-workflow-analyst` in a running session). It is `disable-model-invocation`, so only you start it.
2. **Inputs.** Before it reads anything, it asks with `ask_user` for each input you did not give:
   - **Target**: the session(s) to analyse, or the whole setup.
   - **Window**: a date range (`--from` / `--to`, using the UTC session-start date).
   - **Comparison group**: `all`, `same cwd` (sessions in the target's working directory), or `both`.
   
   If `ask_user` is not available (headless run), it lists the missing inputs and stops. It does not guess a default.
3. **Work.** It refreshes `export.json` when it is missing, older than `events.jsonl`, or reported stale by `session-metrics.csx` (exit 2: the export lacks the `sourceEventCount` of `events.jsonl`; then it runs `export-events.csx` on each listed session and runs the metrics script again). It then runs `session-metrics.csx` and `setup-check.ps1`. It reads `session-store.db` read-only through `usql`, takes the cost fields (`costUsd`) from the metrics file and looks up no prices, queries the exports with `jq`, and reviews agents, skills and docs against `AGENTS.md` §13 and the known issues in §10.
4. **Outputs**, in `~\.copilot\reports\`:

| File | Content |
|------|---------|
| `workflow-analysis-<yyyyMMdd-HHmm>.md` | The report: executive summary (areas A–H, each **OK**, **Watch** or **Problem**), the numbers behind each area, and setup health (area E). Only real findings are listed. |
| `workflow-analysis-<yyyyMMdd-HHmm>.findings.json` | The findings (`key`, `area`, `severity`, evidence). Keys are stable, so a later run can show what is new. `/1diagnose` reads this file. |
| `workflow-analysis-<yyyyMMdd-HHmm>.html` | Dashboard from `render-dashboard.csx`. |
| `metrics-<yyyyMMdd-HHmm>.json` | Metrics input (schema v2, see [session-state/scripts/README.md](../session-state/scripts/README.md)). Its `costUsd` fields are the only cost source; no pricing file is written. |

5. **`/1diagnose`** (user-only) runs in the same analyst session. Usage: `/1diagnose [findings file] [finding keys]`. With no arguments it uses the latest `workflow-analysis-*.findings.json`. It writes `reports\diagnosis-<yyyyMMdd-HHmm>.md` with, for each finding: a cause hypothesis, the evidence, a confidence level, 2–3 options, and a priority (P1–P3) for each option. It changes nothing else.
6. **Hand-off.** The report and the diagnosis are inputs for planning, not instructions. Start a `1main` session (`copilot --agent 1main`), point it at the diagnosis file, and brainstorm there. When the decisions have converged, run `/1make-plan`, then `/1implement` as in [Quick start](#quick-start).

## Operational notes

- Interactive sessions ask once for path access to `~/.copilot/session-state/scripts` (plan-check). Headless runs (`-p`) need `--add-dir "$HOME\.copilot\session-state\scripts"`.
- ACP clients: skills work as slash commands, but the ACP host cannot dispatch custom agents (`Unsupported native sessions host effect 'custom_agent_prompt'`), so `/1implement` must run in the terminal CLI.
- Rider must have the repository's solution open for IDE refactorings (`Rider` origin in the MCP gateway). Without it, `sub-worker-main` falls back to text edits, and tasks marked `IDE: required` are blocked.
- Telemetry: `session.start.selectedModel` shows the settings default, not the agent's model; use `modelMetrics` (as `export-events.csx`, `session-metrics.csx` and `util-workflow-analyst` do). The analyst's report workflow is described in [Workflow analysis](#workflow-analysis).
- Agent and hook changes take effect only in a new CLI session: the CLI loads agent definitions and hook registrations at session start (AGENTS.md §10, item 13). A running session keeps the old hook registration.
- A temporary shim, `cli-tools/inject-cli.ps1`, forwards sessions that still run the old `cli-tools.json` registration to the new hook. It is removed after every CLI session has been restarted (AGENTS.md §3).
