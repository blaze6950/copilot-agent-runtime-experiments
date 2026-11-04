// T13 AC-14: the shipped config/agents.json keeps read-only sub-agents read-only outside their report files and session state.
// Production config (extension config folder, real directories.json) with synthetic home, copilot home and repo paths.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCatalogGroups } from '../../extensions/shell-governor/lib/catalog.mjs';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import { createGovernor } from '../../extensions/shell-governor/lib/governor.mjs';
import { compileDirectoryPolicy, pathVerdict, registerDirectoryPolicy } from '../../extensions/shell-governor/lib/paths.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createConfigSandbox } from './helpers/fixtures.mjs';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'shell-governor');
const PRODUCTION_AGENTS_PATH = join(EXTENSION_DIR, 'config', 'agents.json');
const PRODUCTION_DIRECTORIES_PATH = join(EXTENSION_DIR, 'config', 'directories.json');
const HOME = 'C:\\Users\\Tester';
const COPILOT_HOME = `${HOME}\\.copilot`;
const ENV = Object.freeze({ USERPROFILE: HOME, TEMP: `${HOME}\\AppData\\Local\\Temp`, APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local` });
const SESSION_ID = '0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e';
const REPO = 'C:\\code\\proj';
const EXPERT_AGENTS = [
    'sub-expert-ado', 'sub-expert-ado-writer', 'sub-expert-argocd-nonprod', 'sub-expert-argocd-prod', 'sub-expert-aws',
    'sub-expert-az', 'sub-expert-backstage', 'sub-expert-db', 'sub-expert-docs', 'sub-expert-edm', 'sub-expert-github',
    'sub-expert-gws', 'sub-expert-hetzner', 'sub-expert-k8s-nonprod', 'sub-expert-k8s-prod', 'sub-expert-miro',
    'sub-expert-newrelic', 'sub-expert-scalr', 'sub-expert-snow-nonprod', 'sub-expert-snow-prod', 'sub-expert-web',
];
const READ_ONLY_AGENTS = [
    'sub-explorer-code', 'sub-explorer-debug', 'sub-reviewer-code', 'sub-manager-history', 'sub-planner-implementation',
    ...EXPERT_AGENTS,
];
const READ_ONLY_EXAMPLE_AGENT = 'sub-explorer-code';
const WRITING_EXAMPLE_AGENT = 'sub-worker-main';
/** Agents that write (sub-worker-* and sub-manager-docs); they must carry no override. Fixed list: tests do not read the agents folder. */
const WRITING_AGENTS = ['sub-worker-main', 'sub-worker-wt', 'sub-manager-docs'];

/** Config store on the production extension folder; warnings collected in `warnings`. */
function openProductionStore(warnings = []) {
    const store = createConfigStore({
        rootDir: EXTENSION_DIR,
        copilotHome: COPILOT_HOME,
        env: ENV,
        clock: createFakeClock(),
        onWarning: (w) => warnings.push(w),
    });
    registerDirectoryPolicy(store);
    return store;
}

/** Effective directory policy of one agent (production rules and production agents.json), repo at REPO. */
function policyOf(agent, store = openProductionStore()) {
    return compileDirectoryPolicy(store.agentPolicy(agent).directories, { sessionId: SESSION_ID, repoRoot: REPO });
}

/** Effective allow list of one directory rule of one agent. */
function allowOf(agent, ruleId, store = openProductionStore()) {
    return store.agentPolicy(agent).directories.find((rule) => rule.id === ruleId)?.allow;
}

test('AgentOverrides_ReadOnlySubAgentRepoCreate_NotSafe', () => {
    // Arrange
    const policy = policyOf(READ_ONLY_EXAMPLE_AGENT);
    const file = `${REPO}\\src\\new.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.notEqual(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-NOT-ALLOWED']);
});

test('AgentOverrides_ReadOnlySubAgentReportCreate_Safe', () => {
    // Arrange
    const policy = policyOf(READ_ONLY_EXAMPLE_AGENT);
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\files\\reports\\x.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.equal(verdict.directoryId, 'session-files');
});

test('AgentOverrides_ReadOnlySubAgentReportCreateInCopilotHomeRepo_Safe', () => {
    // Arrange: cwd inside the copilot-home git repo, so the repo rule also matches the report file
    const policy = compileDirectoryPolicy(openProductionStore().agentPolicy(READ_ONLY_EXAMPLE_AGENT).directories, { sessionId: SESSION_ID, repoRoot: COPILOT_HOME });
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\files\\reports\\x.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.equal(verdict.directoryId, 'session-files');
});

test('AgentOverrides_ReadOnlySubAgentSessionPlanWrite_NotSafe', () => {
    // Arrange
    const policy = policyOf(READ_ONLY_EXAMPLE_AGENT);
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\plan.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.notEqual(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-NOT-ALLOWED']);
});

test('AgentOverrides_WritingSubAgentRepoCreate_Safe', () => {
    // Arrange
    const policy = policyOf(WRITING_EXAMPLE_AGENT);
    const file = `${REPO}\\src\\new.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-OK']);
});

test('AgentOverrides_ShippedFile_NoRejectedOverrideWarning', () => {
    // Arrange
    const warnings = [];
    const store = openProductionStore(warnings);

    // Act
    for (const agent of [...READ_ONLY_AGENTS, WRITING_EXAMPLE_AGENT]) store.agentPolicy(agent);
    const rejected = warnings.filter((w) => w.code === 'AGENT_OVERRIDE_REJECTED');

    // Assert
    assert.deepEqual(rejected, []);
});

test('AgentOverrides_ReadOnlySubAgents_TightenRepoAndSessionStateRules', () => {
    // Arrange
    const store = openProductionStore();

    // Act
    const allowed = READ_ONLY_AGENTS.map((agent) => ({
        agent,
        repo: allowOf(agent, 'repo', store),
        plan: allowOf(agent, 'session-state-plan', store),
        impl: allowOf(agent, 'session-state-impl', store),
    }));

    // Assert
    for (const row of allowed) {
        assert.deepEqual(row.repo, ['read', 'execute'], row.agent);
        assert.deepEqual(row.plan, ['read'], row.agent);
        assert.deepEqual(row.impl, ['read'], row.agent);
    }
});

test('AgentOverrides_WritingSubAgents_KeepBaseRules', () => {
    // Arrange
    const store = openProductionStore();

    // Act
    const allowed = WRITING_AGENTS.map((agent) => ({ agent, repo: allowOf(agent, 'repo', store), plan: allowOf(agent, 'session-state-plan', store) }));

    // Assert
    for (const row of allowed) {
        assert.deepEqual(row.repo, ['read', 'write', 'delete', 'execute'], row.agent);
        assert.deepEqual(row.plan, ['read', 'write'], row.agent);
    }
});

test('AgentOverrides_ReadOnlySubAgentRepoReadExecute_SafeAndDeleteNotSafe', () => {
    // Arrange
    const policy = policyOf(READ_ONLY_EXAMPLE_AGENT);
    const file = `${REPO}\\src\\new.md`;

    // Act
    const verdicts = Object.fromEntries(['read', 'execute', 'delete'].map((intent) => [intent, pathVerdict(file, intent, policy).verdict]));

    // Assert
    assert.equal(verdicts.read, 'SAFE');
    assert.equal(verdicts.execute, 'SAFE');
    assert.notEqual(verdicts.delete, 'SAFE');
});

test('AgentOverrides_AgentsFile_OverridesExactlyTheReadOnlySubAgents', () => {
    // Arrange
    const shipped = JSON.parse(readFileSync(PRODUCTION_AGENTS_PATH, 'utf8'));

    // Act
    const overridden = Object.keys(shipped.agents).sort();
    const writingOverridden = overridden.filter((name) => name.startsWith('sub-worker-') || WRITING_AGENTS.includes(name));

    // Assert
    assert.deepEqual(overridden, [...READ_ONLY_AGENTS].sort());
    assert.deepEqual(writingOverridden, []);
});

// The governor path with the shipped config: agent name (subagent.started) → agents.json override → repo/state rules → dialog.
describe('AgentOverrides governor path (T13 AC-14)', () => {
    const SESSION_ID = '0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e';
    const STAGE3 = { hardRatings: ['destructive', 'irreversible', 'credential_access', 'exfiltration'], hardThreshold: 1, softThreshold: 2, minConfidence: 0.7 };
    let sandbox;
    let HOME;
    let TEMP;
    let CODE;
    let REPO;

    /** Copies the shipped agents.json and directories.json into the sandbox; governor.json points codeRoots at the sandbox code root. */
    function useShippedConfig(agentsText = readFileSync(PRODUCTION_AGENTS_PATH, 'utf8')) {
        sandbox.write(sandbox.configFile('agents.json'), agentsText);
        sandbox.write(sandbox.directoriesPath, readFileSync(PRODUCTION_DIRECTORIES_PATH, 'utf8'));
        sandbox.write(sandbox.configFile('governor.json'), JSON.stringify({
            enabled: true,
            codeRoots: [CODE],
            judge: { model: 'x', maxConcurrent: 2, timeoutMs: 1000, cacheSize: 10 },
            stage3: STAGE3,
        }));
    }

    /** Governor over the sandbox config; the dialog records each request and denies it. */
    function buildGovernor() {
        const calls = { dialog: [] };
        const store = createConfigStore({
            rootDir: sandbox.root,
            copilotHome: sandbox.copilotHome,
            env: { USERPROFILE: HOME, TEMP, APPDATA: join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: join(HOME, 'AppData', 'Local') },
            clock: createFakeClock(),
        });
        registerDirectoryPolicy(store, sandbox.directoriesPath);
        registerCatalogGroups(store);
        const governor = createGovernor({
            config: store,
            worker: { argv: async () => ({ parseErrors: [], commands: [], flags: {} }) },
            judge: { judge: async () => { throw new Error('file tools have no judge'); } },
            dialog: { ask: async (request) => { calls.dialog.push(request); return { outcome: 'deny', reason: 'declined by user' }; } },
            audit: { write: () => true },
            sessionId: SESSION_ID,
            home: HOME,
            copilotHome: sandbox.copilotHome,
            temp: TEMP,
            settingsTtlMs: 0,
            resolveMainAgentName: async () => 'main',
        });
        return { governor, calls };
    }

    /** Announces a subagent of the given name to the governor, as the session events do. */
    function startSubagent(governor, agentName, agentId) {
        const toolCallId = `tc-${agentId}`;
        governor.onEvent({ type: 'tool.execution_start', agentId: null, data: { toolCallId, toolName: 'task', arguments: { prompt: 'dispatch' } } });
        governor.onEvent({ type: 'subagent.started', agentId, data: { toolCallId, agentName, agentDescription: 'test agent', agentType: 'explore' } });
    }

    /** A create call of the given agent (the file tool the governor checks). */
    const createBy = (governor, agentId, path) => governor.onPreToolUse({
        toolName: 'create',
        toolArgs: { path, file_text: 'x' },
        workingDirectory: REPO,
        sessionId: SESSION_ID,
        agentId,
    });

    before(() => {
        sandbox = createConfigSandbox('shell-governor-t13-');
        HOME = join(sandbox.base, 'home');
        TEMP = join(sandbox.base, 'temp');
        CODE = join(sandbox.base, 'code');
        REPO = join(CODE, 'proj');
        mkdirSync(join(REPO, '.git'), { recursive: true });
    });
    after(() => sandbox.remove());
    beforeEach(() => useShippedConfig());

    test('AgentOverrides_GovernorReadOnlySubagentRepoCreate_Asks', async () => {
        // Arrange
        const { governor, calls } = buildGovernor();
        startSubagent(governor, READ_ONLY_EXAMPLE_AGENT, 'agent-ro');
        // Act
        const out = await createBy(governor, 'agent-ro', join(REPO, 'src', 'new.md'));
        // Assert
        assert.equal(out.permissionDecision, 'deny');
        assert.equal(calls.dialog.length, 1);
        assert.equal(calls.dialog[0].agentName, READ_ONLY_EXAMPLE_AGENT);
        assert.ok(calls.dialog[0].ruleIds.some((r) => r.id === 'DIR-NOT-ALLOWED'), JSON.stringify(calls.dialog[0].ruleIds));
    });

    test('AgentOverrides_GovernorReadOnlySubagentSessionPlanCreate_Asks', async () => {
        // Arrange
        const { governor, calls } = buildGovernor();
        startSubagent(governor, READ_ONLY_EXAMPLE_AGENT, 'agent-ro');
        // Act
        const out = await createBy(governor, 'agent-ro', join(sandbox.copilotHome, 'session-state', SESSION_ID, 'plan.md'));
        // Assert
        assert.equal(out.permissionDecision, 'deny');
        assert.equal(calls.dialog.length, 1);
        assert.ok(calls.dialog[0].ruleIds.some((r) => r.id === 'DIR-NOT-ALLOWED'), JSON.stringify(calls.dialog[0].ruleIds));
    });

    test('AgentOverrides_GovernorReadOnlySubagentReportCreate_NoDecision', async () => {
        // Arrange
        const { governor, calls } = buildGovernor();
        startSubagent(governor, READ_ONLY_EXAMPLE_AGENT, 'agent-ro');
        // Act
        const out = await createBy(governor, 'agent-ro', join(sandbox.copilotHome, 'session-state', SESSION_ID, 'files', 'reports', 'x.md'));
        // Assert
        assert.equal(out, undefined);
        assert.equal(calls.dialog.length, 0);
    });

    test('AgentOverrides_GovernorWritingSubagentRepoCreate_NoDecision', async () => {
        // Arrange
        const { governor, calls } = buildGovernor();
        startSubagent(governor, WRITING_EXAMPLE_AGENT, 'agent-w');
        // Act
        const out = await createBy(governor, 'agent-w', join(REPO, 'src', 'new.md'));
        // Assert
        assert.equal(out, undefined);
        assert.equal(calls.dialog.length, 0);
    });

    test('AgentOverrides_GovernorReadOnlySubagentRepoCreate_NoDecisionWithoutOverrides', async () => {
        // Arrange: the same call with an agents.json that has no overrides, so the dialog comes from the shipped override
        useShippedConfig('{ "agents": {} }');
        const { governor, calls } = buildGovernor();
        startSubagent(governor, READ_ONLY_EXAMPLE_AGENT, 'agent-ro');
        // Act
        const out = await createBy(governor, 'agent-ro', join(REPO, 'src', 'new.md'));
        // Assert
        assert.equal(out, undefined);
        assert.equal(calls.dialog.length, 0);
    });
});
