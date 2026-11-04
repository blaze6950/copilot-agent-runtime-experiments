---
name: stop
description: "User shortcut: cooperative stop at the next safe point — no new work, checkpoint report, then wait. Invoke explicitly with /stop [agents]."
disable-model-invocation: true
---

Stop at the next safe point:
1. Start nothing new: no dispatches, investigations, edits or commands.
2. Let the current operation finish or leave it in a safe state; do not process further steps of the plan.
3. If I wrote `/stop agents`: send each running sub-agent "STOP — do not start new steps or commits; return your current state." with `write_agent`. Otherwise leave them running.
4. Report a checkpoint: done, unfinished (next step for each), running agents with their status from `list_agents` (never claim an agent or process stopped unless confirmed), risks. Note: hard cancel is `/tasks` → `x` or double-Esc.
5. Do not resume on your own; wait for my next instruction. Do not run /save.
