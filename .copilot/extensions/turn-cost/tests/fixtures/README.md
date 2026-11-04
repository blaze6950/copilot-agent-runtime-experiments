# Fixtures of the turn-cost accounting tests

## dispatch-turns.jsonl (real data)

- Source: the events of the Copilot CLI session `debcbd35-8e84-41de-a567-477b6963da56` (`session-state/<id>/events.jsonl`, not committed).
- Window: `2026-10-23T16:16:12.000Z` to `2026-10-23T16:29:31.400Z` (one user prompt, a keep-alive turn, agent-notice turns, five sub-agents, one of them still running at the end).
- Built with a jq program (whitelist; nothing else is copied): `session.usage_record` (model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, duration, timeToFirstTokenMs, copilotUsage.totalNanoAiu); root `user.message` (content reduced to `"[keepalive]"` or `"user prompt"`); root `system.notification` and `assistant.turn_start` (no data); `tool.execution_start` (toolCallId, toolName; for `task` also arguments.name and arguments.description); `tool.execution_complete` (toolCallId, success); `hook.start`/`hook.end` of type `preToolUse` (hookInvocationId, hookType, tool call ids, success); `subagent.started|completed|failed` (toolCallId, agentName, durationMs, cancelled); `permission.requested|completed` (requestId). Envelope: type, timestamp, agentId.
- Two substitutions, because the real event is live-only (not written to `events.jsonl`):
  - `session.usage_record` becomes `assistant.usage` (same payload).
  - the root `hook.end` of type `agentStop` becomes `session.idle`.
- No prompts, message texts, commands, file contents or paths are in the file.

## dialog-in-gov.jsonl (synthetic)

Ten lines, no agent id: a dialog (`elicitation`) inside the `preToolUse` window of one tool call. Elicitation events are never persisted by the CLI, so there is no real data for it.
