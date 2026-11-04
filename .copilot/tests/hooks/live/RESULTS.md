# Live probe: instruction loading for sub-agents (AC-2)

Written by `tests/hooks/live/probe-instructions.ps1` from one real headless session. Re-run the script to refresh; do not edit by hand.

- CLI version: GitHub Copilot CLI 1.0.98.
- date: 2026-10-22 10:56 +02:00
- command: copilot --model claude-haiku-5.5 --allow-all-tools --no-ask-user -p "Dispatch the probe-reader agent and print its answer verbatim."
- cwd: scratch git repo under %TEMP%\hooks-instructions-probe\project (removed after the run)
- extensions: off (GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS unset); scratch folder trusted: no (not in trustedFolders; the headless session still started and dispatched)
- session: 4f145678-8b4a-4fcc-a8c3-41f50710ae56 (events.jsonl stays in session-state, not copied)
- sub-agent: probe-reader (include-custom-instructions: true, user-invocable: false, tools: view); dispatches observed: 1; sub-agent tool calls: none
- top-level dispatch prompt or sub-agent prompt contains a marker: no
- process: exit 0

| Source in scratch repo | Marker | Delivered to sub-agent | In sub-agent system context | Note |
|---|---|---|---|---|
| AGENTS.md | PROBE-AGENTS-7F3A | yes | yes |  |
| .github/copilot-instructions.md | PROBE-COPILOT-2B9C | yes | yes |  |
| .github/instructions/probe.instructions.md | PROBE-INSTR-5D1E | yes | yes |  |

Sub-agent answer lines containing PROBE- (verbatim, first 20):
    Three lines in my context contain `PROBE-`:
    1. `Marker: PROBE-COPILOT-2B9C`
    2. `Marker: PROBE-AGENTS-7F3A`
    3. `Marker: PROBE-INSTR-5D1E`

## Derived switches

- repoRootInstructions: native (native only when AGENTS.md and copilot-instructions.md are both delivered)
- githubInstructions: native (native only when the .github/instructions marker is delivered)

Caveat: the scratch folder was not trusted. A "yes" is valid evidence; a "no" could be caused by the untrusted folder and must be re-checked after trusting it.
