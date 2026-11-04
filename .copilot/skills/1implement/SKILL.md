---
name: 1implement
description: "Main-agent workflow phase. Executes the agreed plan.md without switching agents or sessions: setup, main-tree and parallel worktree Workers, integration by a main-tree Worker, plan change control, Reviewer, final verification and report. Invoke explicitly with /1implement."
disable-model-invocation: true
---

# /1implement — execute the agreed plan

You are `1main`. If you cannot dispatch `sub-worker-main`, stop and tell the user: "Switch with `/agent 1main`, then run `/1implement` again."
If the invoking message carries the `[[PLAN]]` marker, the CLI is in plan mode: ask the user to press Shift+Tab to return to interactive mode and re-run `/1implement`.

Announce: "Implementation phase: executing plan revision <N>." Arguments after `/1implement` are user instructions (e.g. "only T1–T3", "max 2 parallel workers").

**You coordinate; Workers act.** You never run git, builds, tests, merges or conflict resolution yourself; delegate them to Workers (PowerShell only when no sub-agent fits). Every change to the repository is made by `sub-worker-main` (main working tree, one at a time) or `sub-worker-wt` (own worktree, parallel).

Paths: `<SF>` = session folder; `<PLAN>` = `<SF>\plan.md`; `<STATE>` = `<SF>\implementation-state.md`; `<SNAP>` = `<SF>\files\plan-snapshot-r<N>.json`; `<REPO>`, `<TARGET>` from the plan header; `<SLUG>` = kebab-case plan title (≤ 24 chars); worktree task paths `<REPO>\.worktrees\<SLUG>\<Tid>` on branches `wf/<SLUG>/<Tid>`.
Templates: `C:\Users\USER\.copilot\skills\1implement\references\worker-dispatch.md` and `implementation-state-template.md` — `view` them before the first dispatch.

## 0. Resume first
If `<STATE>` exists with Phase `IMPLEMENTING`, `VERIFYING` or `PAUSED`, you are resuming (new `/1implement`, compaction, or session resume): read `<STATE>`, call `list_agents`, and reconcile every `RUNNING` entry (completed agent → `read_agent` and process its report; missing agent → re-dispatch with `reuse: yes` where a worktree exists). Never start a second execution of the same plan.

## 1. Preflight (you, no shell)
1. Read `<PLAN>`: `Status` must be `DRAFT` or `APPROVED`, `## Unresolved Decisions` must be `none`, `Target branch` and `Repository` present. Otherwise list the problems and suggest `/1make-plan`.
2. The user's `/1implement` invocation approves the current revision. Set `**Status:** IMPLEMENTING` (status edits are not drift); record the approval as the first `<STATE>` event (step 5).
3. Tell the user: work lands on `<TARGET>` in `<REPO>`; do not edit the working tree or IDE while Workers run; nothing is pushed unless the user approved `push: yes` for a task (quote the approval in the dispatch).
4. If `<TARGET>` is `main`/`master` or another protected branch, or does not exist yet: ask the user (approve, or create a feature branch from `Base ref`). Pass the decision to setup.
5. Create `<STATE>` from the template (all tasks `PENDING`, workspace per task, waves from the plan's Execution Graph).
6. Choose `allow_dirty` for every `sub-worker-main` dispatch: `yes` only when the user approved working with pre-existing uncommitted changes (record the approval in `<STATE>`); otherwise `no`. With `yes`, list the pre-existing paths under `## Context` of each dispatch.

## 2. Setup (one `sub-worker-main`, mode `setup`)
Dispatch with: `repo`, `target_branch`, `expected_head` (unknown → `"current"`; the worker then reports it), `base_ref`, `create_branch` decision, `allow_dirty` (§1 item 6), `plan_path`, `plan_revision`, `snapshot_path` = `<SNAP>`, `final_verification` commands. Its SETUP REPORT gives HEAD, IDE availability, baseline results and task hashes/waves.
- `status` not DONE → report to the user and stop (or fix the plan via `/1make-plan`).
- Pre-existing baseline failures → tell the user and ask whether to proceed (they are excluded from "new failure" judgement).
- IDE unavailable and some tasks are `IDE: required` → ask the user to open the solution in Rider, then re-run setup.
- `worktree_exclude` must be `present` or `added` (verified by `check-ignore`). Anything else → `write_agent` the setup Worker to complete step 3 before any worktree task is dispatched.
- Record HEAD as `current_head`, task hashes, IDE status and baseline in `<STATE>`.

## 3. Execution loop
Repeat until every task is `MERGED` (or the user stops). Before every dispatch re-read `<PLAN>`; if it changed since the last check, run Plan change control (§6) first.

**Ready set** = `PENDING` tasks whose dependencies are all `MERGED`.

**Single-writer rule for the main working tree:** at most one `sub-worker-main` (any mode) runs at a time. `sub-worker-wt` tasks may run concurrently with it (their ownership is disjoint by plan-check).

1. **Worktree tasks** (`Workspace: worktree`) in the ready set, up to the concurrency limit (default **3**): dispatch one `sub-worker-wt` each, all in one response, with `base_sha` = `current_head`, worktree path and branch as above, plan hash/revision, full task text (template). Model: `claude-haiku-5.5` unless the task has `**Model:**` or you escalate (§5).
2. **Main tasks** (`Workspace: main`) in the ready set: if no `sub-worker-main` is running, dispatch one (`mode: task`, `expected_head` = `current_head`). Others wait.
3. Wait for completion notifications; `read_agent` finished agents (all of a parallel batch together). Process each report:
   - **HANDOFF review (evidence, not trust):** `status: DONE`; `plan_revision`/`task_hash` match the snapshot; `ownership_check: OK` and `changed_files` ⊆ `owns`; `method:` equals the plan task's Method (legacy `TDD: exempt` → `mechanical`) and `method_evidence:` is present; verification passed; `acceptance` maps every AC to evidence — a test for tdd/refactor, otherwise file:line or command output; `report:` is present and the file exists. Anything missing → send back via `write_agent` with the specific gap.
   - `BLOCKED` or `NEEDS-INPUT` → answer from the plan/Working Memory if the answer is already agreed; otherwise ask the user; then `write_agent` the answer to the same Worker. `STALE` → §6. `FAILED` → §5.
   - Main task DONE → its commit is on `<TARGET>`: status `MERGED`, `current_head` = `commit_sha`. A task with no new commit (`commit_sha` is `none` or equals `base_sha`) is also `MERGED`, keeps `current_head` and records no merge sha; it gets no per-task code review: Main checks `method_evidence` in the HANDOFF gate.
   - Worktree task DONE → status `VERIFIED` (awaiting integration).
   - `Review: per-task` → dispatch `sub-reviewer-code` with the template in `references/reviewer-dispatch.md` (`design_path` = the value of the `- Design file:` line in plan.md `## Engineering Assessment`, or `none` if that line is absent; `asis_map_path` and `target_map_path` = the values of the `- Current-state map:` and `- Target map:` lines there, each `none` if its line is absent), `model: claude-sonnet-5.5`, `reasoning_effort: high`, before marking MERGED/VERIFIED (not for tasks without a new commit); `CHANGES_REQUIRED` → back to the same Worker with the findings; the Worker's fix then goes to the same reviewer via `write_agent` as a delta re-review.
4. **Integration:** removing the worktree of a successfully merged task is part of integration and already approved by `/1implement` — always pass `remove_merged_worktrees: yes` (only `wf/*` branch deletion needs the user's approval). When one or more worktree tasks are `VERIFIED` and no `sub-worker-main` is running (prefer integrating a whole wave at once, but do not block ready main tasks for long), dispatch `sub-worker-main` `mode: integrate` with the VERIFIED tasks in dependency order (template). Process the INTEGRATION REPORT:
   - merged entries → `MERGED` (record merge sha), `current_head` = report `head`; each must report `worktree: removed` — otherwise ask the Worker to finish cleanup;
   - `GATE-FAIL` / `VERIFY-FAILED` → back to the task's `sub-worker-wt` (`write_agent`, `reuse: yes`) with the evidence, then integrate again;
   - `CONFLICT` it could not resolve → status `BLOCKED`, explain both sides and the options to the user, decide together against the plan (adjust plan via `/1make-plan` if requirements change), then re-dispatch.
5. Update `<STATE>` after every report (statuses, heads, agent ids, models, attempts, evidence summaries, event log).

**Keep the user informed** (follow "Communicating with the user" in your agent instructions):
- When a wave starts: what each task builds, in plain words, and why these tasks run now (dependencies).
- When you process a Worker or Reviewer report: what was built or found, what the tests and the review prove (and what they do not prove), any deviation from the plan and why, and what you decided.
- Failures, escalations, integration conflicts and plan drift: explain them when they happen.
- No waiting-only messages and no bare lists of IDs and commit SHAs; always pair an ID with its plain-language name.

## 4. Dispatch hygiene
- Every Worker prompt is built from `worker-dispatch.md`, contains the verbatim task block, never asks the Worker to read the whole plan, and requests the HANDOFF / report structure.
- Never dispatch two `sub-worker-main`s at once. Never give two Workers overlapping ownership at the same time.
- Never let a Worker continue after the plan changed (§6).

## 5. Failures and model escalation
- Attempt 1 uses `claude-haiku-5.5`. On `FAILED`, rejected handoff or failing verification: dispatch `sub-explorer-debug` (with the working tree path) when the cause is unclear, then retry with the diagnosis (prefer `write_agent` to the same idle Worker; otherwise re-dispatch; worktree tasks with `reuse: yes`).
- Escalate to `claude-sonnet-5.5` only when Haiku has failed twice on the task, or the Worker/diagnosis shows the task exceeds Haiku, or the user asks. Record the reason in `<STATE>`.
- If the Sonnet attempt fails: status `BLOCKED`, stop dispatching dependents, and ask the user (change plan, split task, other approach, abort).

## 6. Plan change control (drift)
Triggers: a Worker returns `STALE`; `<PLAN>` changed since your last read; the user edits the plan or requests a change; a `/1make-plan` revision during implementation.
1. **Freeze**: no new dispatches or integrations. Phase `PAUSED (plan drift)`.
2. Dispatch `sub-explorer-code` to run `plan-check.ps1 -PlanPath <PLAN> -Compare <SNAP>` and return `ok`, `errors`, `revision` and the whole `drift` object verbatim.
3. Running Workers on affected tasks: `write_agent` "STOP — plan changed (r<old> → r<new>); do not commit further; return your current state." Tell the user they can also cancel them in `/tasks`.
4. Classify: `affectedTasks`/`addedTasks` (direct), `downstreamTasks`, `removedTasks`; `scopeChanged` → treat all unmerged tasks as affected and re-confirm scope with the user. Mark unmerged affected tasks `STALE` (their worktrees are reused or recreated on re-dispatch), merged affected tasks `NEEDS-REWORK` (follow-up task or revert — ask the user), removed tasks `CANCELLED` (revert if merged, with consent).
5. The new revision must be valid (`ok`), bumped, and confirmed by the user. Then dispatch `sub-explorer-code` again for the full plan-check JSON of the new revision and save it with `create` as the new `<SNAP>` (`plan-snapshot-r<new>.json`); update `<STATE>` and resume. Unaffected tasks keep their status.

## 7. External writes
Execute `## External Writes` items when their `after` tasks are `MERGED` (or at the end): dispatch `sub-expert-ado-writer` with an `AUTHORIZED WRITE` block (authorization: `W<n>` of plan revision <N>). Record IDs/URLs/before-after in `<STATE>`. `REFUSED`/`CONFLICT`/`UNSUPPORTED` → report to the user; never retry with altered content without approval.

## 8. Final verification and review
1. Phase `VERIFYING`. Dispatch `sub-worker-main` `mode: verify` with the final verification commands and the AC list (compare with baseline: new vs pre-existing failures).
2. Dispatch `sub-reviewer-code` with the final-review template in `references/reviewer-dispatch.md` (`design_path` = the `- Design file:` value of plan.md `## Engineering Assessment`, or `none` if that line is absent; `asis_map_path` and `target_map_path` = the `- Current-state map:` and `- Target map:` values there, each `none` if its line is absent), `model: claude-sonnet-5.5`, `reasoning_effort: high`, on `<REPO>` range `<setup head>..<current_head>`, with the conflict resolutions from the integration reports and the verification results. Its verdict decides step 3.
3. `CHANGES_REQUIRED` (Critical/Warning): add fix tasks (`T<n>-fix<k>`, normally `Workspace: main`), run them through §3, then re-verify and re-review the delta with `write_agent` to the same `sub-reviewer-code` (delta range; `references/reviewer-dispatch.md`, Follow-ups). Suggestions are reported, not auto-fixed.
4. Every AC needs passing evidence from fresh runs. No evidence → not done.

## 9. Report and hand back
Phase `DONE` (or `PARTIAL` with reasons). Report:
- outcome; plan revision; `<TARGET>` range `<setup head>..<current_head>`
- **how it works now**: a plain explanation of the finished change (flow, main components, behaviour changes), with references (path:line @ commit) the user can open during code review
- task table: id, what it does (plain words), workspace, status, model (default/escalated + reason), attempts, commit/merge sha, review
- **what to check in your review**: the riskiest parts, decisions made during implementation, deviations from the plan and why
- verification: commands → results (baseline vs final); IDE checks
- review verdict and open findings; conflict resolutions; external writes with IDs/URLs
- known issues, follow-ups; leftover worktrees/branches
- next-step options (the user decides): push + PR (only on explicit approval); keep for manual review; clean up `wf/<SLUG>/*` branches (a `sub-worker-main` does it on approval); undo (reset `<TARGET>` to the setup head — destructive, only on explicit approval)
Update plan `**Status:**` (`DONE`/`PARTIAL`) and suggest `/save`. Return to Brainstorm mode.

## State discipline
- `<STATE>` is updated after every state change (dispatch, report, review, integration, drift, escalation, verification, write). It must always be sufficient to resume after compaction.
- Keep raw outputs out of `<STATE>` and `plan.md`; store large evidence under `<SF>\files\evidence\` and link it.
