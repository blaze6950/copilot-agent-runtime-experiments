# Plan
**Title:** Sample
**Revision:** 2
**Status:** APPROVED
**Updated:** 2026-10-16
**Target branch:** feature/greeting

## Goal
Add greeting feature.

## Scope
In: greeter. Out: UI.

## Acceptance Criteria
- AC-1: Greeter returns "hi <name>".
- AC-2: CLI prints greeting.

## Unresolved Decisions
- none

## Tasks
### T1: Greeter core
- **Depends on:** none
- **Owns:** `src/Greeter.cs`, `tests/GreeterTests.cs`
- **Acceptance:** AC-1
- **Verify:** `dotnet test --filter Greeter`
- **Method:** tdd
- **Workspace:** worktree

### T2: CLI wiring
- **Depends on:** T1
- **Owns:** `src/Program.cs`, `src/Greeter.cs`
- **Acceptance:** AC-2
- **Verify:** `dotnet test --filter Cli`
- **Method:** tdd
- **Model:** claude-sonnet-5.5
- **Workspace:** main

### T3: Docs
- **Depends on:** none
- **Owns:** `README.md`
- **Acceptance:** AC-2
- **Verify:** `pwsh -c "Test-Path README.md"`
- **Method:** tdd
- **Review:** per-task
- **Workspace:** worktree

## Execution Graph
wave noise that must not affect hashes

## Revision History
- r1 initial

---

# Working Memory
## Current Objective
whatever
