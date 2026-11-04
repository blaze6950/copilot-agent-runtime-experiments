# Reviewer dispatch templates

All dispatches: `mode: "background"`, agent `sub-reviewer-code`, `model: claude-sonnet-5.5`, `reasoning_effort: high` (Main passes both on every dispatch; they match the agent's frontmatter, and the dispatch value wins), a descriptive `name`.
Paste task blocks verbatim from plan.md. Never ask the reviewer to read the whole plan: it reads the task block, its ACs, the design file and the handoff.

## Input fields
- `repo`: working tree that holds the change (main working tree or the task worktree).
- `range`: `<base>..<head>` commit range under review.
- `plan_path`: `<SF>\plan.md`.
- `task` (per-task review) or `goal` (final review): the verbatim task block with its ACs, or the goal text with all plan ACs.
- `design_path`: the value of the `- Design file:` line under `## Engineering Assessment` in plan.md (the absolute path of the planner's output file, or `none`). Pass that value unchanged. If that line is absent, pass `none`.
- `asis_map_path` and `target_map_path`: the values of the `- Current-state map:` and `- Target map:` lines under `## Engineering Assessment` in plan.md (each an absolute path or `none`). Pass the values unchanged. If a line is absent, pass `none` for it. With a target map the reviewer re-runs `map-check.ps1` on the as-is map (drift = only errors on rows whose file is not in `git diff --name-only <range>`; rows in changed files are expected to move and are ignored; drift is a Warning "as-is map drift", never BLOCKED) and compares the implemented structure with the target map (per-task review: the elements of the task's `Map` line; final review: the whole map). It reports the result in the `maps:` line of the verdict header; an unreadable or missing map file given in the dispatch is a gap noted in `maps:`, never BLOCKED.
- `owns`: the globs the reviewed task or tasks may change.
- `handoff_report`: the absolute report path of each Worker report, one line per task.
- `handoff`: the Worker's HANDOFF block, verbatim (per-task review only).
- `conflict_resolutions`: the conflict resolutions from the integration reports, or `none` (final review only).
- `verify`: the verification commands that are expected to pass.

For these missing inputs (`repo`, `range`, `plan_path`, `design_path`), return BLOCKED, not NEEDS-INPUT. Name the missing input and never review without it. Main fills every field before dispatch. An absent `Design file:` line in the plan means Main passes `design_path: none`; the reviewer then reviews against the task text and plan and states it in `scope:`. An absent `Current-state map:` or `Target map:` line means `none` for that path; a map path is never a reason for BLOCKED.

## Per-task review (`Review: per-task`)
Not used for tasks without a new commit.
```
name: review-<Tid>
repo: <REPO or worktree path>
range: <base_sha>..<commit_sha>
plan_path: <SF>\plan.md
design_path: <Design file value from plan.md>
asis_map_path: <Current-state map value from plan.md, or none>
target_map_path: <Target map value from plan.md, or none>

task: <Tid> of plan "<title>"
## Task (verbatim from plan.md)
<full "### <Tid>: ..." block>

## Acceptance criteria referenced by this task
- AC-<n>: <text>

owns:
- <list/globs>

handoff_report:
- <Tid>: <absolute report path>

handoff: |
  <Worker HANDOFF block, verbatim>

verify:
- <command>

Read every changed file fully. Write the full review to your report; return the verdict header, a one-line-per-finding summary and the report path.
```

## Final review (`/1implement` §8)
```
name: review-final-<N>
repo: <REPO>
range: <setup head>..<current_head>
plan_path: <SF>\plan.md
design_path: <Design file value from plan.md>
asis_map_path: <Current-state map value from plan.md, or none>
target_map_path: <Target map value from plan.md, or none>

goal: <plan goal or the user's stated goal>
## Acceptance criteria (all plan ACs)
- AC-<n>: <text>

owns:
- <Tid>: <list/globs>   (one line per task in the range)

handoff_report:
- <Tid>: <absolute report path>
conflict_resolutions: <list from integration reports, or "none">

verify:
- <final verification command> → <result from sub-worker-main verify>

Read every changed file fully. Write the full review to your report; return the verdict header, a one-line-per-finding summary and the report path.
```

## Follow-ups to the same reviewer
- Re-reviews and follow-ups (a `BLOCKED` reviewer whose missing input is now fixed, or a delta after fixes) go to the same `sub-reviewer-code` via `write_agent`, with the delta range `<base>..<new head>` and the corrected input fields. Name the message `review-<Tid>-r2` (or `review-final-<N>-r2`).
- A fresh dispatch with the full template only when the reviewer is no longer reachable ("Agent not found", e.g. after a session restart).
- `CHANGES_REQUIRED`: do not send the findings to the reviewer. Send them to the Worker (see `worker-dispatch.md`, "Review findings"); after the Worker's fix commit, re-review the delta with `write_agent` to the same reviewer.
