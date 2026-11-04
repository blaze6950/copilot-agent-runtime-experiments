import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createSessionContext,
    FRESHNESS,
    MAIN_AGENT_FALLBACK,
    UNKNOWN_SUBAGENT,
} from '../../extensions/shell-governor/lib/session-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM = join(HERE, 'fixtures', 'events', 'session-stream.jsonl');
const SESSION_START = Date.parse('2026-01-01T10:00:00.000Z');
const OLD = SESSION_START - 3_600_000;
const NEW = SESSION_START + 60_000;
const FIXTURE_CWD = '/synthetic/session-cwd';

/** Fake file system: listed paths exist with the given mtime; every other path is missing. */
function fakeFs(entries) {
    const files = new Map(Object.entries(entries).map(([p, mtimeMs]) => [resolve(p), { mtimeMs }]));
    return (p) => files.get(resolve(p)) ?? null;
}

/** Reads the synthetic session stream fixture, one event per line. */
function readStream() {
    return readFileSync(STREAM, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
}

test('Context_SubagentStarted_ResolvesAgentNameAndDispatchPrompt', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });

    // Act
    for (const event of readStream()) ctx.observe(event);
    const judge = await ctx.judgeContext('agent-A');

    // Assert
    assert.equal(await ctx.agentName('agent-A'), 'sub-synthetic-reviewer');
    assert.deepEqual(judge, {
        source: 'dispatch-prompt',
        agentName: 'sub-synthetic-reviewer',
        dispatchPrompt: 'Synthetic dispatch prompt: review the change set.',
    });
});

test('Context_TaskDispatchedAfterSubagentStarted_ResolvesDispatchPrompt', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    const started = {
        type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: 'agent-B',
        data: { toolCallId: 'call-task-2', agentName: 'sub-synthetic-writer', agentDisplayName: 'Writer' },
    };
    const dispatch = {
        type: 'tool.execution_start', timestamp: '2026-01-01T10:00:02.000Z', agentId: null,
        data: { toolCallId: 'call-task-2', toolName: 'task', arguments: { prompt: 'Synthetic late prompt.' } },
    };

    // Act
    ctx.observe(started);
    ctx.observe(dispatch);
    const judge = await ctx.judgeContext('agent-B');

    // Assert
    assert.deepEqual(judge, {
        source: 'dispatch-prompt',
        agentName: 'sub-synthetic-writer',
        dispatchPrompt: 'Synthetic late prompt.',
    });
});

test('Context_UnknownSubagent_UsesPlaceholderNameAndUserMessages', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    ctx.observe({ type: 'user.message', timestamp: '2026-01-01T10:00:01.000Z', agentId: null, data: { content: 'synthetic question' } });

    // Act
    const judge = await ctx.judgeContext('agent-never-started');

    // Assert
    assert.equal(await ctx.agentName('agent-never-started'), UNKNOWN_SUBAGENT);
    assert.deepEqual(judge, { source: 'user-messages', agentName: UNKNOWN_SUBAGENT, userMessages: ['synthetic question'] });
});

test('Context_MainAgent_UsesRuntimeNameWithFallback', async () => {
    // Arrange
    const resolved = createSessionContext({ resolveMainAgentName: async () => 'orchestrator' });
    const rejected = createSessionContext({ resolveMainAgentName: async () => { throw new Error('rpc down'); } });
    const blank = createSessionContext({ resolveMainAgentName: async () => '   ' });
    const absent = createSessionContext();

    // Act and Assert
    assert.equal(await resolved.agentName(null), 'orchestrator');
    assert.equal(await rejected.agentName(undefined), MAIN_AGENT_FALLBACK);
    assert.equal(await blank.agentName(null), MAIN_AGENT_FALLBACK);
    assert.equal(await absent.agentName(null), MAIN_AGENT_FALLBACK);
});

test('Context_MainAgent_ResolvedNameIsCached', async () => {
    // Arrange
    let calls = 0;
    const ctx = createSessionContext({ resolveMainAgentName: async () => { calls++; return 'orchestrator'; } });

    // Act
    await ctx.agentName(null);
    const name = await ctx.mainAgentName();

    // Assert
    assert.equal(name, 'orchestrator');
    assert.equal(calls, 1);
});

test('Context_MainAgent_ResolvedNameIsReResolvedAfterTtl', async () => {
    // Arrange (F5): the user switches the agent; switching back to the default agent yields no name and falls back to "main"
    let now = 1_000_000;
    const names = ['orchestrator', 'other-agent', null];
    let calls = 0;
    const ctx = createSessionContext({ clock: () => now, resolveMainAgentName: async () => names[calls++] });

    // Act
    const first = await ctx.agentName(null);
    now += 999;
    const withinTtl = await ctx.agentName(null);
    now += 1;
    const afterTtl = await ctx.agentName(null);
    const callsAfterSecond = calls;
    now += 1000;
    const backToDefault = await ctx.agentName(null);

    // Assert
    assert.equal(first, 'orchestrator');
    assert.equal(withinTtl, 'orchestrator');
    assert.equal(afterTtl, 'other-agent');
    assert.equal(callsAfterSecond, 2);
    assert.equal(backToDefault, MAIN_AGENT_FALLBACK);
    assert.equal(calls, 3);
});

test('Context_MainAgent_FailedResolutionIsRetried', async () => {
    // Arrange
    let calls = 0;
    const ctx = createSessionContext({
        resolveMainAgentName: async () => {
            calls++;
            if (calls === 1) throw new Error('rpc not ready');
            return 'orchestrator';
        },
    });

    // Act
    const first = await ctx.agentName(null);
    const second = await ctx.agentName(null);

    // Assert
    assert.equal(first, MAIN_AGENT_FALLBACK);
    assert.equal(second, 'orchestrator');
});

test('Context_UserMessages_KeepsLastNWithinSizeCap', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    const messages = ['m1', 'm2', 'm3', 'm4', 'm5', 'L'.repeat(3000)];

    // Act
    for (const [i, content] of messages.entries()) {
        ctx.observe({ type: 'user.message', timestamp: `2026-01-01T10:00:0${i}.000Z`, agentId: null, data: { content } });
    }
    const judge = await ctx.judgeContext(null);

    // Assert
    assert.equal(judge.source, 'user-messages');
    assert.equal(judge.userMessages.length, 5);
    assert.deepEqual(judge.userMessages.slice(0, 4), ['m2', 'm3', 'm4', 'm5']);
    assert.equal(judge.userMessages[4].length, 2000);
    assert.equal(judge.userMessages[4], 'L'.repeat(2000));
});

test('Context_EditCreateApplyPatch_MarksFilesFresh', () => {
    // Arrange
    const paths = {
        edited: resolve(FIXTURE_CWD, 'src/edited.txt'),
        created: resolve(FIXTURE_CWD, 'src/created.txt'),
        patched: resolve(FIXTURE_CWD, 'src/patched.txt'),
        added: resolve(FIXTURE_CWD, 'src/added.txt'),
        untouched: resolve(FIXTURE_CWD, 'src/untouched.txt'),
    };
    const ctx = createSessionContext({
        sessionStartMs: SESSION_START,
        statFile: fakeFs({ [paths.edited]: OLD, [paths.created]: OLD, [paths.patched]: OLD, [paths.added]: OLD, [paths.untouched]: OLD }),
    });
    const before = Object.values(paths).map((p) => ctx.scriptStatus(p));

    // Act
    for (const event of readStream()) ctx.observe(event);
    const after = Object.values(paths).map((p) => ctx.scriptStatus(p));

    // Assert
    assert.deepEqual(before, Array(5).fill(FRESHNESS.PRE_EXISTING));
    assert.deepEqual(after, [FRESHNESS.FRESH, FRESHNESS.FRESH, FRESHNESS.FRESH, FRESHNESS.FRESH, FRESHNESS.PRE_EXISTING]);
});

test('Context_ShellWriteTargets_MarkFilesFresh', () => {
    // Arrange
    const ctx = createSessionContext({ cwd: FIXTURE_CWD, sessionStartMs: SESSION_START, statFile: fakeFs({ [resolve(FIXTURE_CWD, 'out/report.txt')]: OLD }) });
    const target = resolve(FIXTURE_CWD, 'out/report.txt');
    const notYetWritten = resolve(FIXTURE_CWD, 'out/never.txt');
    const before = ctx.scriptStatus(target);

    // Act
    ctx.markWritten('out/report.txt');

    // Assert
    assert.equal(before, FRESHNESS.PRE_EXISTING);
    assert.equal(ctx.scriptStatus(target), FRESHNESS.FRESH);
    assert.equal(ctx.scriptStatus(notYetWritten), FRESHNESS.MISSING);
});

test('Context_PreExistingFile_StatusPreExisting', () => {
    // Arrange
    const oldFile = resolve('synthetic', 'old.ps1');
    const newFile = resolve('synthetic', 'new.ps1');
    const absent = resolve('synthetic', 'absent.ps1');
    const ctx = createSessionContext({
        sessionStartMs: SESSION_START,
        statFile: fakeFs({ [oldFile]: OLD, [newFile]: NEW }),
    });

    // Act and Assert
    assert.equal(ctx.scriptStatus(oldFile), FRESHNESS.PRE_EXISTING);
    assert.equal(ctx.scriptStatus(newFile), FRESHNESS.FRESH);
    assert.equal(ctx.scriptStatus(absent), FRESHNESS.MISSING);
});

test('Context_FirstEventTimestamp_SetsSessionStart', () => {
    // Arrange
    const justBefore = resolve('synthetic', 'before.ps1');
    const justAfter = resolve('synthetic', 'after.ps1');
    const ctx = createSessionContext({
        statFile: fakeFs({ [justBefore]: SESSION_START - 1, [justAfter]: SESSION_START + 1 }),
    });

    // Act
    ctx.observe({ type: 'session.start', timestamp: '2026-01-01T10:00:00.000Z', agentId: null, data: { context: {} } });

    // Assert
    assert.equal(ctx.scriptStatus(justBefore), FRESHNESS.PRE_EXISTING);
    assert.equal(ctx.scriptStatus(justAfter), FRESHNESS.FRESH);
});

test('Context_NoToolOutputsOrAssistantText_Stored', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });

    // Act
    for (const event of readStream()) ctx.observe(event);
    const mainJudge = await ctx.judgeContext(null);
    const subJudge = await ctx.judgeContext('agent-A');
    const exposed = JSON.stringify([mainJudge, subJudge, ctx.recentUserMessages()]);

    // Assert
    assert.deepEqual(mainJudge, {
        source: 'user-messages',
        agentName: MAIN_AGENT_FALLBACK,
        userMessages: ['synthetic user message 1', 'synthetic user message 2', 'synthetic user message 3'],
    });
    assert.equal(exposed.includes('TOOL-OUTPUT-SENTINEL'), false);
    assert.equal(exposed.includes('ASSISTANT-SENTINEL-TEXT'), false);
});

test('Context_SubagentRegistry_EvictsOldestBeyondCap', async () => {
    // Arrange
    const ctx = createSessionContext({ limits: { maxAgents: 2 }, sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    for (const id of ['a1', 'a2', 'a3']) {
        ctx.observe({ type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: id, data: { toolCallId: `call-${id}`, agentName: `n-${id}` } });
    }

    // Act and Assert
    assert.equal(await ctx.agentName('a1'), UNKNOWN_SUBAGENT);
    assert.equal(await ctx.agentName('a2'), 'n-a2');
    assert.equal(await ctx.agentName('a3'), 'n-a3');
});

test('Context_WrittenPaths_EvictsOldestBeyondCap', () => {
    // Arrange
    const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map((f) => resolve('synthetic', f));
    const ctx = createSessionContext({
        limits: { maxWrittenPaths: 2 },
        sessionStartMs: SESSION_START,
        statFile: fakeFs({ [a]: OLD, [b]: OLD, [c]: OLD }),
    });

    // Act
    ctx.markWritten(a);
    ctx.markWritten(b);
    ctx.markWritten(c);

    // Assert
    assert.equal(ctx.scriptStatus(a), FRESHNESS.PRE_EXISTING);
    assert.equal(ctx.scriptStatus(b), FRESHNESS.FRESH);
    assert.equal(ctx.scriptStatus(c), FRESHNESS.FRESH);
});

test('Context_TaskDispatch_CallerHasTaskNameAndDescription', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });

    // Act
    for (const event of readStream()) ctx.observe(event);
    const caller = await ctx.callerOf('agent-A');

    // Assert
    assert.deepEqual(caller, {
        agentId: 'agent-A',
        name: 'sub-synthetic-reviewer',
        type: 'synthetic',
        description: 'Synthetic reviewer',
        taskName: 'synthetic-review',
        taskDescription: 'Review the synthetic change set',
    });
});

test('Context_TaskDispatchedAfterSubagentStarted_CallerHasTask', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    const started = {
        type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: 'agent-B',
        data: { toolCallId: 'call-task-2', agentName: 'sub-synthetic-writer', agentDisplayName: 'Writer', agentDescription: 'Synthetic writer' },
    };
    const dispatch = {
        type: 'tool.execution_start', timestamp: '2026-01-01T10:00:02.000Z', agentId: null,
        data: {
            toolCallId: 'call-task-2',
            toolName: 'task',
            arguments: { name: 'synthetic-write', description: 'Write the synthetic report', prompt: 'Synthetic late prompt.' },
        },
    };

    // Act
    ctx.observe(started);
    ctx.observe(dispatch);
    const caller = await ctx.callerOf('agent-B');

    // Assert
    assert.equal(caller.taskName, 'synthetic-write');
    assert.equal(caller.taskDescription, 'Write the synthetic report');
});

test('Context_MainAgent_CallerHasNoTask', async () => {
    // Arrange
    const ctx = createSessionContext({ resolveMainAgentName: async () => '1main' });

    // Act
    const caller = await ctx.callerOf(null);

    // Assert
    assert.deepEqual(caller, { agentId: null, name: '1main', type: 'main', description: '', taskName: null, taskDescription: null });
});

test('Context_UnknownSubagent_CallerUsesHookTypeWithoutTask', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });

    // Act
    const withHookType = await ctx.callerOf('agent-Z', 'sub-hook');
    const withoutHookType = await ctx.callerOf('agent-Z');

    // Assert
    assert.deepEqual(withHookType, { agentId: 'agent-Z', name: 'sub-hook', type: 'sub-hook', description: '', taskName: null, taskDescription: null });
    assert.deepEqual(withoutHookType, { agentId: 'agent-Z', name: UNKNOWN_SUBAGENT, type: 'subagent', description: '', taskName: null, taskDescription: null });
});

test('Context_TaskWithPromptOnly_CallerHasNullTaskFields', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    ctx.observe({
        type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: 'agent-C',
        data: { toolCallId: 'call-task-3', agentName: 'sub-synthetic-prompt-only' },
    });
    ctx.observe({
        type: 'tool.execution_start', timestamp: '2026-01-01T10:00:02.000Z', agentId: null,
        data: { toolCallId: 'call-task-3', toolName: 'task', arguments: { prompt: 'Synthetic prompt only.' } },
    });

    // Act
    const caller = await ctx.callerOf('agent-C');

    // Assert
    assert.equal(caller.taskName, null);
    assert.equal(caller.taskDescription, null);
});

test('Context_TaskNameAndDescription_TrimmedAndCapped', async () => {
    // Arrange
    const ctx = createSessionContext({ sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    ctx.observe({
        type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: 'agent-D',
        data: { toolCallId: 'call-task-4', agentName: 'sub-synthetic-long' },
    });
    ctx.observe({
        type: 'tool.execution_start', timestamp: '2026-01-01T10:00:02.000Z', agentId: null,
        data: { toolCallId: 'call-task-4', toolName: 'task', arguments: { name: `  ${'n'.repeat(300)}`, description: 'd'.repeat(1500) } },
    });

    // Act
    const caller = await ctx.callerOf('agent-D');

    // Assert
    assert.equal(caller.taskName, 'n'.repeat(200));
    assert.equal(caller.taskDescription, 'd'.repeat(1000));
});

test('Context_TaskRegistry_EvictsOldestBeyondCap', async () => {
    // Arrange
    const ctx = createSessionContext({ limits: { maxDispatchPrompts: 2 }, sessionStartMs: SESSION_START, statFile: fakeFs({}) });
    for (const id of ['a1', 'a2', 'a3']) {
        ctx.observe({ type: 'subagent.started', timestamp: '2026-01-01T10:00:01.000Z', agentId: id, data: { toolCallId: `call-${id}`, agentName: `n-${id}` } });
        ctx.observe({ type: 'tool.execution_start', timestamp: '2026-01-01T10:00:02.000Z', agentId: null, data: { toolCallId: `call-${id}`, toolName: 'task', arguments: { name: `task-${id}` } } });
    }

    // Act
    const first = await ctx.callerOf('a1');
    const last = await ctx.callerOf('a3');

    // Assert
    assert.equal(first.taskName, null);
    assert.equal(last.taskName, 'task-a3');
});
