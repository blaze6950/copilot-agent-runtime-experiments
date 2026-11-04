---
name: 1make-plan
description: "Main-agent workflow phase. Turns the requirements and decisions agreed during brainstorming into an implementation-ready plan.md: context, acceptance criteria, engineering assessment, task boundaries, workspaces, dependencies, file ownership and parallel waves. Invoke explicitly with /1make-plan (built-in /plan is reserved by the CLI)."
disable-model-invocation: true
---

# /1make-plan — formalize the agreed plan

You are `1main`. If you are not the `1main` agent (you cannot dispatch `sub-worker-main`), stop and tell the user: "Switch with `/agent 1main`, then run `/1make-plan` again."

Announce: "Planning phase: formalizing the agreed decisions into plan.md." Arguments typed after `/1make-plan` are extra instructions from the user for this plan.

## Ground rules
- **Transcribe agreed decisions; do not invent.** Encode what was decided in Working Memory and the conversation. Do not add scope, features or approaches that were not agreed.
- **Do not decide for the user.** Any decision that materially changes the plan and is not settled goes to the user (one focused question at a time, `ask_user` with options when possible) or into `## Unresolved Decisions`.
- **Convergence check:** if brainstorming has not converged (no clear objective, key decisions missing), or you would need more than one clarifying question to write the plan, say so, list what is missing, and stay in Brainstorm mode. Do not write a plan.
- **Deterministic:** the same agreed context must produce the same plan. Be definitive: no "consider", "maybe", "TODO", "adjust as needed".
- **Principal-engineer quality:** the plan must reflect the engineering standard in your agent instructions (code-base-aligned, maintainable, extensible at real variation points, testable, secure). If an agreed decision conflicts with that standard, state it in `## Engineering Assessment` and confirm with the user before finalizing.

## Step 1 — Readiness check
Read `plan.md`. List (to yourself, concisely): decisions to encode (Decisions Made / Architectural Conclusions), open questions and assumptions that affect the plan, and the target branch. Ask about blocking items before writing tasks. Non-blocking items may be recorded under `## Unresolved Decisions`; a plan with unresolved decisions stays `DRAFT` and cannot be implemented.

## Step 2 — Fill factual gaps (prescriptive, parallel, background)
Dispatch only for facts the plan needs, e.g.:
- `sub-explorer-code`: exact files/symbols to change, existing tests and their location, build/test commands, project conventions and patterns to follow, shared hot-spots (DI registration, project files, routing tables), current branch and working-tree state of the repository.
- keepers (`sub-expert-*`): work item acceptance criteria, API contracts, environment facts.
Reject results without evidence for facts you rely on. The facts the plan relies on go into `## Context` with their sources.

## Step 3 — Write the high-level plan
Write the `# Plan` section without tasks: Title, Revision, **Status:** DRAFT, Updated, Repository, Target branch, Base ref; `## Goal`, `## Scope` (In/Out), `## Context` (facts with sources), `## Constraints`, `## Decisions`, `## Engineering Assessment` (approach rationale, trade-offs, risks, rejected alternatives), `## Acceptance Criteria` (numbered `AC-<n>`, observable and testable) and `## Unresolved Decisions`. Under `## Scope`, add a feature-level outline: the feature slices, what each one changes at component level, and which slices are independent of each other. Do not name files, tasks, workspaces or waves here: the implementation planner decides them in Step 4. Write this high-level plan into plan.md's `# Plan` section in the format of Step 6 (without tasks), because the planner reads it there.

## Step 4 — Implementation planner (background, delegated)
Dispatch `sub-planner-implementation` with `mode: "background"`, `model: claude-opus-5.5` and `reasoning_effort: high`. The prompt gives:
- the absolute `plan.md` path (`# Plan` and `# Working Memory`);
- the absolute output path for this version, `<session folder>\files\plan-tasks-r<N>.md` (a correction uses `-2`, `-3`, … as a new path); the planner writes only the paths you give;
- the absolute as-is map path `<session folder>\files\map-asis-r<N>.md` and the target map path `<session folder>\files\map-target-r<N>.md` (you name the `r<N>` paths of a new revision only; the planner names the next `-<k>` version of any map itself and never overwrites a file; for a revision that reuses maps you pass the latest existing paths as existing maps, see Step 8);
- the report paths that hold the facts the design needs, each with a one-line note of what it proves (Step 2);
- the repository path (the main working tree).

The planner works in two phases (`agents/sub-planner-implementation.agent.md`). **Phase 1** writes the as-is map, runs `map-check.ps1` until exit 0 and stops with `NEEDS-INPUT` for the user's review of that file. **The Opus prompt cache expires after about 5 minutes, so ask the user immediately.** Give the user only: the file path of the last as-is version (open it in VS Code with the Markdown preview) and what to check (is anything wrong or missing; known pain points in this code). Ask one `ask_user` question with the options "Looks right" (recommended), "I edited the file" and "Corrections in text", and an optional free-text field for the known pain points next to it, so that the pain points are not lost on "Looks right". Never summarise or redraw the map and never retell its content. Relay the answer and the pain points to the same planner with `write_agent` (for "I edited the file": say so; the planner reads the file from disk with `view` and re-checks it; for "Corrections in text": pass the text; the planner verifies it against the code, writes the corrected as-is map as the next `-<k>` version and reports the final path). Read the final as-is map path from the planner's answer; that is the path for the `- Current-state map:` line. **Phase 2** writes the target map and the tasks file. If the planner agent is gone ("Agent not found"), dispatch a new `sub-planner-implementation` directly into Phase 2: pass the existing as-is map path and state that it was reviewed by the user.

The planner applies its own task rules (`agents/sub-planner-implementation.agent.md`, section "Rules for the task blocks"). On any other `NEEDS-INPUT`, answer with `write_agent` to the same agent. Answer what the accepted decisions or the reports already settle; ask the user (`ask_user`, one question, options, recommended option marked) only for real decisions: scope, behavior or accepted decisions. The planner writes the tasks file with `## Integration design` and `## Tasks`; read that file and the planner's report.

Task rules: the planner applies its task-block rules (unit, workspaces, worktree Methods, file ownership, dependencies, Model, Review, Verify), defined once in `agents/sub-planner-implementation.agent.md`, section "Rules for the task blocks". Main checks the result in Step 5.

## Step 5 — Principal-engineer self-review (before writing)
Challenge the high-level plan, the planner's `## Integration design` and its tasks against the engineering standard: fit with existing architecture and conventions, simplicity vs. extensibility, testability, failure modes and security, backward compatibility/migration, operability, delivery risk, and whether the task split and workspaces minimize integration cost. Fix what you can within the agreed decisions; send task-level defects back to the planner with `write_agent`; surface the rest in `## Engineering Assessment` and ask the user when a trade-off needs their decision.

Check the planner's `## Tasks` before Step 6: every task has one valid `Method` (`tdd`, `refactor`, `mechanical`, `git-ops` or `verify`); worktree tasks use only `tdd`, `refactor` or `mechanical`; `Owns` is exclusive or ordered by `Depends on`; every AC is covered; the accepted decisions and the scope are unchanged. **Map coverage:** every `added`, `changed` or `removed` element of the target map appears in the `Map` line of some task, and every `Map` entry exists in the target map (read the target map file; do not redraw it). Corrections go back with `write_agent`, and each correction names a NEW output path `<session folder>\files\plan-tasks-r<N>-<k>.md` (k = 2, 3, …); the planner never rewrites an earlier version.

## Step 6 — Write the `# Plan` section of plan.md
Replace only the `# Plan` section (everything above the `---` that precedes `# Working Memory`). Preserve Working Memory exactly. Copy the planner's `## Tasks` from the latest output file you named (the highest `-<k>` version; earlier versions stay on disk) into `## Tasks` after your Step 5 check (a task that breaks a decision or the scope goes back to the planner). Put the integration design summary and the `- Design file:`, `- Current-state map:` and `- Target map:` lines (the paths of the latest versions; `none` when the plan has no map) into `## Engineering Assessment`. Use this format — `plan-check.ps1` parses it:

```markdown
# Plan
**Title:** <short title>
**Revision:** <integer, start at 1>
**Status:** DRAFT
**Updated:** <YYYY-MM-DD>
**Repository:** <absolute repo path (main working tree)>
**Target branch:** <branch checked out in the main working tree that receives all work>
**Base ref:** <branch or commit the work starts from>

## Goal
<one or two sentences>

## Scope
- In: ...
- Out: ...

## Context
- <fact the plan relies on> — source: <file:line / ID / URL>

## Constraints
- <technical/organizational constraints that bind implementation>

## Decisions
- <decision> — see Working Memory "Decisions Made"

## Engineering Assessment
- Integration design: <summary of the planner's `## Integration design`: actors and entry points, reused helpers with path:line, extension points, refactorings, shared hot-spot owners; 5–10 lines>
- Design file: <absolute path of the latest planner output file, `<session folder>\files\plan-tasks-r<N>.md` or `<session folder>\files\plan-tasks-r<N>-<k>.md`, or `none`>
- Current-state map: <absolute path of the latest as-is map version, `<session folder>\files\map-asis-r<N>[-<k>].md`, or `none`>
- Target map: <absolute path of the latest target map version, `<session folder>\files\map-target-r<N>[-<k>].md`, or `none`>
- Approach rationale: <why this design is right for this code base>
- Trade-offs accepted: <...>
- Risks and mitigations: <...>
- Alternatives rejected: <alternative — reason>

## Acceptance Criteria
- AC-1: <observable, testable statement>

## Unresolved Decisions
- none

## Tasks
### T1: <title>
- **Depends on:** none
- **Workspace:** main
- **Owns:** `relative/path/File.cs`, `tests/relative/path/FileTests.cs`
- **Reads:** `relative/path/Other.cs`
- **Acceptance:** AC-1
- **Method:** <tdd|refactor|mechanical|git-ops|verify>
- **Map:** <names of the target-map elements the task adds, changes or removes (elements only, not edges), or `none` for a task that builds no mapped element (verify, git-ops, pure test or documentation task)>
- **Tests:** <what the Method requires: tdd: tests to write first (RED) and the behavior they assert; refactor: covering tests run before and after; mechanical: Verify run before and after; git-ops: exact commands and expected state; verify: exact check and expected result>
- **Implementation notes:** <interfaces/signatures/contracts, conventions and existing patterns to follow>
- **Verify:** `<exact focused test command>`
- **Model:** default
- **Review:** final

## External Writes
- none            (or: - W1: <operation> <target> — content: "<exact>" — after: T3)

## Execution Graph
<from plan-check: waves; worktree tasks in a wave run in parallel, main tasks run one at a time>

## Final Verification
- `<build command>`
- `<full or relevant test suite command>`

## Revision History
- r1 <date>: initial plan
```
Rules: paths in `Owns`/`Reads` are repo-relative and backticked; `Depends on` uses task ids or `none`; `Method` is required on every task: `tdd` (behavior change, RED test first), `refactor` (behavior unchanged; covering tests pass before and after), `mechanical` (renames, version bumps, docs, config; `Verify` before and after), `git-ops` (local git operations; `main` only), `verify` (checks only, changes no files; `main` only). Worktree tasks use only `tdd`, `refactor` or `mechanical`. A task without executable tests is `mechanical`, and its `Verify` must still be a real check. Optional `- **IDE:** required`. `- **Map:**` lists the target-map elements of the task (copied from the planner's task block; `none` for a task that builds no mapped element: `verify`, `git-ops`, or a pure test or documentation task). `## External Writes` lists `W<n>` items with exact target and content (or `none`); they are executed only by `sub-expert-ado-writer` during `/1implement`.

## Step 7 — Validate with plan-check (mandatory, delegated)
Dispatch `sub-explorer-code` to run
`pwsh -NoProfile -File "$HOME\.copilot\session-state\scripts\workflow\plan-check.ps1" -PlanPath "<session folder>\plan.md"`
and return verbatim: exit code, `ok`, `errors`, `warnings`, `unresolvedDecisions`, `waves`, and each task's `id`/`workspace`/`hash`.
- Exit 0 is required. Fix every error in the non-task sections of `# Plan` yourself and re-validate. Task-level errors (unknown or cyclic dependencies, missing fields, ownership conflicts between unordered tasks, invalid Method or workspace) go back to the planner via `write_agent` as a correction with a new output path (Step 5); then copy its corrected `## Tasks` from that latest file into `# Plan`, and re-validate. Never weaken the plan to pass.
- Copy the waves into `## Execution Graph` (e.g. `Wave 1: T1 (main) → Wave 2: T2, T3 (worktree, parallel)`). Address warnings (e.g. AC not covered).

## Step 8 — Revisions of an existing plan
- If a `# Plan` already exists, update it in place. Increment `**Revision:**` when requirements change (goal, scope, context, constraints, ACs, tasks); add a `## Revision History` line describing what changed. A change to goal, scope, context, constraints, ACs or decisions re-runs Steps 3 and 4 for the new revision (the planner writes `files\plan-tasks-r<N>.md`). A task-only revision re-runs the same planner via `write_agent` with the new revision's output path (`files\plan-tasks-r<N>.md` for the new `<N>`).
- **Maps in a revision:** one rule: you name `r<N>` map paths only for a new revision; the planner names every `-<k>` version. A task-only revision passes the latest as-is and target map paths (from `- Current-state map:` and `- Target map:`) as existing maps, with no new as-is review by the user; the planner writes a new `-<k>` target version only if the target structure changes, and reports the paths. A revision of goal, scope, context, constraints, ACs or decisions passes new `r<N>` paths for both maps, unless the touched code area looks unchanged: then you propose reuse (based on the changed feature outline) and pass the existing as-is map as input (and a new `r<N>` target path). The planner confirms: it re-reads the code and states whether the as-is map still covers the touched area; if not, it returns `NEEDS-INPUT` asking for a new as-is review, and you name a new `r<N>` as-is path and relay the question to the user as in Step 4. After every planner answer, record the paths it reports in `- Current-state map:` and `- Target map:`.
- If `implementation-state.md` shows Phase `IMPLEMENTING`/`PAUSED`, also follow "Plan change control" in `C:\Users\USER\.copilot\skills\1implement\SKILL.md` to handle affected tasks.

## Step 9 — Present and stop
Show the user (follow "Communicating with the user" in your agent instructions; the chat must be enough to understand the plan without opening `plan.md`):
- goal and scope in plain words;
- **how the solution works**: the design explained so the user can picture it (flow, components touched, data), with a short example;
- **engineering assessment**: why this design, rejected alternatives and why, the best practices and code-base conventions it follows (named and briefly explained), main risks and trade-offs;
- the decisions the plan encodes, separated from assumptions, and who accepted each decision;
- the paths of the current-state map and the target map (or `none`), for the user to open in VS Code; do not retell or redraw them;
- AC list; the integration design in plain words (where the code goes, reused helpers, extension points, refactorings);
- a task table (id, **what it does in plain words**, workspace, method, depends on, wave, owns, model, review) and why the waves are in this order;
- external writes; unresolved decisions and open questions (blocking or not); plan-check result;
- for a revision: what changed compared with the previous revision, and why.
Set `**Status:** DRAFT`. Then tell the user (and suggest `/save` if decisions made since the last save are not yet in Working Memory):
> Review or edit `plan.md` (it is authoritative). When you are ready, run `/1implement`.

Do **not** dispatch Workers or change project files or git state in this phase.
