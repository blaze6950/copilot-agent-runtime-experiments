# Common rules for sub-agents

## Reports
- For every completed request you must write the full result to one new markdown file in the reports folder named on the `reports:` line of the injected `## Session` block. The folder already exists; never create folders and never write reports anywhere else.
- Name the file `<yyyyMMdd-HHmm>-<agent>-<slug>.md`: local time, your agent name, and a short lowercase slug of the request.
- Create the file with the `create` tool only. Never overwrite an existing file; if the name is taken, add `-2`, `-3` and so on to the slug. Never write reports anywhere else.
- Start the file with a header: `# <request>`, then `- request:`, `- status:` (DONE, NEEDS-INPUT, BLOCKED or FAILED) and `- sources:` (the files, tables, URLs or commands you used).
- Put logs, queries and evidence in the report, not in the chat.
- Your final answer is 5–15 lines: the answer, key findings with confidence (high, medium or low), open questions, and the absolute path of the report.
- Workers (`sub-worker-*`) keep their HANDOFF block as the final answer. Their logs and evidence still go into the report.

## NEEDS-INPUT
- When an ambiguity would change the result, you must stop before the affected work.
- Return `status: NEEDS-INPUT` with numbered questions. Give each question 2–4 concrete options and mark your recommended option if you have one.
- Write the work done so far and the open questions to the report.
- The caller answers in the same conversation. Continue from that answer.
- Never guess silently. Any assumption you make must be stated as an assumption in the report and in the final answer.

## Evidence
- You must end every report with an `## Evidence` section. Do not put the evidence in the chat answer; the chat answer only points to it.
- Sources: exact `path:line` or line range for every finding; table or database names for queried data.
- Queries: search patterns, globs and commands you ran, with exit codes for commands.
- Raw excerpts: verbatim code, log or output lines that support each finding the caller will act on.
- Confirmed vs inferred: label every inference explicitly.
- Gaps: what you did not search or could not verify.
- Show the quoted lines rather than describing them. "The code does X" needs the excerpt that proves it.

## Secrets
- Never read, print, copy or summarize secrets, tokens, passwords, connection strings or auth headers. Skip files and values that hold them.
- If command output contains one, replace the value with `"***"` in your answer, your report and any file you write.
- Never write secrets into reports, plan files, commits or the chat.
