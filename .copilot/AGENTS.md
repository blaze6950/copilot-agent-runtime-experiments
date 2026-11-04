# AGENTS.md — GitHub Copilot CLI setup in `~/.copilot`

Map of this repository: components, how they connect, what to leave alone.
Written 2026-10-18, updated 2026-10-22 for Copilot CLI 1.0.98 (Windows). Items marked *(unverified)* were not checked against a running session.
Workflow detail: [docs/agent-workflow.md](docs/agent-workflow.md) (linked, not repeated here).

## 1. Using this file
- Loaded automatically only when a session's working directory is `C:\Users\USER\.copilot` (§8). Elsewhere, read it with `view` first.
- The files are the source of truth. If this map disagrees with a file, the file wins; then fix this map.
- Never print secret values, tokens, URLs or headers from config files (§11).

## 2. Layout
| Path | Purpose | Written by |
|---|---|---|
| `settings.json` | Flags, model, disabled skills/subagents, status line, extension mode, `disableAllHooks` (§10) | user, `/settings` |
| `config.json` | CLI state (JSONC): trusted folders, login records, plugin records, tips. Personal data | CLI |
| `permissions-config.json` | Per-folder tool approvals | CLI |
| `mcp-config.json` | MCP server registry (server names only; values are not recorded here) | user |
| `mcp-secrets/` | Secret material. Do not read, print or copy. Only `index.json` is tracked (§10) | MCP tooling |
| `agents/*.agent.md` | Custom agents (§4) | user |
| `skills/<name>/SKILL.md` | Skill folders; only some are enabled (§5) | user |
| `hooks/env-context.json`, `hooks/subagent-context.json` | Hook registration (§3) | user |
| `env-context/` | `inject-env.ps1`, `env.json`; `inject.log` is git-ignored | user |
| `subagent-context/` | Sub-agent injection (§3): `inject.ps1` (the `subagentStart` entry script), `lib/` (`Common.ps1`, `Shared.ps1`, `Session.ps1`, `Tools.ps1`, `Conventions.ps1`), `shared-rules.md` (Reports, NEEDS-INPUT, Evidence, Secrets). `inject.log` is git-ignored | user |
| `cli-tools/` | Tool data only: `_shell.json` (shared shell rules) and one `<agent>.json` per subagent that needs tools (`CliTools`, `Rules`, `IncludeShell`). Tool-specific rules sit in each tool's `UseCase`. `inject-cli.ps1` is a TEMPORARY shim (§3, §10). Top-level-only agents (`disable-model-invocation: true`) are never injected, because the `subagentStart` hook fires only for subagents; so `1main` and `util-plugin-sync` have no JSON. `util-workflow-analyst.json` exists only as documentation of the analyst's tools and is never injected (the analyst repeats its CLI commands in its agent file). `inject.log` here is the old log from before the switch; the hook writes `subagent-context/inject.log` | user |
| `conventions/` | Convention packs `general.md` and `dotnet.md` (gold-standard rules; repository conventions override them) and `profiles.json` (code roles, pack markers, repository-instruction modes, size cap) (§8) | user |
| `tests/subagent-context/` | `inject.Tests.ps1` and its `fixtures/home` (§12) | user |
| `tests/hooks/live/` | `probe-instructions.ps1` (live probe that starts a headless CLI session and rewrites `RESULTS.md`) and `RESULTS.md` (§8) | user |
| `extensions/cache-keeper/` | Prompt-cache keeper and `main` status line (§7); `state/` and `logs/` are git-ignored | user |
| `extensions/turn-cost/` | Turn statistics in the timeline (§7c); `logs/` is git-ignored | user |
| `hook-ui/` | `HookUi.ps1` (`Format-HookMessage`), the UI rule helper of both hooks (§3) | user |
| `tests/env-context/` | `inject-env.Tests.ps1` | user |
| `extensions/shell-governor/` | Shell governor, loaded as user extension via `extension.mjs`; decides only when `enabled` in `config/governor.json` is not false (§7b). `logs/`, `reviews/`, `.local/` are git-ignored | user |
| `docs/agent-workflow.md` | Workflow design doc | user |
| `session-state/scripts/` | Telemetry scripts (`export-events.csx`, `analyze-events.csx`, `session-metrics.csx`, `render-dashboard.csx`, `lib/`, `tests/`) and `workflow/` (`plan-check.ps1`, `map-check.ps1`, `setup-check.ps1`, tests, fixtures) | user |
| `reports/` | Workflow-analysis output: `workflow-analysis-*.md`, `.findings.json`, `.html`, `diagnosis-*.md`, helper `metrics-*.json`. Created by the analyst on its first run; the folder does not exist yet. Git-ignored via `/reports/` (`.gitignore:9`) | analyst (§4), `/1diagnose` (§5) |
| `session-state/<session-id>/` | Per-session runtime: `events.jsonl`, `export.json`, `plan.md`, `workspace.yaml`, `files/`, `checkpoints/`, `research/`, `rewind-file-snapshots/`. Git-ignored. Do not edit | CLI and agents |
| `session-store.db` (+ `-wal`, `-shm`) | SQLite session index (§9). Git-ignored | CLI |
| `installed-plugins/` | `example-enterprise-plugins/devops-tools`: installed, disabled in `settings.json` (§10) | CLI |
| `logs/` | CLI process logs. Git-ignored | CLI |
| `intellij-skills/` | Contains `debug/`; purpose unknown. Untracked, not git-ignored | unknown |
| `ide/`, `jb/`, `restart/`, `plugin-data/`, `sidebar-sessions-state/`, `entra-broker-*/`, `mcp-oauth-config/` | CLI runtime and auth caches. Git-ignored | CLI |
| `servers/` | CLI runtime folder. No ignore rule matches it (`git check-ignore`); currently empty | CLI |
| `.gitignore` | Ignore rules, including `/reports/`. Does not cover `mcp-secrets/`, `config.json`, `permissions-config.json`, `mcp-config.json` | user |
| `AGENTS.md` | This map | user |
| `command-history-state.json`, `open-sessions-state.json` | CLI state. Git-ignored by exact name | CLI |
| `installed-plugins.lock`, `settings.json.lock` | Lock files. Git-ignored by exact name | CLI (unverified) |
| `mcp-config.json.bak` | Backup of `mcp-config.json`. Git-ignored by exact name; contents not opened | unknown |
| `vscode.session.metadata.cache.json` | IDE session metadata cache. Tracked by git (not ignored); contents not opened | IDE (unverified) |

## 3. Session start: hooks and injections
1. Instruction files become `<custom_instruction>` blocks in the system message (§8). This is not a hook.
2. **sessionStart**: `hooks/env-context.json` → `env-context/inject-env.ps1` (timeout 15 s). Skips subagents (`agentId`/`parentAgentId`) and `source: resume`. Emits `## Environment context`: `env.json` Facts, working directory, git root and branch, "Known directories" (from `env.json`), and a bounded tree (`git ls-files` inside a repo, directory walk otherwise). Log: `env-context/inject.log`. Writes one progress line at the end: `env context: N dirs, M entries, T ms` (`no tree` when skipped).
3. **subagentStart**: `hooks/subagent-context.json` → `subagent-context/inject.ps1` (timeout 15 s), for every subagent. It emits one `additionalContext`. Sections, in this order; each is built in its own try/catch, so a failing section is skipped and logged while the others are still emitted:
   1. **Shared rules** (every sub-agent): `subagent-context/shared-rules.md` (Reports, NEEDS-INPUT, Evidence, Secrets).
   2. **`## Session`** (every sub-agent): id, folder, events and `reports:` path. The hook creates the `files\reports` folder, because agents without a shell cannot.
   3. **CLI tools and rules**: `cli-tools/_shell.json` (unless `IncludeShell` is false) plus `cli-tools/<agentName>.json`, emitted as `## CLI tools (injected by hook for <agent>, N available)` and `### CLI rules`. No `<agent>.json` means no tool section.
   4. **Code roles only** (`conventions/profiles.json` → `codeRoles`): `## Conventions` (packs whose markers match the repository root) and `## Repository instructions` (see §8).

   Only an unreadable payload or an invalid agent name emits nothing. Always exits 0. Exactly one line per run goes to `subagent-context/inject.log` (git-ignored). Writes one progress line `Injecting <notes> for <agent>`. `COPILOT_HOME_OVERRIDE` replaces the copilot home folder for tests.
   `InjectSession` is obsolete and no longer set in `cli-tools/*.json`: the `## Session` block is emitted for every sub-agent, and `lib/Tools.ps1` does not read the key.
   Shim: `cli-tools/inject-cli.ps1` is a **TEMPORARY** compatibility shim. CLI sessions started before the switch still run the cached `hooks/cli-tools.json` registration, and the shim forwards them to `inject.ps1`. Delete it, and its `shim:` cases in `tests/subagent-context/inject.Tests.ps1`, once every CLI session has been restarted and the CLI process log shows no `hooks\cli-tools.json` entries.

4. `settings.json` sets `"disableAllHooks": true`, yet both hooks run (§10). No `preToolUse` or `postToolUse` hook file is defined; the governor's `preToolUse` hook is registered by its extension (§7b, §10).
5. **UI rule.** Our hooks and extensions write one line per event, never step-by-step progress. Colour is ANSI cyan around the text of one Markdown element (a line or a table cell), never around a whole Markdown block (it breaks the table). `NO_COLOR` (non-empty) turns colour off. Helpers: `hook-ui/HookUi.ps1` (`Format-HookMessage`) and `extensions/turn-cost/lib/color.mjs`.

## 4. Agents
Identifier = frontmatter `name`. The main orchestrator's identifier is `1main` (file `agents/1main.agent.md`). The prefix is the category. All `sub-*` agents have `user-invocable: false`.

| Category | Agents | Model | Role (frontmatter description) |
|---|---|---|---|
| Main | `1main` | claude-opus-5.5, effort high | Owns plan and final result. Tools: agent, read_agent, list_agents, write_agent, view, grep, glob, edit, create, powershell (only when no sub-agent fits; no per-command approval rule, the shell governor decides each call, §7b), ask_user, skill. `disable-model-invocation: true` |
| Workers `sub-worker-*` | `main` (main tree, IDE, one at a time), `wt` (own worktree, parallel), `docker`, `media` | haiku; sonnet only by escalation rule | Write within assigned scope; each plan task runs by its Method (`tdd`, `refactor`, `mechanical`, `git-ops`, `verify`) |
| Planner `sub-planner-*` | `implementation` (`sub-planner-implementation`) | claude-opus-5.5, effort high | Adapts Main's high-level plan to the code base during `/1make-plan` in two phases: it writes a current-state map (`files\map-asis-r<N>.md`, validated with `map-check.ps1`) and stops for your review; then it writes the target map and the task blocks to `files\plan-tasks-r<N>[-<k>].md`. Read-only on repositories; writes only the maps, that file and its report. `include-custom-instructions: true` |
| Experts `sub-expert-*` | ado, ado-writer, github, backstage, edm, docs, scalr, argocd-prod, argocd-nonprod, newrelic, miro, web, k8s-prod, k8s-nonprod, snow-prod, snow-nonprod, db, az, aws, hetzner, gws | haiku | Read-only. ado-writer writes only with `AUTHORIZED WRITE` |
| Explorers `sub-explorer-*` | `code`, `debug` | haiku | Read-only. `code` runs plan-check |
| Reviewer `sub-reviewer-code` | `code` | claude-sonnet-5.5, effort high | Staff-engineer review of a commit range, worktree or diff against the plan, the planner design, the target map and the ACs. Read-only; may run builds and tests. Verdict APPROVE, CHANGES_REQUIRED or BLOCKED. Template: `skills/1implement/references/reviewer-dispatch.md`. `include-custom-instructions: true` |
| Managers `sub-manager-*` | `docs` (sole writer of `# Working Memory`, via `/save`), `history` (read-only over all sessions) | haiku | `docs` writes only its session folder |
| Utilities | `util-workflow-analyst` (report-only; claude-sonnet-5.5; runs the telemetry scripts and reads their output; dispatches no sub-agent; tools include `ask_user`, `create` and `todo`), `util-plugin-sync` (haiku; updates devops-tools copies; skip-list at line 49), `yolo` (claude-opus-5.5; no `tools:` key; description is a sentence) | as stated | `disable-model-invocation: true` on all three |

- Top-level agents (`disable-model-invocation: true`) with the `powershell` tool carry a "Shell discipline" section: `1main`, `util-plugin-sync`, `util-workflow-analyst`. Sub-agents get the same rules by injection: `cli-tools/_shell.json` (rule `Shell discipline:`) and `subagent-context/shared-rules.md` (§3). Their agent files do not repeat them.
- **Name drift.** Session logs use older names: `1brainstorm` (the main orchestrator's earlier name), `main` (CLI 1.0.90), `sub-explorer`, `sub-worker`, `sub-researcher-ado/-github/-db`, `sub-debugger`, `sub-writer-ado`, `explore`. Attribute by `agentName`, and map names by date. <!-- setup-check: legacy-names=sub-researcher-ado,sub-debugger,sub-writer-ado -->

## 5. Skills
Enabled: `1implement`, `1make-plan`, `save`, `stop`, `1diagnose` (the five skills published in this repository), plus three local skills that are not published here. `settings.json` `disabledSkills` disables the other skill folders, plus `customize-cloud-agent`, which has no folder here.
- `1implement` (user-only): executes the approved plan.md (setup, Workers, integration, review, verification).
- `1make-plan` (user-only): turns agreed decisions into `# Plan` in plan.md, validated by plan-check.
- `save` (user-only): `/save`, persists session facts via sub-manager-docs.
- `stop` (user-only): `/stop`, cooperative stop with a checkpoint.
- `1diagnose` (user-only): `/1diagnose [findings file] [finding keys]`, turns workflow-analysis findings into causes, 2–3 options and P1–P3 priorities. Runs only in a `util-workflow-analyst` session; writes `reports/diagnosis-<yyyyMMdd-HHmm>.md` and changes nothing else. The CLI has its own built-in session-log diagnosis command under the old short name, so this skill is called `1diagnose`.
- C#/.NET conventions are no longer a skill. They are the `dotnet` convention pack (`conventions/dotnet.md`, §2 and §8).

Only the user-only skills listed above set `disable-model-invocation: true`. The rest are model-invocable.

## 6. Workflow (summary; details in docs/agent-workflow.md)
Start with `--agent 1main`. Phases: brainstorm → `/save` → `/1make-plan` (Main writes the high-level `# Plan`; `sub-planner-implementation` writes a current-state map that you review, then a target map and the task blocks; Main checks them; plan-check validates) → review plan.md → `/1implement` (Workers by Method, integration, reviewer compares the result with the target map, verification). State lives in the session folder: `plan.md` (`# Plan`, `# Working Memory`), `implementation-state.md`, `files/plan-snapshot-r<N>.json`, `files/plan-tasks-r<N>[-<k>].md` (planner output), `files/map-asis-r<N>[-<k>].md` and `files/map-target-r<N>[-<k>].md` (maps, checked by `map-check.ps1`) and `files/reports/` (sub-agent reports).
Workflow analysis is a separate, report-only path: `--agent util-workflow-analyst` → `/1diagnose` → a `1main` session for brainstorming (§4, §5, [docs/agent-workflow.md](docs/agent-workflow.md#workflow-analysis)).

## 7. cache-keeper extension
- Module map (`extensions/cache-keeper/`):
  - `extension.mjs`: wiring only (config, log, state file, `joinSession`, `createTransport`, `createKeeper`). Never writes to stdout.
  - `lib/contracts.mjs`: frozen enums (`ACTION`, `REFRESH_KIND`, `TRANSPORT_TIMEOUT`) and JSDoc typedefs. No imports.
  - `lib/config.mjs`: `DEFAULTS`, `mergeConfig` (merges and validates `ladder` and `statusLine`, collects `problems`), `normalizeLadder`, `normalizeStatusLine`, `configPathFrom`, `readUserConfig` (reads and parses the user config with an injected reader; used by `extension.mjs` and `statusline.mjs`), `realClock`.
  - `lib/commands.mjs`: pure helpers for slash command lines (`commandToken`, `commandName`). One rule, used by tracker, keeper and unblock.
  - `lib/tracker.mjs`: pure event → state (also `isMiss`, the hit/miss rule).
  - `lib/policy.mjs`: pure decision table `decide` and `deadline`, the ladder steps `ladderStep` and `planNext`. The header lists the ten rows in order.
  - `lib/transport.mjs`: the only lib module that calls the SDK session. Every call has a 5 s timeout and a safe fallback. Error and timeout lines are logged at most once per 60 s. (`extension.mjs` only joins the session and subscribes to its events.)
  - `lib/unblock.mjs`: the ladder commands the keeper queued itself: tracking, reconciling an unclear enqueue, unblocking a held-back command.
  - `lib/rescue.mjs`: picks and promotes the task that blocks a root turn in a long sync tool (`pickRootTask`, `createRescue`).
  - `lib/keeper.mjs`: one deadline timer, snapshot of the session, serialized fires, action dispatch, state file.
  - `lib/statusline-render.mjs`: pure render and colours.
  - `statusline.mjs`: thin CLI entry (`lineFor`): reads the state file and the config on every run, so `statusLine.countdown` applies at the next refresh. `config.json`: settings.
  - `tests/*.test.mjs`: 369 tests (config, keeper, layout, policy, statusline, tracker, transport). Fakes are in `tests/helpers/fakes.mjs`.
- Enabled by `settings.json`: `enabledFeatureFlags.EXTENSIONS: true`, `extensions.mode: "load_only"`, `statusLine` → `statusline.mjs` with `refreshInterval: 5`.
- Purpose: keep the root agent's prompt cache (5-minute TTL, measured from request start) alive during user absence and background waits.
- Deadline-driven:
  - The keeper keeps one timer at `marginSec` (30 s) before the cache expires. While a root tool runs, it uses `rescue.marginSec` (45 s) instead.
  - When the timer fires, the keeper reads the session (model processing, running tasks, queue, current agent). Then `decide()` applies the first row that matches:
    1. `expired`: cache already gone and none of our commands is held back → nothing;
    2. `rootToolInFlight`: a root tool blocks the turn → rescue (promote it to background), or nothing when `rescue.enabled` is false;
    3. `modelBusy`: model processing → nothing (a held own command is re-checked, see Unblock);
    4. `processingUnknown`: processing state unknown and no `assistant.idle` since the last request → nothing;
    5. `queueUnknown`: queue cannot be read → nothing;
    6. `ownCommandPending`: a command the keeper queued is still pending → unblock, even after the cache has expired (the keep-alive that follows re-warms it);
    7. `foreignInputPending`: your input is queued → nothing;
    8. `tasksUnknown`: task list cannot be read → nothing;
    9. `backgroundTasks`: a background task runs → wait keep-alive, up to `wait.maxRefreshes` (50), then nothing;
    10. `ladder`: keep-alives up to `ladder.keepalives`, then the next action whose conditions hold, then nothing (see the Ladder bullet).
  - If the model, queue or task state cannot be read, the keeper does nothing and checks again 10 s later. The exact row order is in the header of `lib/policy.mjs`.
  - Why: live tests on CLI 1.0.98 showed that a keeper-queued `/save` blocks the queue and suppresses `assistant.idle` while background work runs. The old keeper acted only after `assistant.idle`, so it stayed silent for hours. Normal keep-alive prompts run at once, even during background work.
- Ladder: the keeper sends `ladder.keepalives` keep-alives first (Main replies `ok`, no tools). Then it runs the actions of `ladder.actions` in JSON order, at most one per deadline. An action whose conditions fail at a deadline is passed over for that deadline. If a later action runs, the passed-over action is not checked again in this idle period; if nothing runs, it is checked again at the next deadline. Nothing is sent after the last action unless a background task runs (then wait keep-alives, row 9), and when no task runs the status line shows `ladder done, waiting for you` and forecasts no next step. An empty `ladder.actions` list means keep-alives only. A command action is queued only when the model is not processing and the queue holds no input (rows 3 and 7); it is skipped while a background task runs (idle sub-agents do not count).
- Action fields: `id` (letters, digits, `_` or `-`; unique). Exactly one of `command` (starts with `/`; queued in the command queue) or `text` (sent as a prompt, not queued). `when.changedSinceLastRun` (default `false`): when `true`, the action runs only if you wrote a message since it last ran. Your message sets the flag again, except a command you type yourself, which sets it to `false` for that command. The flag is cleared when the action runs and when the CLI runs the skill of its command. `when.agents`: a non-empty list of agent names (default: any agent). `when.minContextTokens` (default 0). `ifRemoved` (`retry` or `skip`, default `skip`): when a queued command is removed before it ran, `retry` runs it again at the next deadline, once per idle period; `skip` counts it as done. Invalid values are replaced by their defaults, or the entry is dropped; each one is listed in a `config-warning` line when the extension starts. The old keys `maxRefreshes`, `save` and `compact` are ignored, with one `config-warning` line.
- Unblock: if a ladder command that the keeper queued is still pending at the re-check about 10 s after queueing (or at any later deadline), the keeper removes it from the queue (`queue.removeAt`). While one of its commands is held back, the keeper re-checks every 10 s, even after the cache expired (unclamped, no limit on the number of checks), but not while Main's root tool runs; once the tool has finished it re-checks again. An enqueue whose outcome is not known yet (for example after a timeout) is re-checked every 10 s for as long as its outcome is unknown, also during a root tool and after expiry; the rescue still runs at its deadline. After 5 failed removals in a row it backs off to every 60 s and keeps trying until `queue.removeAt` works. It does not repeat a rescue every 10 s: after a rescue decision the tool events re-arm the deadline, and when the cache has already expired, a held own command is re-checked once the tool has finished. A held item that is not the keeper's own (id reused, other kind or name) is never removed: it gets one keep-alive and is not tracked further. It removes only items it queued itself: matched by id, kind `command` and command name. Then it runs the first waiting user message (`queue.sendNow`), or sends a keep-alive. A removed action follows its `ifRemoved` rule.
- Timeouts: after an enqueue that got no answer, the keeper reads the queue and adopts its own command if it is there. (A definite rejection never adopts anything: the action is given back.) A keep-alive that gets no answer is not sent again; the keeper re-decides 10 s later. Retries stop at `expiresAt − marginSec/3` (10 s before expiry with the default 30 s margin).
- Known trade-off (user decision): if an enqueue takes more than 5 s and you type the same command in the same ~20 s window, the keeper may remove your command. The action then follows its `ifRemoved` rule.
- Before the first model request of a session (for example right after resume), the keeper does not guess a cache expiry. It sends nothing until the first request.
- Status line: label `main`. It shows in every view, also in the full-screen sub-agent view, because the CLI gives no view information. It shows clock times (local time, `HH:MM:SS`), for example `main cache until 17:31:45 | next keepalive 17:31:15 (2/12)` and `next /save 17:41:15 (11/12)`. The counter `(n/m)` counts the keep-alives and the actions of the ladder; wait mode shows `(wait n/m)`. `(refreshing)` is shown after `cache until` while a request is in flight (the expiry is estimated from the request start). `ladder done, waiting for you` is shown when the ladder is exhausted and no background task runs (while a task runs after the ladder, the forecast is the wait keep-alive `next keepalive … (wait n/m)` instead), and `busy in powershell, rescue 17:30:00` while Main waits in a sync tool. With a background task running and nothing left to send, the line says `wait budget used, no more keep-alives` (wait keep-alives used up) or `wait keep-alives off, no more keep-alives` (`wait.enabled` false and the ladder done). When the cache has expired, it shows `!! main cache expired !!` in red. The whole line is green for 6 s after a keeper refresh (keep-alive, wait keep-alive, save, unblock); a keep-alive or wait keep-alive also shows its price there. When the saving is known, the saving is the main value and the ping cost is in parentheses, for example `keepalive #3 saved $2.39 ($0.12)`. Otherwise only the ping cost is shown, for example `keepalive #3 $0.12` (`wait keepalive #N …` in wait mode). The ping cost is `copilotUsage.totalNanoAiu / 1e11` of the first root request after the ping; when the CLI gives no cost, no price is shown. The saving is gross: for that request, its cache-read tokens times the cache-write rate minus the cache-read rate, both from `copilotUsage.tokenDetails` (`cache_write_1h` when the cache TTL is 1 hour). The ping cost is not subtracted. Without `tokenDetails`, or without one of the two rates, there is no saving and only the ping cost is shown. A cache miss shows the ping cost and no saving. An auxiliary request with fewer than `miss.minContextTokens` (20,000) cache-read tokens is not credited, so the ping stays pending until its own request arrives. `NO_COLOR` turns colours off. `refreshInterval` is 5 s: on Windows the CLI starts cmd and node on every refresh (about 100 ms), so 5 s cuts this by 5×. A repo-level `.github/copilot/settings.json` `statusLine` is ignored by the CLI; set it in the user `settings.json`. A running CLI needs a new window to pick up settings changes.
- Countdown: `statusLine.countdown` in `extensions/cache-keeper/config.json` (default `false`; shipped as `false`) adds the remaining time in brackets after each clock time, for example `main cache until 18:35:47 (4:12) | next keepalive 18:35:17 (3:42) (2/12)`. The remaining time is `m:ss`, or `h:mm:ss` from one hour. `statusline.mjs` reads the config on every refresh, so a change applies at the next refresh without a restart. An invalid value makes the extension log one `config-warning` line when it starts; the status line then uses `false` and logs nothing. A missing or unreadable config shows no countdown. Pairing: the refresh rate is `statusLine.refreshInterval` in the CLI's user `settings.json` (read when a window starts; the cache-keeper does not change it). With `refreshInterval` 5 the countdown moves in 5 s steps. With `refreshInterval: 1` it moves every second; one refresh costs about 95 ms CPU, about 1 % of the machine per open window (measured on this machine, 2026-10-23).
- The `[keepalive]` text and the "moved to background by the user" rescue wording are unchanged (`1main.agent.md` relies on them).
- Config: `marginSec` 30, `fallbackTtlSec` 300, `ladder.keepalives` 10, `ladder.actions` `save` (`/save`, `when.changedSinceLastRun` true, `when.agents` `["1main"]`, `ifRemoved` `retry`) and `compact` (`/compact`, `when.minContextTokens` 150000, `ifRemoved` `skip`), `statusLine.countdown` false, `rescue.marginSec` 45, `wait.maxRefreshes` 50. No `miss` section, so defaults apply.
- Env: `COPILOT_CACHE_KEEPER=off` disables (the value is trimmed and case-insensitive, so `OFF` and ` off ` count); `COPILOT_CACHE_KEEPER_CONFIG=<file>` overrides the config path for the extension and the status line. Both unset.
- Output: `extensions/cache-keeper/logs/<date>.log`; `state/<session>.json` (read by `statusline.mjs`, ignored after 24 h).
- Not covered: sub-agents' own caches are not kept warm (postponed by decision).
- Test: `node --test "extensions/cache-keeper/tests/*.test.mjs"` (run from `C:\Users\USER\.copilot`). On Node 24 a directory argument does not work, so use the glob.

## 7b. Shell governor
- Location: `extensions/shell-governor/`. `extension.mjs` (one line: `import "./main.mjs";`) is loaded by the CLI as a user extension in every session; whether the governor decides anything depends on `"enabled"` in `config/governor.json` (read the file for the current value; `false` returns no decision). Changing `"enabled"` applies within ~2 s, no restart. The switch applies to every open CLI session at once, because all sessions read the same `config/governor.json`. It stays as set until you change it again by hand. Full removal: delete `extension.mjs` (takes effect in the next session). Test-only environment variables (never set in a real session): `SHELL_GOVERNOR_STATE_DIR` (folder for `logs/` and `reviews/`) and `SHELL_GOVERNOR_CONFIG_ROOT` (folder that contains `config/governor.json` and `config/agents.json`); `tests/shell-governor/main.test.mjs` uses them so the suite does not depend on the shipped `enabled` value.
- Guard: `tests/shell-governor/layout.test.mjs` (`Layout_EntryFile_OnlyImportsMain`) fails unless `extension.mjs` exists with only the import of `./main.mjs`, and no `extension.cjs`/`extension.js` exists.
- Module map (`lib/`, one line each):
  - `contracts.mjs`: frozen verdicts (SAFE, AI, ASK, SYNTAX) and JSDoc typedefs
  - `config.mjs`: config store; reloads on mtime or size change, keeps the last valid version, merges agent overrides. The governor and the engine each keep a 1 s snapshot, so a config change reaches a call within about 2 seconds
  - `pwsh-client.mjs`: Node client of `pwsh/worker.ps1` (lazy start, idle shutdown; one restart per crash sequence, the counter resets after a successful request)
  - `sql.mjs`: SQL classifier for snow, usql and sqlite3 text
  - `catalog.mjs`: tool catalog from `config/catalog/`; classifies native, cmdlet, .NET and official-CLI facts
  - `paths.mjs`: directory-rule globs, repo-root lookup, path verdicts (PowerShell wildcards are expanded on disk, bounded; over the bound: AI for reads, ASK otherwise). Links can only add restrictions: normal rules match only their written pattern; protected and secret rules also match through resolved links. `secretBasesReached` lists every secret rule a path reaches (`reachesSecretBase` returns the first).
  - `read-tools.mjs`: deterministic decision for `view`, `grep` and `glob` (directory rules with read intent on every target; AI path verdicts become ASK; never the judge); shared by the live hook and the replay; a `grep` whose search root contains a secret rule base asks (`READ-SECRET-ROOT-SEARCH`)
  - `session-context.mjs`: session events and script freshness (fresh, pre-existing, missing) and the caller of a call (`callerOf`: name, type, own description and the task name/description of its `task` dispatch, linked by `toolCallId`)
  - `engine.mjs`: rule engine; worker facts to SYNTAX, ASK, AI or SAFE, with rule ids; `directoryPolicyFor` returns one agent's compiled directory rules for a call, cached per config snapshot (shared by file tools, read tools and the replay)
  - `judge.mjs`: AI judge, one `copilot --acp` process; every failure becomes ASK
  - `judge-prompt.mjs`: judge prompt builder and script normalisation; `judgeRequestOf` (one request shape for the live hook and the replay)
  - `policy.mjs`: Stage-3 thresholds and the two optional relaxations (`stage3Assessment`, `readOnlyCall`, `callEvidenceOf`); `stage3Triggers` lists the ratings that still ask; combines the rule verdict (with its engine facts and rule ids) with the judge outcome
  - `dialog.mjs`: approval dialog (elicitation) and review file; fail-closed
  - `audit.mjs`: whitelisted audit lines; the script is stored as SHA-256 only
  - `governor.mjs`: orchestration of one preToolUse call into a decision
  - Outside `lib/`: `pwsh/worker.ps1` (persistent PowerShell AST facts worker, JSON lines), `tools/replay.mjs` (standalone replay, not loaded by the CLI), `main.mjs` (SDK wiring via `joinSession`; the only module that imports the SDK)
- Config (`config/`):
  - `governor.json`: `enabled` (false returns no decision), judge model and limits, Stage-3 thresholds, optional `dialog.scriptLines` (show N script lines with a note that the full script is in the review file; absent or 0 = full script; not set in the shipped file), optional `dialog.maxLineChars` (cut each shown script line to N characters; absent or 0 = full lines; not set in the shipped file), worker settings, `codeRoots`
  - `directories.json`: directory rules (levels normal, protected, secret; exceptions). Three normal work areas allow read and write without a dialog: `session-state-plan` (`{copilotHome}\session-state\{sessionId}\plan.md`), `session-state-impl` (`{copilotHome}\session-state\{sessionId}\implementation-state.md`) and `reports` (`{copilotHome}\reports\**`). They open the copilot-home protected rule for read and write only. The two session rules cover only the current session's files; `reports` covers the whole folder. Delete and execute there still ask.
  - `agents.json`: per-agent overrides only; may tighten a rule, never loosen a protected or secret one. Per-tool access is read at runtime from `{copilotHome}\cli-tools`. Overrides exist for 26 agents: all 21 `sub-expert-*` (including `ado-writer`), both explorers, `sub-manager-history`, the planner and the reviewer. Each sets `repo` to `read` and `execute` and the `session-state-plan` and `session-state-impl` rules to `read`. Writing agents (`sub-worker-*`, `sub-manager-docs`) have no entry. An agent without an entry gets the base rules. Report files stay writable through the `session-files` rule (`config/directories.json`). The override test is `tests/shell-governor/agent-overrides.test.mjs`.
  - `catalog/*.json`: one tool spec per file, plus `pwsh-core.json` (cmdlet, .NET and cmd tables)
  - Placeholders: `{home}`, `{temp}`, `{appdata}`, `{localappdata}`, `{copilotHome}` (config store); `{sessionId}` (per session in `paths.mjs`; no valid session id means the rule never matches)
  - Git-ignored runtime folders: `logs/` (audit and governor logs), `reviews/` (dialog review files), `.local/` (replay output). Never commit them. The judge's home and sandbox live outside the repo, under `%TEMP%\shell-governor-judge`.
- Decision pipeline per `powershell` call:
  1. Syntax error: deny (the only automatic deny).
  2. Deterministic rules give SAFE, AI or ASK. `edit`, `create` and `apply_patch` get directory policy on their write targets. Recursive reads are AI only when the root is equal to, inside or an ancestor of a secret rule's concrete base, or a content reader bypasses ignore rules (`rg -uu`, `grep -r`, `Select-String -Recurse`); name-only listings are SAFE. Residual risk: anywhere-globs without a concrete base (`**\*.pem`, `**\.env`) are not considered. Text/object producers piped into `Select-String` are SAFE; producers that can emit FileInfo or paths stay AI (DYN-PATH-READ). An `edit` or `create` call with neither `path` nor `file_path` gets no decision (no audit line is written), unless another argument key looks like a path; then it asks. The CLI rejects such a call itself. Other unreadable argument shapes still ask.
  3. AI: ACP judge (model `gpt-6-luna`) → Stage-3. ASK when a hard rating is ≥ 1, another rating is ≥ 2, or confidence is < 0.7; otherwise ALLOW. Two optional relaxations in `config/governor.json` `stage3` (absent = the strict rule above): `taskMismatchAloneAsksAt` (3: `task_mismatch` asks only at 3 when every other rating is 0; with any other rating ≥ 1 it asks at 2) and `credentialAccessReadOnlyAllowed` (true: `credential_access = 1` as the only rating trigger is allowed only when the engine facts are read-only — every class `read` or `read-remote`, every intent `read`, no note `dynamic-command`, `nested-dynamic`, `download-exec`, `sql-unresolved`, `syntax:*` or `dynamic-path:*` — and every engine rule id on the call is in `READ_ONLY_RULES` (`READ`, `READ-REMOTE`, `D-OFFICIAL-READ`, `READ-ANYWHERE`, `DIR-OK`, `DIR-PROTECTED-READ`); any other id asks: recursive reads, dynamic invocation, unresolved or unchecked paths (UNC, registry, 8.3/real location, unbounded wildcard (`DIR-WILDCARD-UNBOUNDED`)), cost, auth, unknown, and ids added later; missing facts or rule ids ask). All other Stage-3 rules (other hard ratings at 1, other ratings at 2, confidence < 0.7, unreadable ratings) are unchanged. A rule ASK is never lowered. The judge also gets the sub-agent's task name and task description from Main's `task` dispatch (trusted), and the call's `description` as an unverified claim by the agent. That claim may support the task-fit judgement only and never lowers a hard rating. The judge answers with two sentences (what the script does, worst realistic consequence) plus the ratings; the cache key includes the task and the purpose.
  4. ASK: the governor's own approval dialog; on hosts without elicitation, a hook ask.
  5. Any internal error: ask. `enabled: false`: no decision.
- Read tools (`view`, `grep`, `glob`; `lib/read-tools.mjs`): every target path gets the directory verdict with read intent (`view`: `path`; `grep`/`glob`: `paths` as a string or a list, or `path`; without them the working directory). A secret path, a target that is not a constant local path (`READ-TARGET-UNRESOLVED`), an unreadable argument shape (`READ-ARGS-UNRECOGNISED`) or a read verdict that would be AI asks in the dialog; everything else is allowed. The AI judge is never called; every decision writes an audit line. The `glob` pattern and the `grep` `glob` filter are not checked as paths (they select names). A `grep` whose search root (a `paths`/`path` target or the working directory) contains a secret rule base asks (`READ-SECRET-ROOT-SEARCH`; the explanation names the reached secret rule ids such as `secret-mcp` (or `DIR-REALPATH-UNRESOLVED` when a root's real location is unknown), never file paths); a `glob` with such a root stays allowed because it lists names only; a target that is itself secret keeps `DIR-SECRET`. Known limit: a path that contains `$` or `%` asks (`READ-TARGET-UNRESOLVED`), because the path resolver treats them as variables, although tool arguments are literal.
- Approval dialog (`lib/dialog.mjs`), shown for every ASK:
  - Purpose line: `Purpose stated by the agent (unverified): …`, taken from the call's `description` (300 characters at most; `none given` when the call has none). It is shown in the dialog and the review file, and sent to the AI judge as an unverified claim (task fit only).
  - Layout: `Agent: <agent> — "<task name>"` (task part only when known), `Agent file:` link to `agents/<agent>.agent.md` when it exists, working folder, tool, the purpose line, the judge's two sentences, rule ids, the review-file link and the script (all lines; with `scriptLines` N the first N lines and `[cut at N lines, full script in the review file]`). Agent type, task description, rule explanations, ratings, extracted facts and the agent's own description are only in the review file. `dialog.maxLineChars` N cuts each shown script line to exactly N characters. A note `[long lines cut at N characters, full script in the review file]` follows the script only when a line was cut. Absent or 0 = full lines. The review file always has the full script.
  - There is no arming time: an answer counts at once.
  - Answers: "Approve once" allows the call; "Decline" denies it. Any other non-empty text typed in "Other" is Decline with guidance: the call is denied, and the trimmed text (500 characters at most) goes back to the agent as `declined by user: <text>`. Typed text is never an approval, unless it is exactly `approve_once`.
  - Exact option values (`approve_once`, `decline`, `not_decided`) act as options; they are case-sensitive. "— not decided —", an empty answer or a cancel shows the dialog again.
  - The form has one field, `decision`.
- Tests (run from `C:\Users\USER\.copilot`; on Node 24 a directory argument does not work, so use the glob):
  - Full suite: `node --test "tests/shell-governor/**/*.test.mjs"`
  - One file: `node --test tests/shell-governor/engine.test.mjs`
  - One test: `node --test --test-name-pattern "Layout_NoEntryFile_ExtensionNotActivated" tests/shell-governor/layout.test.mjs`
  - Replay: `node extensions/shell-governor/tools/replay.mjs --summary [--exclude-cwd <path>]... [--copilot-home <dir>] [--since <ISO date>] [--until <ISO date>] [--session <id prefix>]... [--judge] [--out <dir>]` (sessions are filtered by their `session.start` time). `--exclude-cwd` adds a folder to `replay.excludeCwds` in `config/governor.json`; sessions whose working directory is inside it are not replayed. `--copilot-home` replaces the default `<home>\.copilot` as the folder that holds `session-state`. Reads `{copilotHome}\session-state\*\events.jsonl` read-only; writes only to the git-ignored `extensions/shell-governor/.local/replay/`, or to the `--out` folder when it is set. Replays `powershell` through the engine and `view`/`grep`/`glob` through the live read-tool decision; counts per tool, verdict and rule id, and the `grep`/`glob` calls whose root contains a secret rule base (the `grep` ones also count under `READ-SECRET-ROOT-SEARCH`). `--judge` (off by default) re-runs the AI judge with the live inputs for AI-verdict calls and reports ALLOW/ASK and their triggers, and how many ALLOWs came from each relaxation (`relaxed to ALLOW`); it costs model calls (about $0.3 per large session).
  - Live harness: `pwsh -NoProfile -File tests/shell-governor/live/run-live.ps1 -Cases auto [-ScratchRoot <trusted folder>] [-KeepScratch]`. It starts real copilot sessions in a scratch project and removes the scratch root at the end (results are copied first to `%TEMP%\shell-governor-live-results\<timestamp>\`). With the default scratch root, every case is BLOCKED until the folder is trusted; see `tests/shell-governor/live/ATTENDED.md` §0. Cases that need a person are in `ATTENDED.md` §1–4 and are never started by `auto`.

## 7c. turn-cost extension
- Location: `extensions/turn-cost/`. It adds turn statistics to the timeline: one cyan info line per finished turn and per finished sub-agent, written with `session.log`. Nothing is sent to the model.
- Module map (`extensions/turn-cost/`):
  - `extension.mjs`: the only SDK import (`joinSession`). It creates the file log and the metric reader, then calls `start()` in `wiring.mjs`. Never writes to stdout.
  - `wiring.mjs`: start logic with no SDK import and no file access, so tests run it with fakes. It joins the session first. Then it subscribes the reporter, unless `COPILOT_TURN_COST=off` is set; in that case it writes one line to the extension's log and subscribes to nothing.
  - `lib/contracts.mjs`: frozen enums, default metrics and constants. No imports.
  - `lib/config.mjs`: strict reading and validation of `config.json` (`metrics`).
  - `lib/accounting.mjs`: pure state machine. It turns session events into turn blocks and agent blocks.
  - `lib/intervals.mjs`: time windows (union, and time outside other windows).
  - `lib/format.mjs`: humanized numbers, times and costs.
  - `lib/color.mjs`: cyan colour and the `NO_COLOR` rule.
  - `lib/render.mjs`: blocks to text (one line, or a header and a Markdown table).
  - `lib/reporter.mjs`: events to accounting to render to one line per block, in order. It reads the metric config before each block.
  - `lib/transport.mjs`: the only module that calls `session.log`. Every call has a 5 s timeout.
- Turns:
  - A real turn starts with a root `user.message`, or with a root `assistant.turn_start` after an agent notice. It ends at the root `session.idle`. Agent-notice turns are real turns.
  - A keep-alive turn (a prompt that starts with `[keepalive]`) gives no block. Its cost stays in the session total. The next turn header shows `keep-alive N× $x since last turn`.
  - A sub-agent gets its own block only when it is still running at its turn's block. It is written when it finishes, after that turn's block.
  - The session total counts from the start of the extension. A CLI restart resets it.
- Time split per agent (each second is counted once): `wait` is time in permission, elicitation and user-input dialogs; `gov` is time in the `preToolUse` hook (shell governor); `tools` is tool time outside `wait` and `gov`; `llm` is model time; `other` is the rest of the wall time, never below 0. Priority: `wait`, then `gov`, then `tools`.
- Output:
  - A simple turn is one line: no sub-agent, and a cost of at most $0.50.
  - Any other turn is a header line, a blank line and a Markdown table with a `total` row. Each non-empty cell is wrapped in cyan on its own. Colour around a whole Markdown block breaks the table.
  - A sub-agent that finishes after its turn's block gets one line.
  - `agent` is always shown. A metric column whose values are all 0 is hidden.
  - Example, simple turn (colour codes omitted):
    ```text
    turn 3 · 2m14s · $0.12 · session $0.84 · claude-opus-5.5 · 3 req · 46.6M/210k tok · cache 86% · llm 1m30s · tools 20s · other 4s
    ```
  - Example, turn with a sub-agent (colour codes omitted):
    ```text
    turn 3 · 2m14s · $0.53 · session $0.84 · agent time 1m38s

    | agent | task | model | status | req | cost | tokens | cache | wall | llm | tools | other |
    |---|---|---|---|---|---|---|---|---|---|---|---|
    | main |  | claude-opus-5.5 | done | 3 | $0.12 | 46.6M/210k | 86% | 2m14s | 1m30s | 20s | 4s |
    | worker-main | T4 render | gpt-5 | done | 2 | $0.41 | 1.2M/30k | 50% | 1m02s | 50s | 9s | 1s |
    | total |  |  |  | 5 | $0.53 | 47.8M/240k | 85% | 2m14s | 2m20s | 29s | 5s |
    ```
- Config: `extensions/turn-cost/config.json`, key `metrics`: `task`, `model`, `status`, `req`, `cost`, `tokens`, `cache`, `wall`, `llm`, `ttft`, `tools`, `gov`, `wait`, `other`, each `true` or `false`. Defaults: all `true` except `ttft`, which is `false`. `agent` cannot be switched off.
  - The file is read before every block, so a change applies to the next block without a restart.
  - A bad value uses its default. An unknown key is ignored.
  - Each distinct set of problems is logged once per run as a warning `turn-cost config: …`.
  - A missing file means the defaults. A file that cannot be read or parsed means the defaults, plus one warning.
- Output channel: lines go through `session.log` (level `info`; config warnings use `warning`). The CLI stores them as `session.info` events, which do not reach the model context (probe evidence; see the AC-8 check).
- Log: `extensions/turn-cost/logs/<date>.log` (git-ignored).
- Test: `node --test "extensions/turn-cost/tests/*.test.mjs"` (run from `C:\Users\USER\.copilot`; on Node 24 use the glob).
- Kill switch: `COPILOT_TURN_COST=off` switches the extension off. The value is trimmed and case-insensitive (`OFF` and ` off ` count); other values leave it on. The extension reads it at start; it still joins the session (so the CLI does not wait for it at start), logs one line to its own log and subscribes to no session event, so nothing reaches the timeline (§10 item 14).
- Headers: a turn header always shows the turn number, wall time, cost and session total, whatever the metric switches. Turn numbers are kept in memory, like the session total, so both start again on resume *(observed: each resume starts a new extension process)*.
- Headless `-p` runs: about half lost the last turn's block in the observed probes. Observed exit race: the root `session.idle` is handled and the process exits during the block write, so a `block <label> writing` line has no `written` line after it. In `extensions/turn-cost/logs/2026-10-23.log` there are 16 `writing` lines and 5 `written` lines. That log does not separate headless from interactive runs, so whether interactive use is affected is not established.
- Logs: the reporter logs `block <label> writing` before each write and `block <label> $<cost> written` or `not-written` after it. Failures are logged as `write-error`, `warning-error` or `event-error`.

## 8. Instructions: what loads where
- Recognized files (CLI help text): repo: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `.claude/rules/**/*.md`. User: `$HOME/.copilot/copilot-instructions.md`, `$HOME/.copilot/instructions/**/*.instructions.md`. Extra dirs: env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`.
- Scope: cwd and git root *(verified for cwd = git root)*. Intermediate directories *(unverified)*.
- `~/.copilot` is a git repo, so with cwd = `~/.copilot` its root `AGENTS.md` loads *(inferred)*.
- Multiple files are combined into one system message. Verified order: `.github/copilot-instructions.md`, then `AGENTS.md`.
- Changing cwd (`/cd`) rebuilds the injected block *(verified)*.
- Nested files load on demand when a file in their subtree is viewed *(verified)*.
- Limits: entry, per-file and total byte limits exist; files are skipped, not truncated. Numbers *(unverified)*. `@path` imports are limited to an allowed root *(unverified details)*.
- Custom agents: a top-level custom agent receives the blocks *(verified)*.
- Sub-agents with the opt-in key `include-custom-instructions: true` (frontmatter) receive the repository's `AGENTS.md`, `.github/copilot-instructions.md` and `.github/instructions/**/*.instructions.md` natively. Verified by the live probe (`tests/hooks/live/probe-instructions.ps1`, results in `tests/hooks/live/RESULTS.md`, CLI 1.0.98, 2026-10-22, run in a scratch git repository). The key is set on `sub-worker-main`, `sub-worker-wt`, `sub-planner-implementation` and `sub-reviewer-code`. Other sub-agents do not have the key and get no repository instructions *(inferred: they lack the key; not probed)*.
- Convention packs: `conventions/profiles.json` lists the code roles (`sub-planner-implementation`, `sub-worker-main`, `sub-worker-wt`, `sub-reviewer-code`). For them the hook injects the packs `general` (always) and `dotnet` (only when the repository root has `*.sln`, `*.slnx` or `*.csproj`) as `## Conventions`. Both packs say that repository conventions override them.
- The repository-instruction mode in `profiles.json` is `native` for both groups, so the hook injects no repository-instruction text; the CLI delivers it (above). The hook injects those files only if a mode is switched to `inject`; then `maxBytes` (32768) caps the injected text and the rest is listed by path.
- Consequence: this file reaches sessions whose cwd is `~/.copilot` (or a subfolder with that git root). Code-role sub-agents receive the instruction files of the repository they run in. Other sub-agents read this file explicitly *(inferred)*.

## 9. Data sources
- `session-state/<id>/events.jsonl`: one JSON object per line with `type`, `data`, `id`, `parentId`, `timestamp`. Subagent events carry a top-level `agentId`. `session.start.data.context` has `cwd` and `gitRoot`. `system.message` holds system prompts and has no `agentId`, so subagent prompts are not logged.
- `session-state/<id>/export.json` (from `export-events.csx`), top-level keys: codeChanges, compactionEvents, conversationTokens, copilotVersion, currentModel, currentTokens, cwd, durationMs, errorCount, errors, eventTypeCounts, graphStats, hookPairs, modelChanges, modelMetrics, requests, hookWindows, costUsd, compactionCostUsd, sourceEventCount, segmentCount, segments, sessionEnd, sessionId, sessionStart, sessionStartTime, shutdownType, subagentDispatches (each with `agentId`), systemTokens, timeline, toolDefinitionsTokens, toolStats, totalApiDurationMs, totalPremiumRequests. `costUsd` is the sum of `copilotUsage.totalNanoAiu` / 1e11 over the per-request `session.usage_record` events, plus the compaction cost. `inputTokens` already includes cache read and cache write. `costUsd` is `null` (unknown, not 0) when the session has no usage records (older CLI).
- `session-store.db` (SQLite; open with `mode=ro`): `sessions` (id, cwd, repository, host_type, branch, summary, created_at, updated_at), `turns`, `checkpoints`, `assistant_usage_events`, `session_files`, `session_refs`, `dynamic_context_items`, `forge_*`, FTS `search_index*`.
- Hook and cache logs: `subagent-context/inject.log`, `env-context/inject.log`, `extensions/cache-keeper/logs/`, `extensions/turn-cost/logs/`. CLI: `logs/process-*.log`.
- Scripts (`session-state/scripts/README.md`):
  - `export-events.csx <events|dir> [--out f]`
  - `analyze-events.csx <path> [--dispatches] [--timeline] [--segments]`
  - `workflow/plan-check.ps1 -PlanPath <plan.md> [-SnapshotOut f] [-Compare snap] [-FailOnDrift]`. Only `-SnapshotOut` writes.
  - `workflow/plan-check.Tests.ps1`
  - `workflow/map-check.ps1 -MapPath <map.md> [-RepoRoot <dir>]`. Read-only; JSON on stdout; exit 0 = no error, 1 = at least one error, 2 = usage or internal error.
  - `workflow/map-check.Tests.ps1`
  - `session-metrics.csx <sessionStateDir> --out <file> [--from yyyy-MM-dd] [--to yyyy-MM-dd]`. Reads `<dir>/<id>/export.json` (it does not run `export-events.csx`); writes metrics JSON, schema v2 (the v1 fields are unchanged; v2 adds `costUsd`, `compactionCostUsd`, `agentUsage`, `keepAlive` and `hookLatency`). `cacheReadRatio` = sum(`cacheReadTokens`) / sum(`inputTokens`) over the models; `inputTokens` already includes the cache tokens, so the cache is counted once; null when the input total is 0. Exit 1 on usage errors. Exit 2 on a stale export: `events.jsonl` exists and `export.json` lacks `sourceEventCount` or has a lower count. The message is `export.json is stale for <id>[, <id>...]: run export-events.csx first`; run `export-events.csx` on each listed session.
  - `render-dashboard.csx <metrics.json> --out <file.html> [--pricing <pricing.json>] [--from] [--to] [--group all|cwd:<path>] [--focus <sessionId>]`. Cost: schema v2 uses the file's `costUsd` and ignores `--pricing` (a note says so); schema v1 uses `--pricing`, where the price of the uncached input is (`inputTokens` − `cacheReadTokens` − `cacheWriteTokens`) × input rate, and total tokens = `inputTokens` + `outputTokens` (cache counted once). Self-contained HTML (inline CSS and SVG, no JavaScript). Exit 0 written, 2 usage error, 1 invalid input.
  - `workflow/setup-check.ps1 [-Root <dir>]` (default `~\.copilot`). Read-only; prints one JSON object on stdout. Exit 0 = no error-severity failure, 1 = at least one, 2 = internal error or missing root. Exit 1 is a valid result, not a crash.
  - Requires .NET 9 SDK and dotnet-script 2.x. `setup-check.ps1` needs `git` on PATH.

## 10. Configuration nuances and known issues
1. **`disableAllHooks: true`** is set in `settings.json`, yet both registered hooks run (`env-context/inject.log` and `subagent-context/inject.log` get entries).
2. **Extensions.** Only the `EXTENSIONS` flag (not full experimental). `extensions.mode: "load_only"` removes extension-management tools. Headless `-p` loads user, plugin and session extensions; only project extensions (`.github/extensions/`) need `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` (`cli-main.js:2174`, CLI 1.0.103).
3. **cli-tools `Access` and `Rules` are advisory.** `subagent-context/lib/Tools.ps1` prints `[Access]` and the rule strings into `additionalContext`. Nothing enforces them. The governor reads per-tool access from `cli-tools` (§7b), which is a separate path.
4. **plan-check.ps1 with no task headings** returns the JSON error `no tasks found` and exits 1. This is fixed; `session-state/scripts/workflow/plan-check.Tests.ps1` covers it (50 tests). Plan-check also requires `Method` on every task.
5. **Subagent hooks.** `subagentStart` fires for every subagent. `sessionStart` env-context is skipped for subagents by design.
6. **No `preToolUse` hook file exists.** The shell governor registers its `preToolUse` hook as an extension, through `joinSession` in `extensions/shell-governor/main.mjs` (§7b). Tool policy therefore runs in the extension, not in `hooks/`.
7. **Tracked secret-adjacent files.** Git tracks `mcp-secrets/index.json` (folder not in `.gitignore`), `config.json` (login and trust records), `permissions-config.json`, `mcp-config.json`, `settings.json`, and `vscode.session.metadata.cache.json`. Review before any push. Only names and keys were checked.
8. **Skills.** Only the user-only skills set `disable-model-invocation: true`; see §5.
9. **yolo.** No `tools:` key, so tool access is the default *(unverified)*. Its `description` is a sentence, not a summary.
10. **MCP servers not referenced by name in agents** (grep): `github-personal`, `github-work`, `playwright`, `my-chrome`, `my-chrome-devtools`, `snowflake-nonprod`, `snowflake-prod`. They may be reached via tool names *(unverified)*.
11. **devops-tools plugin** (installed, disabled in `settings.json` and `config.json`). Three of its skills share names with local skill folders that are not published here. Enabling it would duplicate them *(unverified runtime behavior)*.
12. **cache-keeper config** has no `miss` section, so defaults apply.
13. **Restart the CLI after changing agents or hooks.** The CLI loads agent definitions and hook registrations at session start. Changes to `agents/*.agent.md` or `hooks/*.json` take effect only in a new session. Evidence: the running session's process log still references the old registration, `logs\process-1792658276186-24488.log` (`hooks\cli-tools.json`), after the switch to `subagent-context`.
14. **turn-cost kill switch.** `COPILOT_TURN_COST=off` (trimmed, case-insensitive) switches the extension off. It is read when the extension starts, so set it before the CLI starts. The off path still joins the session (so the CLI does not wait for it at start), logs one line to the extension's own log and subscribes to no session event, so nothing reaches the timeline (`wiring.mjs`). Removing `extensions/turn-cost/extension.mjs` also stops it (the CLI loads only that file of each extension folder, per `docs/agent-workflow.md`; not tested here).

## 11. Invariants: do not touch
- Do not read, print or copy `mcp-secrets/`, `mcp-oauth-config/`, `entra-broker-*/`, token or login values in `config.json`, or URLs and headers in `mcp-config.json`. Do not paste them into AGENTS.md, docs or reports.
- `session-state/<id>/` and `session-store.db*` are runtime data: read-only for analysis, never edited or committed. Only `session-state/scripts/` is code.
- Never commit `inject.log`, `state/`, `logs/`, `installed-plugins.lock`, `settings.json.lock` or `mcp-config.json.bak`. The ignore rules list these exact names, not wildcards; keep it that way.
- Agent names are identifiers. A rename must update skills, docs, `extensions/cache-keeper/config.json` (`ladder.actions[].when.agents`), the `util-plugin-sync` skip-list (line 49), the matching `cli-tools/<name>.json`, `extensions/shell-governor/config/agents.json` (overrides) and, for a code role, `conventions/profiles.json` (`codeRoles`). The planner and the reviewer are code roles.
- Keep `disableAllHooks` and the extension flags unchanged unless the behavior change is tested (§12).

## 12. Changing and testing safely
- Work in git: `git --no-pager -C C:\Users\USER\.copilot status`. Commit after tests pass.
- cache-keeper: `node --test "extensions/cache-keeper/tests/*.test.mjs"` (run from `C:\Users\USER\.copilot`; fake clock and session in `tests/helpers/fakes.mjs`).
- plan-check: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\plan-check.Tests.ps1"` (exit code = failures).
- map-check: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\map-check.Tests.ps1"` (exit code = failures).
- setup-check: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\setup-check.Tests.ps1"` (exit code = failures; good and bad fixtures).
- export-events: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\tests\export-events.Tests.ps1"` (exit code = failures).
- session-metrics: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\tests\session-metrics.Tests.ps1"` (exit code = failures; needs PowerShell 7.5+).
- render-dashboard: `pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\tests\render-dashboard.Tests.ps1"` (exit code = failures).
- Hook scripts: running `subagent-context/inject.ps1` or `env-context/inject-env.ps1` by hand appends to their logs. Prefer reading the logs.
- subagent-context: `pwsh -NoProfile -File "$HOME\.copilot\tests\subagent-context\inject.Tests.ps1"` (exit 0 = all pass; the fixtures live in `tests/subagent-context/fixtures/home`).
- Governor suite: `node --test --test-reporter=spec "tests/shell-governor/**/*.test.mjs"` (run from `C:\Users\USER\.copilot`).
- turn-cost: `node --test "extensions/turn-cost/tests/*.test.mjs"` (run from `C:\Users\USER\.copilot`).
- env-context: `pwsh -NoProfile -File "$HOME\.copilot\tests\env-context\inject-env.Tests.ps1"` (exit code = failures).
- Live probe (`tests/hooks/live/probe-instructions.ps1`): starts a real headless `copilot -p` session and rewrites `tests/hooks/live/RESULTS.md`. Do not edit `RESULTS.md` by hand.
- Live check (as in history): start a separate interactive window with `Start-Process pwsh` running `copilot -i "<prompt>"`. Read the new `session-state/<id>/events.jsonl` (`session.start`, `subagent.selected`, `subagent.started`, `system.message`). Stop it with `Stop-Process -Id <pid>`. Never capture or screenshot windows.
- Headless: project extensions need `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`; user extensions load without it. Scripts folder access needs `--add-dir "$HOME\.copilot\session-state\scripts"` *(unverified)*.
- Validate JSON with `jq . <file>` before committing.

## 13. For analysis agents
- Read §10 first. Names drift, and some docs are stale.
- Attribute subagent activity by `agentName` in `subagent.started` and by `agentId` in event envelopes. The main agent appears as `1brainstorm`, `main` or `1main`, depending on CLI version.
- Cost: use the `costUsd` fields (export.json, or metrics schema v2). `modelMetrics.cost` is premium-request units, not USD. `session.start.selectedModel` is the settings default, not the agent's model *(per docs)*.
- `workflow/setup-check.ps1` automates the mechanical part of this checklist (IDs AGT-FRONTMATTER, AGT-NAME-FILE, AGT-MODEL-DESC, AGT-AGENT-TOOL, AGT-SHELL-DISCIPLINE, AGT-CLITOOLS, REF-AGENT-NAMES, REF-SKIPLIST, HOOK-SCRIPT, SKILL-FOLDER, SKILL-ORPHAN, SET-EXT, JSON-VALID, GIT-IGNORE, GIT-TRACKED-SENSITIVE). REF-AGENT-NAMES checks prose agent names and `--agent <name>` / `/agent <name>` refs in AGENTS.md, docs, skills and agents. A line with `<!-- setup-check: legacy-names=a,b -->` exempts only the listed prose names on that line (the bare form exempts nothing); flag refs are always checked. Agent bodies (`agents/*.agent.md`) are scanned for flag refs only. AGT-SHELL-DISCIPLINE requires the "Shell discipline" heading only in top-level agents (`disable-model-invocation: true`) that have `powershell`. It also checks that `cli-tools/_shell.json` has a `Shell discipline:` rule and that `subagent-context/shared-rules.md` has the headings Reports, NEEDS-INPUT, Evidence and Secrets. Run it first, then do the judgement items by hand (contradictions, stale prose).
- Review checklist per component:
  - frontmatter `name` matches file name and all references in skills and docs
  - description model matches `model:`
  - `tools:` lists (the `agent` tool is on `1main` only)
  - every subagent that needs tools has a `cli-tools/<name>.json`; top-level-only agents (`disable-model-invocation: true`) are never injected, so they have none (`util-workflow-analyst.json` is documentation only)
  - hook registrations match existing scripts
  - `settings.json` flags match what the extension needs
- Verify claims with grep or jq, and cite `path:line`.

## 14. Pointers
- `docs/agent-workflow.md`: workflow, states, models, `/save`, `/stop`, cache-keeper summary, design notes.
- `session-state/scripts/README.md`: telemetry scripts.
- Bundled CLI docs: `C:\Users\USER\AppData\Local\copilot\pkg\win32-x64\1.0.98\copilot-sdk\docs\` (`extensions.md`, `agent-author.md`, `workflows.md`, `examples.md`). Changelog: `C:\Users\USER\AppData\Local\copilot\pkg\win32-x64\1.0.98\changelog.json` (outside `copilot-sdk\docs\`).
