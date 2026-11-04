---
name: util-toponly
description: Top-level-only fixture agent with powershell and no cli-tools file (model: gpt-x)
model: gpt-x
disable-model-invocation: true
tools:
  - powershell
  - view
---

# util-toponly

## Shell discipline

Fixture agent for the AGT-CLITOOLS exemption. It runs only as a top-level agent (--agent), so it has no cli-tools file on purpose.
