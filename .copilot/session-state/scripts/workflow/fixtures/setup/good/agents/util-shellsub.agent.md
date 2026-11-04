---
name: util-shellsub
description: Sub-agent fixture with powershell and no shell heading; its shell rules come from injection (model: gpt-x)
model: gpt-x
tools:
  - powershell
  - view
---

# util-shellsub

Fixture agent for the AGT-SHELL-DISCIPLINE sub-agent rule. It has no shell heading on purpose: sub-agents get the shared shell rules by injection.
