---
name: 1diagnose
description: "User shortcut: turn the latest workflow-analysis findings into causes and improvement options. Invoke explicitly with /1diagnose [findings file] [finding keys]."
disable-model-invocation: true
---

Diagnose now. This is the only step where causes and options are allowed. The analysis report itself stays report-only.

## Guard
If you are not running as the `util-workflow-analyst` agent, stop at once. Tell me to switch to it (`--agent util-workflow-analyst`) and do nothing else.

## Input
- Text after `/1diagnose` may name a findings file (`reports\workflow-analysis-<yyyyMMdd-HHmm>.findings.json`) and/or finding keys (for example `C:repeatDispatches:abc123`).
- No file named: use the newest `$HOME\.copilot\reports\*.findings.json` (by file name, which sorts by time). If none exists, stop and tell me to run an analysis first.
- No keys named: take every finding with severity `Problem`. If there is none, take every `Watch` finding. If there is none, stop and say so.
- A key that is not in the file: say so, skip it, go on with the rest.
- Do not ask me to confirm defaults you can derive. Ask with `ask_user` only when the file or the keys are truly unclear.

## For each selected finding
1. Investigate. Read the files named in the finding's `evidence` (use `view` and `grep`). Query the session exports with `jq` (`session-state\<id>\export.json`) and the history with `usql` (read-only). Follow the Shell discipline and the limits in your own instructions. Never open secret paths.
2. Write the finding as a block with these parts:
   - **Finding:** key, title, severity, and what was observed (copy the facts, do not change them).
   - **Cause hypothesis:** the most likely cause in one or two sentences. Evidence for it, each item cited as `path:line`, session id, or metric. Confidence: High, Medium or Low, with one sentence on why. If you tested and rejected another cause, say which and why.
   - **Options:** 2 or 3 options. For each: what changes, benefit, cost or risk (trade-offs), and effort (low, medium, high). Include "do nothing" when it is a real choice. Do not hide the trade-offs.
   - **Priority:** P1, P2 or P3. P1 = costs money or quality now, or breaks a rule. P2 = clear waste or risk, no damage yet. P3 = tidy-up. One sentence explains the choice.
3. Do not change any file other than the diagnosis file. Do not apply an option.

## Output
- Write `$HOME\.copilot\reports\diagnosis-<yyyyMMdd-HHmm>.md` with the `create` tool (create the folder first if missing).
- Start with a header: source findings file, analysis date, keys covered, keys skipped (with reason).
- Then a short table: key | title | priority | top option. Then one block per finding, ordered P1 first.
- Language: clear English at about CEFR B2. Short sentences. Explain terms and expand IDs. Mark facts and interpretations separately. No secrets, URLs or tokens.
- End the file and your reply with exactly this plain-text line: Next: load this file into a `1main` session for brainstorming.
- In your reply: the file path, the number of findings diagnosed, and the P1 titles. No more.
