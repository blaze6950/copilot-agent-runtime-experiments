# Worker dispatch templates

Workers write a report file into the reports folder named in their injected `## Session` block (`reports:`, the report folder) and put its path in the HANDOFF or in the mode's report block (SETUP REPORT, INTEGRATION REPORT, VERIFY REPORT). A legacy `TDD: exempt` in a task block → pass `method: mechanical`. `allow_dirty: yes` only when the user approved pre-existing uncommitted changes; list those paths under `## Context`.

All dispatches: `mode: "background"`, explicit `model` (`claude-haiku-5.5` unless the plan task or an escalation says otherwise), a descriptive `name`.
Paste task blocks verbatim from plan.md — never ask a Worker to read the whole plan.

## sub-worker-main — setup
```
mode: setup
repo: <REPO>
target_branch: <TARGET>
expected_head: current
allow_dirty: <yes|no>
base_ref: <Base ref>
create_branch: <no | yes (user approved: "<quote>")>
plan_path: <SF>\plan.md
plan_revision: <N>
snapshot_path: <SF>\files\plan-snapshot-r<N>.json
final_verification:
- <command>
Return the SETUP REPORT from your instructions.
```

## sub-worker-main — task (main working tree)
```
mode: task
task: <Tid> of plan "<title>" (revision <N>)
method: <tdd|refactor|mechanical|git-ops|verify>
repo: <REPO>
target_branch: <TARGET>
expected_head: <current_head>
allow_dirty: <yes|no>
plan_path: <SF>\plan.md
plan_revision: <N>
task_hash: <hash>
push: <omit | yes (user approved: "<quote>")>
attempt: <k> (<"first attempt" | previous failure + diagnosis>)

## Task (verbatim from plan.md)
<full "### <Tid>: ..." block>

## Acceptance criteria referenced by this task
- AC-<n>: <text>

## Ownership
- owns: <list/globs>
- reads: <list>

## Commands
- verify: <exact command>
- build/tests: <commands>

## Context
<where this fits; contracts from dependencies (commit shas / paths); conventions; relevant Working Memory facts and decisions>

Return the HANDOFF from your instructions.
```

## sub-worker-wt — task (own worktree)
```
task: <Tid> of plan "<title>" (revision <N>)
method: <tdd|refactor|mechanical>   # git-ops and verify are invalid for worktree tasks
repo: <REPO>
worktree: <REPO>\.worktrees\<SLUG>\<Tid>
branch: wf/<SLUG>/<Tid>
base_sha: <current_head>
reuse: <no | yes>
plan_path: <SF>\plan.md
plan_revision: <N>
task_hash: <hash>
attempt: <k> (<...>)

## Task (verbatim from plan.md)
<full block>

## Acceptance criteria referenced by this task
- AC-<n>: <text>

## Ownership
- owns: <list/globs>
- reads: <list>

## Commands
- verify: <exact command>
- build/tests: <commands>

## Context
<...>

Return the HANDOFF from your instructions.
```

## sub-worker-main — integrate
```
mode: integrate
repo: <REPO>
target_branch: <TARGET>
expected_head: <current_head>
allow_dirty: <yes|no>
plan_path: <SF>\plan.md
plan_revision: <N>
merge_in_order:
- task_id: <Tid>
  branch: wf/<SLUG>/<Tid>
  worktree: <path>
  base_sha: <sha>
  commit_sha: <sha>
  task_hash: <hash>
  owns: <list/globs>
  verify: <command>
  task_text: |
    <verbatim task block>
  acceptance:
  - AC-<n>: <text>
remove_merged_worktrees: yes
run_final_verification_after_merges: <no | yes: commands>
Return the INTEGRATION REPORT from your instructions. Unresolvable conflicts: abort that merge and report — do not guess.
```

## sub-worker-main — verify
```
mode: verify
repo: <REPO>
target_branch: <TARGET>
expected_head: <current_head>
allow_dirty: <yes|no>
plan_path: <SF>\plan.md
plan_revision: <N>
final_verification:
- <command>
acceptance:
- AC-<n>: <text>
Do not change files. Return the VERIFY REPORT from your instructions (including `report:`).
```

## Follow-ups to the same Worker (`write_agent`)
- BLOCKED or NEEDS-INPUT answer (both via `write_agent` to the same Worker): "Answer to your question(s): … Continue the task; same rules; return a new HANDOFF."
- Handoff/gate rejection: "Rejected: <reason with evidence>. Fix on the same branch; return a new HANDOFF."
- Review findings: "Reviewer findings to address: <Critical/Warning items with file:line>. Fix, re-run verify, commit, return a new HANDOFF."
- Plan drift: "STOP — plan changed (r<old> → r<new>). Do not commit further. Return your current state as HANDOFF with status STALE."
