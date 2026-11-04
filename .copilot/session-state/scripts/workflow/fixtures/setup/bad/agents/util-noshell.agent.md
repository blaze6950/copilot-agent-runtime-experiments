---
name: util-noshell
description: Top-level fixture agent with powershell but no shell discipline heading (model: gpt-x)
model: gpt-x
disable-model-invocation: true
tools:
  - powershell
  - view
---

# util-noshell

Fixture agent for AGT-SHELL-DISCIPLINE. It runs only as a top-level agent and has no shell heading on purpose.
