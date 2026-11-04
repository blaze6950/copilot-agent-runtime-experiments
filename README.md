# Copilot Agent Runtime Experiments

Research and prototype repository for experimenting with:

- GitHub Copilot agent workflows
- Context optimization and hygiene
- Agent observability
- Token and cost reduction
- Orchestrator / sub-agent architecture
- Persistent working memory patterns
- Runtime telemetry analysis

> This repository is experimental and research-oriented.
> The workflows, prompts and architecture patterns are still evolving.

**[→ Live Presentation](https://blaze6950.github.io/copilot-agent-runtime-experiments/)**

---

# Repository Structure

```text
.
├── README.md                  # this file
├── LICENSE                    # MIT license
├── .idea/                     # IDE project settings (no user-specific files)
├── docs/
│   └── index.html             # talk deck (Reveal.js), behind the Live Presentation link
└── .copilot/                  # published subset of ~/.copilot (see the next section)
    ├── AGENTS.md              # detailed map of the Copilot CLI setup
    ├── agents/                # 35 custom agent definitions (*.agent.md)
    ├── cli-tools/             # tool lists and rules injected into sub-agents
    ├── conventions/           # convention packs (general.md, dotnet.md) and profiles.json
    ├── docs/
    │   └── agent-workflow.md  # workflow design document
    ├── env-context/
    │   └── inject-env.ps1     # sessionStart hook script (env.json is not published)
    ├── extensions/
    │   ├── cache-keeper/      # prompt-cache keeper and main status line
    │   ├── shell-governor/    # approval gate for shell and file tool calls
    │   └── turn-cost/         # turn statistics in the timeline
    ├── hook-ui/
    │   └── HookUi.ps1         # UI helper shared by the hooks
    ├── hooks/                 # hook registrations (env-context.json, subagent-context.json)
    ├── session-state/
    │   └── scripts/           # telemetry scripts and workflow checks
    ├── skills/                # 5 skills (one SKILL.md per skill folder)
    ├── subagent-context/      # subagentStart hook and shared sub-agent rules
    └── tests/                 # test suites for the hooks, extensions and scripts
```

---

# How .copilot maps to ~/.copilot

- `.copilot/` mirrors the author's `%USERPROFILE%\.copilot` path for path (published subset). [`.copilot/AGENTS.md`](.copilot/AGENTS.md) is the detailed map; it also names local files that are not published.
- To use it, copy the folders into your own `~/.copilot`. `hooks/*.json` call `C:/Users/USER/.copilot/...`: change the path to your home.
- Extensions need `enabledFeatureFlags.EXTENSIONS: true` and `extensions.mode: "load_only"` in your `settings.json` ([`.copilot/AGENTS.md` §7](.copilot/AGENTS.md#7-cache-keeper-extension)).
- `env-context/env.json` is personal and not published. Create your own with the keys `Directories` (`Name`, `Path`, `Description`), `Facts` (strings) and `Tree` (`Enabled`, `Exclude`). Without it the sessionStart hook emits nothing.

---

# Agents (35)

| Category | Agents |
|---|---|
| Main | `1main` |
| Workers | `sub-worker-main`, `sub-worker-wt`, `sub-worker-docker`, `sub-worker-media` |
| Planner | `sub-planner-implementation` |
| Experts (read-only domain keepers; `sub-expert-ado-writer` writes only with an authorized write block) | `sub-expert-ado`, `sub-expert-ado-writer`, `sub-expert-github`, `sub-expert-backstage`, `sub-expert-edm`, `sub-expert-docs`, `sub-expert-scalr`, `sub-expert-argocd-prod`, `sub-expert-argocd-nonprod`, `sub-expert-newrelic`, `sub-expert-miro`, `sub-expert-web`, `sub-expert-k8s-prod`, `sub-expert-k8s-nonprod`, `sub-expert-snow-prod`, `sub-expert-snow-nonprod`, `sub-expert-db`, `sub-expert-az`, `sub-expert-aws`, `sub-expert-hetzner`, `sub-expert-gws` |
| Explorers | `sub-explorer-code`, `sub-explorer-debug` |
| Reviewer | `sub-reviewer-code` |
| Managers | `sub-manager-docs`, `sub-manager-history` |
| Utilities | `util-workflow-analyst`, `util-plugin-sync`, `yolo` |

### MCP Keeper Pattern

The research sub-agents follow a **keeper pattern** — one agent per MCP domain rather than a single monolithic researcher with all MCP tools attached.

This was tested against the monolithic approach and showed significantly better results:

- each keeper receives only the tools relevant to its domain
- tool definition noise is eliminated (no irrelevant tools in context)
- prompts are narrow and domain-specific
- the orchestrator routes questions to the correct keeper by domain
- keepers can be added/removed independently as MCP integrations change

The expert domains are: Azure DevOps (read and write), ArgoCD prod/nonprod, AWS, Azure, Backstage, databases, library docs, EDM, GitHub, Google Workspace, Hetzner, Kubernetes prod/nonprod, Miro, New Relic, Scalr, Snowflake prod/nonprod, web.

---

# Workflow

Start with `copilot --agent 1main`, then follow these steps:

1. **Brainstorm** with `1main`: describe the goal. Main researches through sub-agents, assesses the options and recommends one.
2. **`/save`**: stores the agreed facts and decisions in `# Working Memory` of the session's `plan.md`.
3. **`/1make-plan`**: writes the `# Plan` with its tasks. `plan-check.ps1` validates it.
4. **`/1implement`**: executes the approved plan (workers, integration, review and verification).

Details: [.copilot/docs/agent-workflow.md](.copilot/docs/agent-workflow.md).

---

# Skills (5)

- `1make-plan`: turns agreed decisions into `# Plan` in plan.md, validated by plan-check.
- `1implement`: executes the approved plan.md (setup, Workers, integration, review, verification).
- `save`: `/save`, persists session facts via sub-manager-docs.
- `stop`: `/stop`, cooperative stop with a checkpoint.
- `1diagnose`: `/1diagnose [findings file] [finding keys]`, turns workflow-analysis findings into causes, 2–3 options and P1–P3 priorities. It runs only in a `util-workflow-analyst` session.

---

# Extensions

The three extensions need `enabledFeatureFlags.EXTENSIONS: true` and `extensions.mode: "load_only"` in `settings.json`.

**cache-keeper** (`.copilot/extensions/cache-keeper/`, see [AGENTS.md §7](.copilot/AGENTS.md#7-cache-keeper-extension)). The root agent's prompt cache expires after 5 minutes. During user absence and background waits, the keeper sends keep-alive prompts shortly before that, then runs the configured ladder actions (by default `/save` and `/compact`). It also shows the `main` status line. `COPILOT_CACHE_KEEPER=off` switches it off.

**shell-governor** (`.copilot/extensions/shell-governor/`, see [AGENTS.md §7b](.copilot/AGENTS.md#7b-shell-governor)). Each `powershell` call is classified before it runs: safe calls run, syntax errors are denied, calls that need a closer look go to an AI judge, and calls that the judge or the rules cannot clear ask you in an approval dialog. It also checks the file tools (`view`, `grep`, `glob`, `edit`, `create`) against directory rules. Setting `enabled` to `false` in `config/governor.json` turns its decisions off.

**turn-cost** (`.copilot/extensions/turn-cost/`, see [AGENTS.md §7c](.copilot/AGENTS.md#7c-turn-cost-extension)). It adds turn statistics to the timeline: one line for a simple turn (no sub-agent, cost of at most $0.50), and a header with a table for any other turn. The lines show duration, cost, model, requests, tokens, cache hit rate and a time split. The columns can be switched on or off in its `config.json`. `COPILOT_TURN_COST=off` switches it off. Nothing is sent to the model.

---

# Hooks and context injection

Two hooks run at session start. Both are described in [.copilot/AGENTS.md §3](.copilot/AGENTS.md#3-session-start-hooks-and-injections).

- **sessionStart** (`hooks/env-context.json` → `env-context/inject-env.ps1`): adds an environment context block with the facts from `env.json`, the working directory, the git root and branch, the known directories and a bounded file tree. It skips sub-agents and resumed sessions.
- **subagentStart** (`hooks/subagent-context.json` → `subagent-context/inject.ps1`): for every sub-agent, adds the shared rules (reports, NEEDS-INPUT, evidence, secrets), the session block with the reports folder, and the agent's CLI tool list from `cli-tools/`. For code roles it also adds the convention packs from `conventions/`.

---

# Scripts

The telemetry and workflow scripts are in [`.copilot/session-state/scripts/`](.copilot/session-state/scripts/README.md). They replace the former top-level `scripts/` folder.

Telemetry scripts (Copilot CLI session events):

- `export-events.csx`: exports session events to structured JSON.
- `analyze-events.csx`: prints a human-readable analysis of one session.
- `session-metrics.csx`: builds cross-session metrics JSON from each session's `export.json`.
- `render-dashboard.csx`: builds a self-contained HTML dashboard from a metrics JSON.

Workflow checks (used by the agent workflow):

- `workflow/plan-check.ps1`: validates `plan.md` and detects drift.
- `workflow/map-check.ps1`: checks the evidence in the planner's maps.
- `workflow/setup-check.ps1`: read-only health check of the setup, JSON output.

See [.copilot/session-state/scripts/README.md](.copilot/session-state/scripts/README.md) for usage.

---

# Tests

Run these commands from the `.copilot` folder. Each one must exit 0.

```powershell
node --test "extensions/cache-keeper/tests/*.test.mjs"
node --test "extensions/turn-cost/tests/*.test.mjs"
node --test "tests/shell-governor/**/*.test.mjs"
pwsh -NoProfile -File tests/subagent-context/inject.Tests.ps1
pwsh -NoProfile -File tests/env-context/inject-env.Tests.ps1
pwsh -NoProfile -File session-state/scripts/workflow/plan-check.Tests.ps1
pwsh -NoProfile -File session-state/scripts/workflow/map-check.Tests.ps1
pwsh -NoProfile -File session-state/scripts/workflow/setup-check.Tests.ps1
pwsh -NoProfile -File session-state/scripts/tests/export-events.Tests.ps1
pwsh -NoProfile -File session-state/scripts/tests/session-metrics.Tests.ps1
pwsh -NoProfile -File session-state/scripts/tests/render-dashboard.Tests.ps1
```

Requirements: Node 24, PowerShell 7.5+, .NET 9 SDK with dotnet-script 2.x, and git.

The live suites `tests/hooks/live/` and `tests/shell-governor/live/` need a real Copilot CLI session. They are not part of the automatic run.

---

# Not published, and why

| Not published | Why |
|---|---|
| CLI config and state: `config.json`, `settings.json`, `permissions-config.json`, `mcp-config.json`, `mcp-secrets/`, `vscode.session.metadata.cache.json`, `session-store.db`, `session-state/<id>/`, `logs/`, extension `logs/`, `state/`, `reviews/`, `.local/`, `inject.log` | Personal settings, login and trust records, secrets and runtime data. |
| `env-context/env.json` | Personal folders. |
| The other 87 skill files (every file under `skills/` except the five published skills) | Company-specific or third-party skills. |
| The golden test `session-state/scripts/tests/golden.Tests.ps1` and its fixtures `session-state/scripts/tests/fixtures/golden/` | Slices of real sessions with prompts. |
| The playground's root `.gitignore` | Ignore rules of the private setup, not part of the published subset. |
| The playground's git history | Not audited. |

---

# Sanitization

- Company-specific values in a few agents, CLI tool files and tests are replaced by neutral placeholders:
  - Snowflake connections: `example_prod`, `example_nonprod`
  - portal host: `portal.example.com`
  - plugin marketplace: `example-enterprise-plugins`
  - AWS accounts: `111111111111`, `222222222222`
  - EKS clusters: `example-prod`, `example-preprod`
  - Azure subscriptions: `Example Product - NonProd`, `Example Tooling`
- References to unpublished skills and to the golden test are reworded or removed.
- Two documented differences are not sanitization edits:
  - `extensions/cache-keeper/config.json` is the committed version, with the countdown off.
  - One cache-keeper test reads the committed config relative to `.copilot/`.
- `C:\Users\USER` paths are kept as they are.

---

# Contents

## docs/

Contains the original HTML presentation used during a talk.

The presentation covers topics such as:

- Usage-based pricing impact
- Context entropy
- Agent loop behavior
- Context compaction
- Context hygiene
- MCP/tooling optimization
- Orchestrator/sub-agent architecture
- Persistent working memory
- Token cost optimization
- Observability gaps in current runtimes

The presentation is self-contained and can be opened directly in any browser.

**[→ Live Presentation](https://blaze6950.github.io/copilot-agent-runtime-experiments/)**

The deck shows the agent setup at the time of the talk; its agent names differ from the current set in .copilot/agents/.

---

# Core Ideas

## Context Hygiene

Large noisy contexts reduce model quality, increase latency and dramatically increase cost.

This repository experiments with techniques such as:

- disabling unnecessary MCP servers
- minimizing tool exposure
- narrow and precise prompts
- isolated workflows
- reduced context pollution
- compact tool outputs

## One Session = One Task

Long-running sessions tend to accumulate:

- context entropy
- duplicated information
- degraded reasoning quality
- excessive compaction
- unnecessary token consumption

This workflow encourages smaller isolated sessions with explicit state transfer when needed.

## Orchestrator / Worker Separation

The architecture separates:

**High-level reasoning**

Handled by orchestrator agents using stronger models.

**Specialized execution**

Handled by lightweight worker agents using cheaper/faster models.

This helps reduce:

- token usage
- context growth
- tool noise
- compaction frequency

while improving:

- observability
- modularity
- execution speed
- workflow control

## Persistent Working Memory

The workflow experiments with explicit persistent memory files instead of relying entirely on opaque runtime memory systems.

Advantages include:

- human-readable state
- editable memory
- cross-session reuse
- better post-compaction recovery
- explicit knowledge transfer

## Observability

Current agent runtimes expose very limited visibility into:

- agent loops
- tool calls
- sub-agent behavior
- context growth
- runtime decisions

The included tooling attempts to improve runtime observability through telemetry analysis and structured event extraction.

---

# Important Notes

- This repository is not production-ready.
- The workflows are experimental.
- Some ideas may change significantly over time.
- The setup is intentionally research-oriented.
- The implementation is optimized for exploration and iteration rather than stability.

---

# Goals

The primary goal of this repository is to explore:

- scalable agent workflows
- efficient runtime architectures
- token-efficient orchestration
- observability tooling
- practical engineering patterns for LLM agents

especially under usage-based pricing models.

---

# Disclaimer

This repository represents personal research and experimentation.
It is not affiliated with or endorsed by GitHub, Microsoft or Anthropic.

---

# License

This repository is licensed under the MIT License. See [LICENSE](LICENSE) for more details.
