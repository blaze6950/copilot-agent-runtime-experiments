---
name: 1main
description: Main orchestrator for the synthetic fixture (model: gpt-x)
model: gpt-x
tools:
  # shell
  - powershell
  - agent
  - view
---

# 1main

## Shell discipline

Use the shell only for git and build commands.
