import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import {
    compileDirectoryPolicy,
    createRealpathCache,
    globRe,
    pathVerdict,
    reachesSecretBase,
    registerDirectoryPolicy,
    repoRootOf,
    resolveFull,
} from '../../extensions/shell-governor/lib/paths.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createConfigSandbox } from './helpers/fixtures.mjs';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'shell-governor');
const HOME = 'C:\\Users\\Tester';
const COPILOT_HOME = `${HOME}\\.copilot`;
const APPDATA = `${HOME}\\AppData\\Roaming`;
const LOCALAPPDATA = `${HOME}\\AppData\\Local`;
const TEMP = `${HOME}\\AppData\\Local\\Temp`;
const ENV = Object.freeze({ USERPROFILE: HOME, TEMP, APPDATA, LOCALAPPDATA });
const SESSION_ID = '0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e';
const REPO = 'C:\\code\\proj';
const SCRIPTS = `${COPILOT_HOME}\\session-state\\scripts`;

/** Config store on the given extension root with the production directories file registered. */
function openStore(rootDir = EXTENSION_DIR, { warnings = [] } = {}) {
    const store = createConfigStore({
        rootDir,
        copilotHome: COPILOT_HOME,
        env: ENV,
        clock: createFakeClock(),
        onWarning: (w) => warnings.push(w),
    });
    registerDirectoryPolicy(store);
    return store;
}

/** Effective directory policy of one agent, loaded through the config store (production rules). */
function policyFor({ agent = 'main', repoRoot = REPO, scriptStatus, store = openStore(), realpath, now, listDir } = {}) {
    return compileDirectoryPolicy(store.agentPolicy(agent).directories, { sessionId: SESSION_ID, repoRoot, scriptStatus, realpath, now, listDir });
}

const preExisting = () => 'pre-existing';

test('Paths_GlobRe_DirectoryTailMatchesDirectoryItselfAndChildren', () => {
    // Arrange
    const re = globRe('C:\\Windows\\**');

    // Act
    const dir = re.test('c:\\windows');
    const child = re.test('c:\\windows\\system32\\x.dll');
    const sibling = re.test('c:\\windows2\\x.dll');

    // Assert
    assert.equal(dir, true);
    assert.equal(child, true);
    assert.equal(sibling, false);
});

test('Paths_GlobRe_LeadingDoubleStarMatchesExtensionAnywhere', () => {
    // Arrange
    const re = globRe('**\\*.pem');

    // Act
    const deep = re.test('c:\\code\\proj\\certs\\server.pem');
    const other = re.test('c:\\code\\proj\\certs\\server.pem.txt');

    // Assert
    assert.equal(deep, true);
    assert.equal(other, false);
});

// s4 D1: copilot-home is protected: reads are SAFE.
test('Paths_CopilotHomeRead_Safe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\agents\\x.md`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-READ']);
});

// s4 B7: write under copilot-home is protected → ASK.
test('Paths_CopilotHomeWrite_AskProtected', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\agents\\x.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
});

// s4 D2: session files of the current session are writable (documented exception to copilot-home).
test('Paths_SessionFilesWrite_Safe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\files\\a.txt`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.equal(verdict.directoryId, 'session-files');
});

// s4 D2 (extension): files of another session are not the current session's files → protected.
test('Paths_OtherSessionFilesWrite_AskProtected', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\session-state\\11111111-2222-3333-4444-555555555555\\files\\a.txt`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
});

// T1 AC-1: plan.md of the current session is a writable work file (read and write safe).
test('Paths_SessionPlanFile_WriteIsSafe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\plan.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-OK']);
    assert.equal(verdict.directoryId, 'session-state-plan');
});

// T1 AC-1: implementation-state.md of the current session is a writable work file.
test('Paths_SessionImplementationState_WriteIsSafe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\implementation-state.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['DIR-OK']);
    assert.equal(verdict.directoryId, 'session-state-impl');
});

// T1 AC-1: delete and execute of the two work files stay protected (ASK).
test('Paths_SessionStateFiles_DeleteAndExecuteAsk', () => {
    // Arrange
    const policy = policyFor();
    const files = ['plan.md', 'implementation-state.md'].map((name) => `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\${name}`);
    const expected = { delete: 'DIR-PROTECTED-DELETE', execute: 'DIR-PROTECTED-EXECUTE' };

    // Act
    const verdicts = files.flatMap((file) => Object.keys(expected).map((intent) => ({ intent, verdict: pathVerdict(file, intent, policy) })));

    // Assert
    for (const { intent, verdict } of verdicts) {
        assert.equal(verdict.verdict, 'ASK', `${intent}`);
        assert.deepEqual(verdict.ruleIds, [expected[intent]], `${intent}`);
        assert.equal(verdict.directoryId, 'copilot-home', `${intent}`);
    }
});

// T1 AC-1: other files of the session folder (backup, event log, workspace metadata) stay protected for writes.
test('Paths_SessionFolderOtherFiles_WriteAsks', () => {
    // Arrange
    const policy = policyFor();
    const files = ['plan.md.bak', 'events.jsonl', 'workspace.yaml'].map((name) => `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\${name}`);

    // Act
    const verdicts = files.map((file) => pathVerdict(file, 'write', policy));

    // Assert
    for (const verdict of verdicts) {
        assert.equal(verdict.verdict, 'ASK');
        assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
    }
});

// T1 AC-1: plan.md of another session id is not the current session's work file → protected write.
test('Paths_OtherSessionPlanFile_WriteAsks', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\session-state\\11111111-2222-3333-4444-555555555555\\plan.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(verdict.directoryId, 'copilot-home');
});

// T1 AC-1: with an invalid session id the session-state rules never match; the path falls back to copilot-home.
test('Paths_InvalidSessionId_StateRulesNeverMatch', () => {
    // Arrange
    const policy = compileDirectoryPolicy(openStore().agentPolicy('main').directories, { sessionId: 'bad.sid', repoRoot: REPO });
    const file = `${COPILOT_HOME}\\session-state\\bad.sid\\plan.md`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(verdict.directoryId, 'copilot-home');
});

// T1 AC-2: reports are a work area: read and write are safe.
test('Paths_Reports_ReadWriteSafe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\reports\\2026-10-19\\report.md`;

    // Act
    const verdicts = ['read', 'write'].map((intent) => pathVerdict(file, intent, policy));

    // Assert
    for (const verdict of verdicts) {
        assert.equal(verdict.verdict, 'SAFE');
        assert.deepEqual(verdict.ruleIds, ['DIR-OK']);
        assert.equal(verdict.directoryId, 'reports');
    }
});

// T1 AC-2: delete and execute under reports stay protected (ASK).
test('Paths_Reports_DeleteAndExecuteAsk', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\reports\\2026-10-19\\report.md`;
    const expected = { delete: 'DIR-PROTECTED-DELETE', execute: 'DIR-PROTECTED-EXECUTE' };

    // Act
    const verdicts = Object.keys(expected).map((intent) => ({ intent, verdict: pathVerdict(file, intent, policy) }));

    // Assert
    for (const { intent, verdict } of verdicts) {
        assert.equal(verdict.verdict, 'ASK', `${intent}`);
        assert.deepEqual(verdict.ruleIds, [expected[intent]], `${intent}`);
        assert.equal(verdict.directoryId, 'copilot-home', `${intent}`);
    }
});

// s4 D3: secret path → ASK for any access intent.
test('Paths_SecretPath_AskForAnyIntent', () => {
    // Arrange
    const policy = policyFor();
    const file = `${HOME}\\.ssh\\id_rsa`;

    // Act
    const verdicts = ['read', 'write', 'delete', 'execute'].map((intent) => pathVerdict(file, intent, policy));

    // Assert
    for (const verdict of verdicts) {
        assert.equal(verdict.verdict, 'ASK');
        assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
        assert.equal(verdict.directoryId, 'secret-ssh');
    }
});

// s4 D4: temp allows execute → SAFE.
test('Paths_TempExecute_Safe', () => {
    // Arrange
    const policy = policyFor();
    const file = `${TEMP}\\x.ps1`;

    // Act
    const verdict = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.equal(verdict.directoryId, 'temp');
});

// s4 D5: unclassified location, write intent (reads are covered by READ-ANYWHERE below) → AI.
test('Paths_UnclassifiedWrite_Ai', () => {
    // Arrange
    const policy = policyFor();
    const file = 'D:\\other\\x.txt';

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'AI');
    assert.deepEqual(verdict.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(verdict.directoryId, null);
});

// s4 B11: delete under a system root → ASK.
test('Paths_SystemRootDelete_AskProtected', () => {
    // Arrange
    const policy = policyFor();
    const file = 'C:\\Windows\\Temp\\x';

    // Act
    const verdict = pathVerdict(file, 'delete', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-DELETE']);
});

// s5 P1a: read outside every directory rule → SAFE (READ-ANYWHERE).
test('Paths_UnclassifiedRead_SafeReadAnywhere', () => {
    // Arrange
    const policy = policyFor();
    const file = 'C:\\code\\elsewhere\\notes.txt';

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['READ-ANYWHERE']);
});

// s5 P1b: readAnywhere never overrides a secret rule.
test('Paths_SecretRead_AskUnderReadAnywhere', () => {
    // Arrange
    const policy = policyFor();
    const file = `${HOME}\\.ssh\\id_rsa`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
});

// s5 P1c: writes outside every directory rule keep their handling (not SAFE).
test('Paths_UnclassifiedWrite_NotSafe', () => {
    // Arrange
    const policy = policyFor();
    const file = 'C:\\code\\elsewhere\\notes.txt';

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.notEqual(verdict.verdict, 'SAFE');
    assert.equal(verdict.verdict, 'AI');
});

// s5 P3a: a pre-existing session script executes → SAFE (B4-COPILOT-SCRIPT).
test('Paths_SessionScriptPreExisting_ExecuteSafe', () => {
    // Arrange
    const policy = policyFor({ scriptStatus: preExisting });
    const file = `${SCRIPTS}\\workflow\\plan-check.ps1`;

    // Act
    const verdict = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['B4-COPILOT-SCRIPT']);
    assert.equal(verdict.directoryId, 'session-scripts');
});

// s5 P3b: dotnet script export-events.csx under session-state\scripts → SAFE.
test('Paths_SessionScriptPreExisting_DotnetScriptSafe', () => {
    // Arrange
    const policy = policyFor({ scriptStatus: preExisting });
    const file = `${SCRIPTS}\\export-events.csx`;

    // Act
    const verdict = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['B4-COPILOT-SCRIPT']);
});

// s5 P3c: writes under session-state\scripts stay protected → ASK.
test('Paths_SessionScriptsWrite_AskProtected', () => {
    // Arrange
    const policy = policyFor({ scriptStatus: preExisting });
    const file = `${SCRIPTS}\\x.ps1`;

    // Act
    const verdict = pathVerdict(file, 'write', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-WRITE']);
});

// s5 P3d: execute under other copilot-home folders stays ASK.
test('Paths_OtherCopilotHomeExecute_AskProtected', () => {
    // Arrange
    const policy = policyFor({ scriptStatus: preExisting });
    const file = `${COPILOT_HOME}\\agents\\x.ps1`;

    // Act
    const verdict = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-PROTECTED-EXECUTE']);
});

// s6 a1: copilot config.json is secret (P-25) → ASK for reads, not SAFE as a protected read.
test('Paths_CopilotConfigRead_AskSecret', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\config.json`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
    assert.equal(verdict.directoryId, 's6-copilot-config');
});

// s6 a2: user secrets under %APPDATA% → ASK.
test('Paths_UserSecretsRead_AskSecret', () => {
    // Arrange
    const policy = policyFor();
    const file = `${APPDATA}\\Microsoft\\UserSecrets\\x\\secrets.json`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.equal(verdict.directoryId, 's6-usersecrets');
});

// s6 a3: browser profile (Chrome) → ASK, although readAnywhere alone would allow the read.
test('Paths_ChromeProfileRead_AskSecret', () => {
    // Arrange
    const policy = policyFor();
    const file = `${LOCALAPPDATA}\\Google\\Chrome\\User Data\\Default\\Login Data`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.equal(verdict.directoryId, 's6-chrome-profile');
});

// s6 a4: .env.local inside the repo → ASK (secret wins over the repo rule).
test('Paths_RepoEnvLocalRead_AskSecret', () => {
    // Arrange
    const policy = policyFor();
    const file = `${REPO}\\.env.local`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.equal(verdict.directoryId, 's6-env-variants');
});

// s6 a5: ordinary file outside the directory rules → SAFE (readAnywhere).
test('Paths_HomeOrdinaryRead_SafeReadAnywhere', () => {
    // Arrange
    const policy = policyFor();
    const file = `${HOME}\\docs\\readme.txt`;

    // Act
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['READ-ANYWHERE']);
});

// s6 b1: a session script created or modified in this session may not execute → AI.
test('Paths_SessionScriptsFresh_NotAllowed', () => {
    // Arrange
    const file = `${SCRIPTS}\\x.ps1`;
    const fresh = policyFor({ scriptStatus: () => 'fresh' });
    const missing = policyFor({ scriptStatus: () => 'missing' });

    // Act
    const verdicts = [pathVerdict(file, 'execute', fresh), pathVerdict(file, 'execute', missing)];

    // Assert
    for (const verdict of verdicts) {
        assert.equal(verdict.verdict, 'AI');
        assert.deepEqual(verdict.ruleIds, ['B4-COPILOT-SCRIPT-NOT-PREEXISTING']);
    }
});

// s6 b2: a pre-existing session script may execute → SAFE.
test('Paths_SessionScriptsPreExisting_Safe', () => {
    // Arrange
    const policy = policyFor({ scriptStatus: preExisting });
    const file = `${SCRIPTS}\\x.ps1`;

    // Act
    const verdict = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['B4-COPILOT-SCRIPT']);
});

// AC-5 / P-25: every secret group of the extended list is present and asks on read.
test('Paths_ExtendedSecretList_AllReadsAsk', () => {
    // Arrange
    const policy = policyFor();
    const files = [
        `${HOME}\\.npmrc`,
        `${HOME}\\.netrc`,
        `${HOME}\\.pypirc`,
        `${HOME}\\.config\\gh\\hosts.yml`,
        `${HOME}\\.docker\\config.json`,
        `${HOME}\\.nuget\\NuGet\\NuGet.Config`,
        `${COPILOT_HOME}\\mcp-config.json`,
        `${COPILOT_HOME}\\mcp-oauth-config\\token.json`,
        `${COPILOT_HOME}\\permissions-config.json`,
        `${COPILOT_HOME}\\entra-broker-x\\token.json`,
        `${COPILOT_HOME}\\mcp-secrets\\index.json`,
        `${APPDATA}\\Mozilla\\Firefox\\Profiles\\p\\logins.json`,
        `${LOCALAPPDATA}\\Microsoft\\Edge\\User Data\\Default\\Login Data`,
        `${LOCALAPPDATA}\\Microsoft\\Vault\\v.vcrd`,
        `${APPDATA}\\Microsoft\\Credentials\\c`,
        `${REPO}\\cert.pfx`,
        `${REPO}\\ids.publishsettings`,
    ];

    // Act
    const verdicts = files.map((file) => pathVerdict(file, 'read', policy));

    // Assert
    verdicts.forEach((verdict, i) => {
        assert.equal(verdict.verdict, 'ASK', files[i]);
        assert.deepEqual(verdict.ruleIds, ['DIR-SECRET'], files[i]);
    });
});

// AC-5: the governor's own folder cannot be written, deleted or executed by the agent.
test('Paths_GovernorOwnFolder_IsProtected', () => {
    // Arrange
    const policy = policyFor();
    const file = `${COPILOT_HOME}\\extensions\\shell-governor\\lib\\paths.mjs`;

    // Act
    const read = pathVerdict(file, 'read', policy);
    const write = pathVerdict(file, 'write', policy);
    const remove = pathVerdict(file, 'delete', policy);
    const run = pathVerdict(file, 'execute', policy);

    // Assert
    assert.equal(read.verdict, 'SAFE');
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(write.directoryId, 'governor-own');
    assert.equal(remove.verdict, 'ASK');
    assert.deepEqual(remove.ruleIds, ['DIR-PROTECTED-DELETE']);
    assert.equal(run.verdict, 'ASK');
    assert.deepEqual(run.ruleIds, ['DIR-PROTECTED-EXECUTE']);
});

// AC-5: a repo under a configured code root gets the repo rule; the same folder outside it does not.
test('Paths_RepoRoot_UsesConfiguredCodeRoots', () => {
    // Arrange
    const gitDirs = new Set(['D:\\work\\proj\\.git', 'C:\\code\\proj\\.git', 'E:\\scratch\\proj\\.git']);
    const exists = (p) => gitDirs.has(p);
    const store = openStore();
    const configured = store.get().governor.codeRoots;

    // Act
    const underCustomRoot = repoRootOf('D:\\work\\proj\\src', { codeRoots: ['D:\\work'], exists });
    const outsideCustomRoot = repoRootOf('D:\\work\\proj\\src', { codeRoots: ['C:\\code'], exists });
    const underDefaultRoot = repoRootOf('C:\\code\\proj\\src', { codeRoots: configured, exists });
    const outsideAnyRoot = repoRootOf('E:\\scratch\\proj\\src', { codeRoots: configured, exists });
    const repoRule = pathVerdict('D:\\work\\proj\\src\\a.ts', 'write', compileDirectoryPolicy([{ id: 'repo', repo: true, level: 'normal', allow: ['write'] }], { repoRoot: underCustomRoot }));
    const noRepoRule = pathVerdict('D:\\work\\proj\\src\\a.ts', 'write', compileDirectoryPolicy([{ id: 'repo', repo: true, level: 'normal', allow: ['write'] }], { repoRoot: outsideCustomRoot }));

    // Assert
    assert.deepEqual(configured, ['C:\\code']);
    assert.equal(underCustomRoot, 'D:\\work\\proj');
    assert.equal(outsideCustomRoot, null);
    assert.equal(underDefaultRoot, 'C:\\code\\proj');
    assert.equal(outsideAnyRoot, null);
    assert.equal(repoRule.verdict, 'SAFE');
    assert.equal(noRepoRule.verdict, 'AI');
});

// AC-5: agent overrides may tighten but never loosen a protected or secret rule.
test('Paths_AgentOverride_CannotLoosenProtectedOrSecret', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    sb.write(sb.configFile('agents.json'), JSON.stringify({
        agents: {
            'sub-attacker': {
                directories: {
                    'copilot-home': { allow: ['read', 'write'] },
                    'secret-ssh': { level: 'normal', allow: ['read', 'write'] },
                    temp: { allow: ['read'] },
                },
            },
        },
    }));
    const warnings = [];
    const policy = policyFor({ agent: 'sub-attacker', store: openStore(sb.root, { warnings }) });

    // Act
    const writeCopilotHome = pathVerdict(`${COPILOT_HOME}\\agents\\x.md`, 'write', policy);
    const readSecret = pathVerdict(`${HOME}\\.ssh\\id_rsa`, 'read', policy);
    const writeTemp = pathVerdict(`${TEMP}\\x.txt`, 'write', policy);
    const rejected = warnings.filter((w) => w.code === 'AGENT_OVERRIDE_REJECTED');

    // Assert
    assert.equal(writeCopilotHome.verdict, 'ASK');
    assert.equal(readSecret.verdict, 'ASK');
    assert.deepEqual(readSecret.ruleIds, ['DIR-SECRET']);
    assert.equal(writeTemp.verdict, 'AI', 'a tightened normal rule no longer allows write');
    assert.equal(rejected.length, 2);
});

// Supporting: resolveFull keeps URL, registry and UNC forms out of the path policy and resolves relative paths.
test('Paths_ResolveFull_ExpandsHomeAndCwdAndKeepsRemoteForms', () => {
    // Arrange
    const cwd = REPO;

    // Act
    const home = resolveFull('~\\notes.txt', cwd, { home: HOME });
    const relative = resolveFull('src\\a.ts', cwd, { home: HOME });
    const rootRelative = resolveFull('\\x\\y', cwd, { home: HOME });
    const dynamic = resolveFull('$env:TEMP\\x', cwd, { home: HOME });
    const url = resolveFull('https://example.invalid/a', cwd, { home: HOME });
    const unc = resolveFull('\\\\server\\share\\x', cwd, { home: HOME });
    const registry = resolveFull('HKCU\\Software\\X', cwd, { home: HOME });

    // Assert
    assert.equal(home, `${HOME}\\notes.txt`);
    assert.equal(relative, `${REPO}\\src\\a.ts`);
    assert.equal(rootRelative, 'C:\\x\\y');
    assert.equal(dynamic, null);
    assert.equal(url, 'url:https://example.invalid/a');
    assert.equal(unc, 'unc:\\\\server\\share\\x');
    assert.equal(registry, 'registry:HKCU\\Software\\X');
});

test('Paths_ResolveFull_DriveRelativePathIsUnresolved', () => {
    // Arrange / Act (F3): "C:foo" means "foo in the current directory of drive C", which is not the cwd of the call
    const relative = resolveFull('C:foo.txt', REPO, { home: HOME });
    const bare = resolveFull('D:', REPO, { home: HOME });
    const lower = resolveFull('c:foo\\bar', REPO, { home: HOME });
    const quoted = resolveFull('"C:foo.txt"', REPO, { home: HOME });
    const absolute = resolveFull('C:\\x', REPO, { home: HOME });
    const forward = resolveFull('C:/x/y', REPO, { home: HOME });

    // Assert
    assert.equal(relative, null);
    assert.equal(bare, null);
    assert.equal(lower, null);
    assert.equal(quoted, null);
    assert.equal(absolute, 'C:\\x');
    assert.equal(forward, 'C:\\x\\y');
});

test('Paths_ResolveFull_DriveRelativeWithStreamSuffix_IsUnresolved', () => { // TFIX-6 F1: the drive-relative guard runs before the stream suffixes are stripped
    // Arrange / Act
    const cases = {
        doubleColon: resolveFull('C:.env::$DATA', REPO, { home: HOME }),
        singleColon: resolveFull('C:.env:$DATA', REPO, { home: HOME }),
        idRsa: resolveFull('C:id_rsa:$DATA', REPO, { home: HOME }),
        bare: resolveFull('C::$DATA', REPO, { home: HOME }),
        lower: resolveFull('c:.env::$DATA', REPO, { home: HOME }),
        quoted: resolveFull('"C:.env::$DATA"', REPO, { home: HOME }),
        singleQuoted: resolveFull("'C:.env::$DATA'", REPO, { home: HOME }),
        provider: resolveFull('FileSystem::C:.env::$DATA', REPO, { home: HOME }),
        qualifiedProvider: resolveFull('Microsoft.PowerShell.Core\\FileSystem::C:id_rsa:$DATA', REPO, { home: HOME }),
        subfolder: resolveFull('C:sub\\.env::$DATA', REPO, { home: HOME }),
        leadingSpace: resolveFull("' C:.env::$DATA'", REPO, { home: HOME }),
    };
    const device = resolveFull('\\\\?\\C:.env::$DATA', REPO, { home: HOME });
    const deviceDot = resolveFull('\\\\.\\C:.env::$DATA', REPO, { home: HOME });

    // Assert
    for (const [id, value] of Object.entries(cases)) assert.equal(value, null, id);
    for (const value of [device, deviceDot]) assert.ok(value === null || !/^[A-Za-z]:/.test(value), `device path must not resolve to a local path: ${value}`);
});

test('Paths_ResolveFull_AbsoluteWithStreamSuffix_StillResolvesToTheFile', () => { // TFIX-6 F1: the reordering must not lose the TFIX-5 behaviour
    assert.equal(resolveFull('C:\\code\\.env::$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('C:\\code\\.env:$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('C:/code/.env::$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('FileSystem::C:\\code\\.env::$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('\\\\?\\C:\\code\\.env::$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('\\\\localhost\\c$\\code\\.env::$DATA', REPO, { home: HOME }), 'C:\\code\\.env');
    assert.equal(resolveFull('.env::$DATA', REPO, { home: HOME }), `${REPO}\\.env`);
});

test('Paths_ResolveFull_PercentVariableIsDynamic', () => {
    // Arrange / Act
    const env = resolveFull('%USERPROFILE%\\.ssh\\id_rsa', REPO, { home: HOME });
    const mixed = resolveFull('C:\\x\\%TEMP%\\y', REPO, { home: HOME });

    // Assert
    assert.equal(env, null); // C1: cmd-style variables are never constants
    assert.equal(mixed, null);
});

test('Paths_ResolveFull_PowerShellProviderDrivesAreProviderValues', () => {
    // Arrange / Act
    const alias = resolveFull('Alias:\\ls', REPO, { home: HOME });
    const fn = resolveFull('function:Get-Content', REPO, { home: HOME });
    const drive = resolveFull('C:\\x', REPO, { home: HOME });

    // Assert
    assert.equal(alias, 'provider:Alias:\\ls'); // N4: never a path below the cwd
    assert.equal(fn, 'provider:function:Get-Content');
    assert.equal(drive, 'C:\\x');
});

// ---------- TFIX-2a C1: path variants must not bypass secret and protected rules ----------

const HOST = 'TESTBOX';
const resolveHome = (value) => resolveFull(value, REPO, { home: HOME, hostNames: [HOST] });

/** Realpath fake over a case-insensitive table (lower-case path → real path); anything else is ENOENT like fs. */
function fakeRealpath(table) {
    const map = new Map(Object.entries(table).map(([k, v]) => [k.toLowerCase(), v]));
    const fn = (p) => {
        fn.calls.push(p);
        const hit = map.get(String(p).toLowerCase());
        if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return hit;
    };
    fn.calls = [];
    return fn;
}

/** A disk where the secret folders and their 8.3 aliases exist. */
const diskWithShortNames = () => fakeRealpath({
    'C:\\': 'C:\\',
    'C:\\Users': 'C:\\Users',
    [HOME]: HOME,
    [COPILOT_HOME]: COPILOT_HOME,
    [`${HOME}\\COPILO~1`]: COPILOT_HOME,
    [`${HOME}\\COPILO~1\\CONFIG~1.JSO`]: `${COPILOT_HOME}\\config.json`,
    [`${HOME}\\COPILO~1\\EXTENS~1`]: `${COPILOT_HOME}\\extensions`,
    [`${COPILOT_HOME}\\config.json`]: `${COPILOT_HOME}\\config.json`,
    [`${COPILOT_HOME}\\CONFIG~1.JSO`]: `${COPILOT_HOME}\\config.json`,
    [`${COPILOT_HOME}\\mcp-secrets`]: `${COPILOT_HOME}\\mcp-secrets`,
    [`${COPILOT_HOME}\\MCP-SE~1`]: `${COPILOT_HOME}\\mcp-secrets`,
    [`${COPILOT_HOME}\\extensions`]: `${COPILOT_HOME}\\extensions`,
    [`${COPILOT_HOME}\\EXTENS~1`]: `${COPILOT_HOME}\\extensions`,
    [`${HOME}\\.ssh`]: `${HOME}\\.ssh`,
    [`${HOME}\\SSH~1`]: `${HOME}\\.ssh`,
});

const verdictOfRaw = (raw, intent, policy) => pathVerdict(resolveHome(raw), intent, policy);

test('Paths_VariantSegments_TrailingDotsSpacesAndStreams_SecretStillAsks', () => {
    // Arrange
    const policy = policyFor({});
    const variants = [
        `${HOME}\\.ssh.\\id_rsa`,
        `"${HOME}\\.ssh \\id_rsa"`,
        `${HOME}\\.ssh...\\id_rsa`,
        `${HOME}\\.ssh\\id_rsa.`,
        `${HOME}\\.ssh\\id_rsa:stream`,
        `${COPILOT_HOME}.\\config.json`,
        `${COPILOT_HOME}\\mcp-secrets.\\token.txt`,
        `${COPILOT_HOME}\\config.json:Zone.Identifier`,
        `${COPILOT_HOME}\\config.json.`,
        `${HOME}\\.SSH.\\ID_RSA`,
        `${HOME}\\.ssh\\.\\x\\..\\id_rsa`,
        `${REPO}\\cert.pem.`,
    ];

    for (const raw of variants) {
        // Act
        const verdict = verdictOfRaw(raw, 'read', policy);

        // Assert
        assert.equal(verdict.verdict, 'ASK', raw);
        assert.deepEqual(verdict.ruleIds, ['DIR-SECRET'], raw);
    }
});

test('Paths_VariantSegments_DefaultStreamSuffix_SecretStillAsks', () => {
    // Arrange / Act (pathVerdict gets the text as resolveFull would hand it over; "$" makes the raw word dynamic there)
    const verdict = pathVerdict(`${HOME}\\.ssh\\id_rsa::$DATA`, 'read', policyFor({}));

    // Assert
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
});

test('Paths_ResolveFull_ProviderQualifiedFileSystemPath_IsTheFilePath', () => {
    // Arrange / Act
    const plain = resolveHome(`FileSystem::${HOME}\\.ssh\\id_rsa`);
    const qualified = resolveHome(`Microsoft.PowerShell.Core\\FileSystem::${HOME}\\.ssh\\id_rsa`);
    const registry = resolveHome('Registry::HKEY_CURRENT_USER\\Software\\X');

    // Assert
    assert.equal(plain, `${HOME}\\.ssh\\id_rsa`);
    assert.equal(qualified, `${HOME}\\.ssh\\id_rsa`);
    assert.match(registry, /^registry:/);
});

test('Paths_VariantSegments_ProtectedWriteStillAsks', () => {
    // Arrange
    const policy = policyFor({});
    const variants = [`${COPILOT_HOME}\\extensions.\\shell-governor\\main.mjs`, `${COPILOT_HOME}.\\extensions\\x`, `"${COPILOT_HOME}\\extensions \\x"`];

    for (const raw of variants) {
        // Act
        const verdict = verdictOfRaw(raw, 'write', policy);

        // Assert
        assert.equal(verdict.verdict, 'ASK', raw);
        assert.equal(verdict.directoryId, 'governor-own', raw);
    }
});

test('Paths_ResolveFull_ExtendedPrefixAndLoopbackShares_MapToDrivePath', () => {
    // Arrange
    const target = `${HOME}\\.ssh\\id_rsa`;
    const cases = [
        [`\\\\?\\${target}`, target],
        [`\\\\.\\${target}`, target],
        [`//?/${target.replace(/\\/g, '/')}`, target],
        [`\\\\localhost\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\\\LOCALHOST\\C$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\\\127.0.0.1\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\\\${HOST}\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\\\${HOST.toLowerCase()}.corp.example\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`//localhost/c$/Users/Tester/.ssh/id_rsa`, target],
        [`\\\\?\\UNC\\localhost\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\\\localhost\\d$`, 'D:\\'],
    ];

    for (const [raw, expected] of cases) {
        // Act
        const full = resolveHome(raw);

        // Assert
        assert.equal(full, expected, raw);
    }
    const verdict = pathVerdict(resolveHome(`\\\\localhost\\c$\\Users\\Tester\\.ssh\\id_rsa`), 'read', policyFor({}));
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
});

test('Paths_ResolveFull_RemoteAndUnknownUncForms_StayUnc', () => {
    // Arrange
    const cases = [
        '\\\\fileserver\\share\\x',
        '\\\\fileserver\\c$\\x',
        '\\\\localhost\\data\\x', // a local share that is no drive share: location unknown
        '\\\\?\\UNC\\fileserver\\share\\x',
        '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x',
        '\\\\.\\PhysicalDrive0',
    ];

    for (const raw of cases) {
        // Act
        const full = resolveHome(raw);

        // Assert
        assert.match(full, /^unc:/, raw);
    }
});

test('Paths_ResolveFull_NtObjectManagerPrefix_MapsLikeTheExtendedPrefix', () => { // TFIX-7 item 1 (critical): "\??\C:\x" is the NT form of "\\?\C:\x", not "C:\??\C\x"
    // Arrange
    const target = `${HOME}\\.ssh\\id_rsa`;
    const cases = [
        [`\\??\\${target}`, target],
        [`/??/${target.replace(/\\/g, '/')}`, target],
        [`\\??\\${target}::$DATA`, target],
        [`"\\??\\${target}"`, target],
        [`FileSystem::\\??\\${target}`, target],
        [`\\??\\UNC\\localhost\\c$\\Users\\Tester\\.ssh\\id_rsa`, target],
        [`\\??\\C:\\x`, 'C:\\x'],
    ];

    for (const [raw, expected] of cases) {
        // Act
        const full = resolveHome(raw);

        // Assert
        assert.equal(full, expected, raw);
    }
});

test('Paths_ResolveFull_NtPrefixDriveRelativeAndRemoteForms_AreNeverLocalPaths', () => { // TFIX-7 item 1
    // Arrange: same handling as the "\\?\" forms (drive-relative: unresolved; other machine: UNC)
    const cases = ['\\??\\C:x', '\\??\\C:.env::$DATA', '\\??\\C:', '\\??\\UNC\\fileserver\\share\\x', '\\??', '\\??\\', '/??/C:id_rsa'];

    for (const raw of cases) {
        // Act
        const full = resolveHome(raw);

        // Assert
        assert.ok(full === null || /^unc:/.test(full), `${raw} -> ${full}`);
    }
});

test('Paths_ResolveFull_NtAndDeviceNamespaces_AreUnresolved', () => { // TFIX-7 item 1: namespaces that can reach local files in a way the governor does not map
    // Arrange
    const cases = [
        '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\Tester\\.ssh\\id_rsa',
        '\\\\.\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\Tester\\.ssh\\id_rsa',
        '//?/GLOBALROOT/Device/HarddiskVolume3/x',
        '\\??\\GLOBALROOT\\Device\\HarddiskVolume3\\x',
        '\\GLOBAL??\\C:\\Users\\Tester\\.ssh\\id_rsa',
        '/GLOBAL??/C:/Users/Tester/.ssh/id_rsa',
        '\\global??\\c:\\x',
        '\\GLOBAL??',
        '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\Users\\Tester\\.ssh\\id_rsa',
        '\\??\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x',
        '\\\\.\\HarddiskVolume3\\Users\\Tester\\.ssh\\id_rsa',
        '\\\\?\\HarddiskVolume3\\x',
        '\\Device\\HarddiskVolume3\\Users\\Tester\\.ssh\\id_rsa',
        '/Device/HarddiskVolume3/x',
        '\\device\\harddiskvolume3\\x',
        '\\Device',
        '\\??\\Device\\HarddiskVolume3\\x',
        '\\?\\C:\\x', // single backslash: never an ordinary root-relative folder
        '\\?',
        '\\??\\GLOBALROOT',
    ];

    for (const raw of cases) {
        // Act
        const full = resolveHome(raw);

        // Assert
        assert.ok(full === null || /^unc:/.test(full), `${raw} -> ${full}`);
    }
});

test('Paths_ResolveFull_PlainRootRelativePaths_StillResolve', () => { // TFIX-7 item 1: the new namespace guards must not swallow ordinary paths
    assert.equal(resolveHome('\\x\\y'), 'C:\\x\\y');
    assert.equal(resolveHome('\\Devices\\x'), 'C:\\Devices\\x');
    assert.equal(resolveHome('\\Deviceish'), 'C:\\Deviceish');
    assert.equal(resolveHome('\\GLOBALS\\x'), 'C:\\GLOBALS\\x');
    assert.equal(resolveHome('\\\\?\\C:\\x'), 'C:\\x');
    assert.equal(resolveHome('\\\\.\\C:\\x'), 'C:\\x');
});

test('Paths_ShortNames_ExpandedByRealpath_SecretAndProtectedStillMatch', () => {
    // Arrange
    const disk = diskWithShortNames();
    const policy = policyFor({ realpath: disk });
    const secret = [
        `${COPILOT_HOME}\\CONFIG~1.JSO`,
        `${COPILOT_HOME}\\MCP-SE~1\\token.txt`,
        `${HOME}\\COPILO~1\\CONFIG~1.JSO`,
        `${HOME}\\SSH~1\\id_rsa`,
    ];

    for (const file of secret) {
        // Act
        const verdict = pathVerdict(file, 'read', policy);

        // Assert
        assert.equal(verdict.verdict, 'ASK', file);
        assert.deepEqual(verdict.ruleIds, ['DIR-SECRET'], file);
    }
    const write = pathVerdict(`${HOME}\\COPILO~1\\EXTENS~1\\shell-governor\\main.mjs`, 'write', policy);
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
});

test('Paths_ShortNameThatCannotBeExpanded_ReadIsAiWriteIsAsk', () => {
    // Arrange: the long name behind PROJEC~1 does not exist, so nothing can tell what it stands for
    const policy = policyFor({ realpath: diskWithShortNames() });
    const file = `${HOME}\\PROJEC~1\\notes.txt`;

    // Act
    const read = pathVerdict(file, 'read', policy);
    const write = pathVerdict(file, 'write', policy);
    const remove = pathVerdict(file, 'delete', policy);

    // Assert
    assert.equal(read.verdict, 'AI');
    assert.deepEqual(read.ruleIds, ['DIR-SHORTNAME-UNRESOLVED']);
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-SHORTNAME-UNRESOLVED']);
    assert.equal(remove.verdict, 'ASK');
});

test('Paths_ExistingNameThatLooksLikeShortName_IsNotUnresolved', () => {
    // Arrange: a real file called REPORT~1.TXT: realpath finds it, so the name is a long name
    const disk = fakeRealpath({ 'C:\\': 'C:\\', [HOME]: HOME, [`${HOME}\\REPORT~1.TXT`]: `${HOME}\\REPORT~1.TXT` });
    const policy = policyFor({ realpath: disk });

    // Act
    const verdict = pathVerdict(`${HOME}\\REPORT~1.TXT`, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.deepEqual(verdict.ruleIds, ['READ-ANYWHERE']);
});

test('Paths_RealpathFailureOtherThanNotFound_MarksTheTargetUnresolved', () => { // TFIX-5 item 6
    // Arrange: the folder exists but cannot be resolved (access denied, permission, symlink loop): that is no "does not exist"
    for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO']) {
        const base = fakeRealpath({ 'C:\\': 'C:\\', 'C:\\Users': 'C:\\Users', [HOME]: HOME });
        const disk = (p) => {
            if (String(p).toLowerCase() === `${HOME}\\locked`.toLowerCase()) throw Object.assign(new Error(`${code}: ${p}`), { code });
            return base(p);
        };
        const policy = policyFor({ realpath: disk });
        const file = `${HOME}\\Locked\\notes.txt`;

        // Act
        const read = pathVerdict(file, 'read', policy);
        const write = pathVerdict(file, 'write', policy);
        const remove = pathVerdict(file, 'delete', policy);

        // Assert
        assert.equal(read.verdict, 'AI', code);
        assert.deepEqual(read.ruleIds, ['DIR-REALPATH-UNRESOLVED'], code);
        assert.equal(write.verdict, 'ASK', code);
        assert.equal(remove.verdict, 'ASK', code);
    }
});

test('Paths_RealpathNotFoundErrors_StillMeanDoesNotExist', () => { // TFIX-5 item 6
    // Arrange: ENOENT and ENOTDIR answer "no such path": the existing ancestor decides, nothing is unresolved
    for (const code of ['ENOENT', 'ENOTDIR']) {
        const base = fakeRealpath({ 'C:\\': 'C:\\', 'C:\\Users': 'C:\\Users', [HOME]: HOME });
        const disk = (p) => {
            if (String(p).toLowerCase().startsWith(`${HOME}\\missing`.toLowerCase())) throw Object.assign(new Error(`${code}: ${p}`), { code });
            return base(p);
        };
        const policy = policyFor({ realpath: disk });

        // Act
        const read = pathVerdict(`${HOME}\\missing\\notes.txt`, 'read', policy);

        // Assert
        assert.equal(read.verdict, 'SAFE', code);
        assert.deepEqual(read.ruleIds, ['READ-ANYWHERE'], code);
    }
});

test('Paths_RealpathFailure_IsCachedLikeAnyAnswerAndRefreshed', () => { // TFIX-5 item 6
    // Arrange
    const clock = createFakeClock();
    let calls = 0;
    const policy = policyFor({
        realpath: (p) => {
            if (String(p).toLowerCase() === `${HOME}\\locked`.toLowerCase()) { calls++; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        now: () => clock.now(),
    });
    const file = `${HOME}\\locked\\a.txt`;

    // Act
    pathVerdict(file, 'read', policy);
    const first = calls;
    pathVerdict(file, 'read', policy);
    const within = calls;
    clock.advance(1500);
    const verdict = pathVerdict(file, 'read', policy);

    // Assert
    assert.equal(within, first, 'the failure answer is reused within the TTL');
    assert.ok(calls > within, 'and asked again afterwards');
    assert.equal(verdict.verdict, 'AI');
});

test('Paths_RealpathCache_ErrorAnswerIsAnErrorMarkerNotNull', () => { // TFIX-5 item 6
    // Arrange
    const real = createRealpathCache({
        realpath: (p) => { throw Object.assign(new Error('x'), { code: p.endsWith('nf') ? 'ENOENT' : 'EACCES' }); },
    });

    // Act / Assert
    assert.equal(real('C:\\a\\nf'), null);
    assert.deepEqual(real('C:\\a\\denied'), { error: true });
});

test('Paths_RuleFolderGivenAsShortName_WritesFailClosedWithoutRealLocationMatch', () => { // T5 AC-13: a normal rule matches only its written pattern
    // Arrange: the temp placeholder came from an environment variable holding the 8.3 form
    const disk = fakeRealpath({ 'C:\\': 'C:\\', 'C:\\Users': 'C:\\Users', 'C:\\Users\\TESTER~1': 'C:\\Users\\Tester', 'C:\\Users\\TESTER~1\\Temp': 'C:\\Users\\Tester\\Temp', 'C:\\Users\\Tester': 'C:\\Users\\Tester', 'C:\\Users\\Tester\\Temp': 'C:\\Users\\Tester\\Temp' });
    const policy = compileDirectoryPolicy([{ id: 'temp', pattern: 'C:\\Users\\TESTER~1\\Temp\\**', level: 'normal', allow: ['read', 'write'] }], { realpath: disk });

    // Act
    const long = pathVerdict('C:\\Users\\Tester\\Temp\\x.txt', 'write', policy);
    const short = pathVerdict('C:\\Users\\TESTER~1\\Temp\\x.txt', 'write', policy);

    // Assert: the real location of the short form is the long form, which the 8.3 pattern no longer matches (fail-closed: AI, was SAFE via temp)
    assert.equal(long.verdict, 'AI');
    assert.deepEqual(long.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(long.directoryId, null);
    assert.equal(short.verdict, 'AI');
    assert.deepEqual(short.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(short.directoryId, null);
});

test('Paths_RealpathResults_AreCachedBrieflyAndRefreshed', () => {
    // Arrange
    const disk = fakeRealpath({ 'C:\\': 'C:\\', [HOME]: HOME });
    const clock = createFakeClock();
    const policy = policyFor({ realpath: disk, now: () => clock.now() });
    const file = `${HOME}\\a\\b.txt`;
    pathVerdict(file, 'read', policy);
    const first = disk.calls.length;

    // Act
    pathVerdict(file, 'read', policy);
    const within = disk.calls.length;
    clock.advance(1500);
    pathVerdict(file, 'read', policy);
    const after = disk.calls.length;

    // Assert
    assert.ok(first > 0);
    assert.equal(within, first, 'second call within the TTL reuses the result');
    assert.ok(after > within, 'after the TTL the disk is asked again');
});

// Real file system: synthetic folders under the temp folder only.
const FS_DIR_NAME = 'secret-vault-with-a-long-folder-name';
function withSyntheticTree(t) {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'sg-paths-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const repo = join(base, 'repo');
    const vault = join(base, FS_DIR_NAME);
    const other = join(base, 'elsewhere');
    for (const d of [join(repo, '.git'), vault, other]) mkdirSync(d, { recursive: true });
    writeFileSync(join(vault, 'token.txt'), 'synthetic');
    writeFileSync(join(other, 'data.txt'), 'synthetic');
    const entries = [
        { id: 'repo', repo: true, level: 'normal', allow: ['read', 'write', 'delete', 'execute'] },
        { id: 'secret-vault', pattern: `${vault}\\**`, level: 'secret', allow: [] },
    ];
    return { base, repo, vault, other, entries };
}
const tryJunction = (target, link) => {
    try {
        symlinkSync(target, link, 'junction');
        return true;
    } catch {
        return false;
    }
};
function shortNameOf(parent, longName) {
    try {
        const out = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/ad', parent], { encoding: 'utf8', windowsHide: true });
        const line = out.split(/\r?\n/).find((l) => l.toLowerCase().endsWith(` ${longName.toLowerCase()}`));
        const m = line && /\s([^\s]+~\d+[^\s]*)\s+\S+$/.exec(line);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

test('Paths_RealFs_JunctionInRepoToSecretFolder_ReadAndWriteAsk', (t) => {
    // Arrange
    const { repo, vault, entries } = withSyntheticTree(t);
    if (!tryJunction(vault, join(repo, 'link'))) return t.skip('junctions cannot be created here');
    const policy = compileDirectoryPolicy(entries, { repoRoot: repo });

    // Act
    const read = pathVerdict(join(repo, 'link', 'token.txt'), 'read', policy);
    const write = pathVerdict(join(repo, 'link', 'new.txt'), 'write', policy);

    // Assert
    assert.equal(read.verdict, 'ASK');
    assert.deepEqual(read.ruleIds, ['DIR-SECRET']);
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-SECRET']);
});

test('Paths_RealFs_JunctionInRepoToUnruledFolder_WriteIsNotAllowed', (t) => {
    // Arrange: the repo rule would allow the write by its lexical path, the real target is outside every rule
    const { repo, other, entries } = withSyntheticTree(t);
    if (!tryJunction(other, join(repo, 'out'))) return t.skip('junctions cannot be created here');
    const policy = compileDirectoryPolicy(entries, { repoRoot: repo });

    // Act
    const write = pathVerdict(join(repo, 'out', 'data.txt'), 'write', policy);
    const read = pathVerdict(join(repo, 'out', 'data.txt'), 'read', policy);
    const plain = pathVerdict(join(repo, 'src', 'a.txt'), 'write', policy);

    // Assert
    assert.equal(write.verdict, 'AI');
    assert.deepEqual(write.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(read.verdict, 'SAFE');
    assert.equal(plain.verdict, 'SAFE');
    assert.equal(plain.directoryId, 'repo');
});

test('Paths_RepoRootLink_RealTargetIsOutside', (t) => {
    // Arrange: the written repo root is a junction to the real repo; the repo rule matches only the written root (AC-15)
    const { base, repo, entries } = withSyntheticTree(t);
    const via = join(base, 'repo-link');
    if (!tryJunction(repo, via)) return t.skip('junctions cannot be created here');
    const policy = compileDirectoryPolicy(entries, { repoRoot: via });

    // Act
    const lexical = pathVerdict(join(via, 'a.txt'), 'write', policy);
    const real = pathVerdict(join(repo, 'a.txt'), 'write', policy);

    // Assert: the write through the linked root lands outside every rule, like a junction into an unruled folder
    assert.equal(lexical.verdict, 'AI');
    assert.deepEqual(lexical.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(lexical.directoryId, null);
    assert.equal(real.verdict, 'AI');
    assert.deepEqual(real.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(real.directoryId, null);
});

test('Paths_RepoRootNotALink_WriteStaysSafe', (t) => {
    // Arrange: the written repo root is a real folder, so writes under it are inside the repo rule (AC-15)
    const { repo, entries } = withSyntheticTree(t);
    const policy = compileDirectoryPolicy(entries, { repoRoot: repo });

    // Act
    const write = pathVerdict(join(repo, 'a.txt'), 'write', policy);
    const nested = pathVerdict(join(repo, 'src', 'deep', 'b.txt'), 'write', policy);

    // Assert
    assert.equal(write.verdict, 'SAFE');
    assert.equal(write.directoryId, 'repo');
    assert.equal(nested.verdict, 'SAFE');
    assert.equal(nested.directoryId, 'repo');
});

test('Paths_RealFs_ShortNameOfSecretFolder_Asks', (t) => {
    // Arrange
    const { base, vault, entries } = withSyntheticTree(t);
    const short = shortNameOf(base, FS_DIR_NAME);
    if (!short) return t.skip('8.3 short names are not enabled on this volume');
    const policy = compileDirectoryPolicy(entries, { repoRoot: null });

    // Act
    const existing = pathVerdict(join(base, short, 'token.txt'), 'read', policy);
    const missing = pathVerdict(join(base, short, 'new-file.txt'), 'write', policy);
    const unresolved = pathVerdict(join(base, 'NOSUCH~1', 'x.txt'), 'read', policy);

    // Assert
    assert.notEqual(short.toLowerCase(), FS_DIR_NAME);
    assert.equal(existing.verdict, 'ASK');
    assert.deepEqual(existing.ruleIds, ['DIR-SECRET']);
    assert.equal(missing.verdict, 'ASK');
    assert.deepEqual(missing.ruleIds, ['DIR-SECRET']);
    assert.deepEqual(unresolved.ruleIds, ['DIR-SHORTNAME-UNRESOLVED']);
    assert.ok(vault.length > 0);
});

// ---------- TFIX-2a W3: persistence locations are protected ----------

test('Paths_GovernorRuntimeFolders_AreSecretForEveryIntent', () => {
    // Arrange: logs, review files and the local judge/replay home of the governor are more specific than its protected extensions folder
    const policy = policyFor({});
    const cases = [
        [`${COPILOT_HOME}\\extensions\\shell-governor\\logs\\audit-2026-10-19.jsonl`, 'governor-logs'],
        [`${COPILOT_HOME}\\extensions\\shell-governor\\reviews\\review-1.md`, 'governor-reviews'],
        [`${COPILOT_HOME}\\extensions\\shell-governor\\.local\\replay\\out.json`, 'governor-local'],
        [`${COPILOT_HOME}\\extensions\\shell-governor\\logs.\\a.log`, 'governor-logs'],
    ];

    for (const [file, id] of cases) {
        for (const intent of ['read', 'write', 'delete', 'execute']) {
            // Act
            const verdict = pathVerdict(file, intent, policy);

            // Assert
            assert.equal(verdict.verdict, 'ASK', `${intent} ${file}`);
            assert.deepEqual(verdict.ruleIds, ['DIR-SECRET'], `${intent} ${file}`);
            assert.equal(verdict.directoryId, id, `${intent} ${file}`);
        }
    }
    const code = pathVerdict(`${COPILOT_HOME}\\extensions\\shell-governor\\lib\\paths.mjs`, 'read', policy);
    assert.equal(code.verdict, 'SAFE', 'the governor source stays readable');
});

test('Paths_PersistenceLocations_WriteAsksReadIsSafe', () => {
    // Arrange
    const policy = policyFor({});
    const locations = [
        [`${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat`, 'startup-user'],
        ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\x.bat', 'startup-all-users'],
        [`${HOME}\\Documents\\PowerShell\\profile.ps1`, 'powershell-profile'],
        [`${HOME}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`, 'windows-powershell-profile'],
        [`${HOME}\\OneDrive - Contoso\\Documents\\PowerShell\\profile.ps1`, 'powershell-profile-onedrive'],
        [`${HOME}\\OneDrive\\Documents\\WindowsPowerShell\\profile.ps1`, 'windows-powershell-profile-onedrive'],
        [`${REPO}\\.git\\hooks\\pre-commit`, 'git-hooks'],
        ['C:\\Windows\\System32\\Tasks\\evil', 'scheduled-tasks'],
    ];

    for (const [file, id] of locations) {
        // Act
        const write = pathVerdict(file, 'write', policy);
        const read = pathVerdict(file, 'read', policy);

        // Assert
        assert.equal(write.verdict, 'ASK', file);
        assert.match(write.ruleIds[0], /^DIR-PROTECTED-WRITE$/, file);
        assert.equal(write.directoryId, id, file);
        assert.equal(read.verdict, 'SAFE', file);
    }
});

test('Paths_GitHooksOfAnyRepo_AreProtectedButRepoFilesAreNot', () => {
    // Arrange
    const policy = policyFor({});

    // Act
    const hook = pathVerdict(`${REPO}\\sub\\.git\\hooks\\post-checkout`, 'write', policy);
    const hookVariant = pathVerdict(`${REPO}\\.git.\\hooks\\pre-push`, 'write', policy);
    const source = pathVerdict(`${REPO}\\src\\hooks\\a.ts`, 'write', policy);

    // Assert
    assert.equal(hook.verdict, 'ASK');
    assert.equal(hookVariant.verdict, 'ASK');
    assert.equal(source.verdict, 'SAFE');
});

// ---------- T5 AC-13: links can only add restrictions ----------

const PLAN_LINK = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\plan.md`;
const SESSION_FILES = `${COPILOT_HOME}\\session-state\\${SESSION_ID}\\files`;
const STARTUP = `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;

/** Injected realpath over the test home with the given links (lower-case table keys); every other path is ENOENT like fs. */
const linkDisk = (links) => fakeRealpath({
    'C:\\': 'C:\\',
    'C:\\Users': 'C:\\Users',
    [HOME]: HOME,
    [COPILOT_HOME]: COPILOT_HOME,
    ...links,
});

test('Paths_PlanFileLinkedToSettings_SettingsWriteAsks', () => {
    // Arrange: session-state\<id>\plan.md is a link to the copilot home's settings.json
    const policy = policyFor({ realpath: linkDisk({ [PLAN_LINK]: `${COPILOT_HOME}\\settings.json` }) });

    // Act
    const write = pathVerdict(`${COPILOT_HOME}\\settings.json`, 'write', policy);

    // Assert
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(write.directoryId, 'copilot-home');
});

test('Paths_WriteThroughLinkedPlanFile_Asks', () => {
    // Arrange
    const policy = policyFor({ realpath: linkDisk({ [PLAN_LINK]: `${COPILOT_HOME}\\settings.json` }) });

    // Act: the normal rule allows the written path, the resolved target is protected
    const write = pathVerdict(PLAN_LINK, 'write', policy);

    // Assert
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(write.directoryId, 'copilot-home');
});

test('Paths_SessionFilesJunctionToCopilotHome_WriteAsks', () => {
    // Arrange: the session files folder is a junction to the copilot home
    const policy = policyFor({ realpath: linkDisk({ [SESSION_FILES]: COPILOT_HOME }) });

    // Act
    const write = pathVerdict(`${SESSION_FILES}\\x.txt`, 'write', policy);

    // Assert
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(write.directoryId, 'copilot-home');
});

test('Paths_LinkIntoStartupFolder_StillAsks', () => {
    // Arrange: protected rules keep link matching. A temp link into the Startup folder, and a Startup folder that is itself a junction
    const policy = policyFor({ realpath: linkDisk({ [`${TEMP}\\link`]: STARTUP }) });
    const junctioned = policyFor({ realpath: linkDisk({ [STARTUP]: 'D:\\Autostart', [`${TEMP}\\link`]: 'D:\\Autostart' }) });

    // Act
    const linked = pathVerdict(`${TEMP}\\link\\evil.bat`, 'write', policy);
    const viaFolder = pathVerdict(`${TEMP}\\link\\evil.bat`, 'write', junctioned);

    // Assert
    assert.equal(linked.verdict, 'ASK');
    assert.deepEqual(linked.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(linked.directoryId, 'startup-user');
    assert.equal(viaFolder.verdict, 'ASK');
    assert.deepEqual(viaFolder.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(viaFolder.directoryId, 'startup-user');
});

test('Paths_ReportsLinkedToCopilotHome_WriteAsks', () => {
    // Arrange: the reports folder is a junction to the copilot home
    const policy = policyFor({ realpath: linkDisk({ [`${COPILOT_HOME}\\reports`]: COPILOT_HOME }) });

    // Act
    const write = pathVerdict(`${COPILOT_HOME}\\reports\\2026-10-19\\report.md`, 'write', policy);

    // Assert
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(write.directoryId, 'copilot-home');
});

test('Paths_PlanFileLinkedOutsideRules_WriteIsOutside', () => {
    // Arrange: session-state\<id>\plan.md is a link to a plain file in Documents, which no rule covers
    const policy = policyFor({ realpath: linkDisk({ [PLAN_LINK]: `${HOME}\\Documents\\notes.txt` }) });

    // Act
    const write = pathVerdict(PLAN_LINK, 'write', policy);

    // Assert: the written path is a normal work area, the resolved target is outside every rule
    assert.equal(write.verdict, 'AI');
    assert.deepEqual(write.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(write.directoryId, null);
});

test('Paths_SessionScriptsJunction_ExecuteIsOutsideReadSafe', () => {
    // Arrange: session-state\scripts is a junction to a non-copilot folder; the script was there before this session
    const policy = policyFor({
        realpath: linkDisk({ [SCRIPTS]: 'D:\\Scripts' }),
        scriptStatus: () => 'pre-existing',
    });

    // Act
    const execute = pathVerdict(`${SCRIPTS}\\build.ps1`, 'execute', policy);
    const read = pathVerdict(`${SCRIPTS}\\build.ps1`, 'read', policy);

    // Assert
    assert.equal(execute.verdict, 'AI');
    assert.deepEqual(execute.ruleIds, ['DIR-OUTSIDE']);
    assert.equal(execute.directoryId, null);
    assert.equal(read.verdict, 'SAFE');
    assert.notEqual(read.level, 'secret');
});

test('Paths_LinkToSshFolder_SecretAsks', () => {
    // Arrange: session-state\<id>\plan.md is a link to a file in the user's .ssh folder
    const policy = policyFor({ realpath: linkDisk({ [PLAN_LINK]: `${HOME}\\.ssh\\config` }) });

    // Act
    const write = pathVerdict(PLAN_LINK, 'write', policy);

    // Assert: protected and secret rules match through the real location
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-SECRET']);
    assert.equal(write.directoryId, 'secret-ssh');
});

// ---------- TFIX-3: PowerShell wildcards in path segments ----------

/** Injected folder listing: lower-case folder path → entry names; a folder that is not listed does not exist (null). */
function fakeListDir(tree, { calls = [], fail = [] } = {}) {
    const map = new Map(Object.entries(tree).map(([k, v]) => [k.toLowerCase(), v]));
    return Object.assign((dir) => {
        calls.push(dir);
        if (fail.some((f) => f.toLowerCase() === dir.toLowerCase())) throw new Error('EACCES');
        return map.get(dir.toLowerCase().replace(/\\+$/, '')) ?? null;
    }, { calls });
}
const names = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('Paths_Wildcard_SegmentThatExpandsToSecretFolder_ReadAsks', () => {
    // Arrange: ".s*" matches ".ssh" on disk
    const listDir = fakeListDir({ [HOME]: ['Documents', '.ssh', '.config'], [`${HOME}\\.ssh`]: ['id_rsa'] });
    const policy = policyFor({ listDir });

    for (const pattern of [`${HOME}\\.s*\\id_rsa`, `${HOME}\\.ss?\\id_rsa`, `${HOME}\\.[s]sh\\id_rsa`, `${HOME}\\*\\id_rsa`, `${HOME}\\.ssh\\id_*`]) {
        // Act
        const verdict = pathVerdict(pattern, 'read', policy);

        // Assert
        assert.equal(verdict.verdict, 'ASK', pattern);
        assert.deepEqual(verdict.ruleIds, ['DIR-SECRET'], pattern);
    }
});

test('Paths_Wildcard_LastSegmentMatchingSecretFolderItself_Asks', () => {
    // Arrange
    const policy = policyFor({ listDir: fakeListDir({ [HOME]: ['.ssh', 'notes'] }) });

    // Act
    const verdict = pathVerdict(`${HOME}\\.ss*`, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
});

test('Paths_Wildcard_MatchesAreCaseInsensitiveAndEscapedWildcardIsLiteral', () => {
    // Arrange
    const policy = policyFor({ listDir: fakeListDir({ [HOME]: ['.SSH', 'a*b'], [`${HOME}\\.SSH`]: ['id_rsa'] }) });

    // Act
    const upper = pathVerdict(`${HOME}\\.s*\\id_rsa`, 'read', policy);
    const escaped = pathVerdict(`${HOME}\\.s\`*\\id_rsa`, 'read', policy);

    // Assert
    assert.equal(upper.verdict, 'ASK');
    assert.equal(escaped.verdict, 'SAFE', 'a backtick makes the star a literal character');
});

test('Paths_Wildcard_OrdinaryPattern_IsSafeRead', () => {
    // Arrange
    const listDir = fakeListDir({ [REPO]: ['a.cs', 'b.cs', 'c.txt', 'src'] });
    const policy = policyFor({ listDir });

    // Act
    const verdict = pathVerdict(`${REPO}\\*.cs`, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'SAFE');
    assert.equal(listDir.calls.length, 1);
});

test('Paths_Wildcard_PatternThatMatchesEnvFile_Asks', () => {
    // Arrange: "**\.env" is a secret rule for the matched file
    const policy = policyFor({ listDir: fakeListDir({ [REPO]: ['a.cs', '.env'] }) });

    // Act
    const verdict = pathVerdict(`${REPO}\\*`, 'read', policy);

    // Assert
    assert.equal(verdict.verdict, 'ASK');
    assert.deepEqual(verdict.ruleIds, ['DIR-SECRET']);
});

test('Paths_Wildcard_PathWithoutWildcard_DoesNotTouchTheFileSystem', () => {
    // Arrange
    const listDir = fakeListDir({});
    const policy = policyFor({ listDir });

    // Act
    pathVerdict(`${REPO}\\src\\a.cs`, 'read', policy);
    pathVerdict(`${HOME}\\.ssh\\id_rsa`, 'write', policy);

    // Assert
    assert.equal(listDir.calls.length, 0);
});

test('Paths_Wildcard_NothingExistsYet_WriteToSecretOrProtectedBaseAsks', () => {
    // Arrange: the folders do not exist; a write could create them
    const policy = policyFor({ listDir: fakeListDir({ [HOME]: ['Documents'] }) });

    // Act
    const secretWrite = pathVerdict(`${HOME}\\.s*\\authorized_keys`, 'write', policy);
    const secretRead = pathVerdict(`${HOME}\\.s*\\authorized_keys`, 'read', policy);
    const protectedWrite = pathVerdict(`${HOME}\\Docu*\\PowerShell\\profile.ps1`, 'write', policy);
    const ordinary = pathVerdict(`${REPO}\\out\\*`, 'delete', policy);

    // Assert
    assert.equal(secretWrite.verdict, 'ASK');
    assert.deepEqual(secretWrite.ruleIds, ['DIR-SECRET']);
    assert.equal(secretRead.verdict, 'SAFE', 'nothing to read when nothing exists');
    assert.equal(protectedWrite.verdict, 'ASK');
    assert.deepEqual(protectedWrite.ruleIds, ['DIR-PROTECTED-WRITE']);
    assert.equal(ordinary.verdict, 'SAFE');
});

test('Paths_Wildcard_TooManyMatches_ReadIsAiWriteIsAsk', () => {
    // Arrange: 201 matches
    const policy = policyFor({ listDir: fakeListDir({ [REPO]: names(201, (i) => `f${i}.cs`) }) });

    // Act
    const read = pathVerdict(`${REPO}\\*.cs`, 'read', policy);
    const write = pathVerdict(`${REPO}\\*.cs`, 'write', policy);

    // Assert
    assert.equal(read.verdict, 'AI');
    assert.deepEqual(read.ruleIds, ['DIR-WILDCARD-UNBOUNDED']);
    assert.equal(write.verdict, 'ASK');
    assert.deepEqual(write.ruleIds, ['DIR-WILDCARD-UNBOUNDED']);
});

test('Paths_Wildcard_ExactlyTheLimitOfMatches_IsEvaluated', () => {
    // Arrange: 200 matches are allowed
    const policy = policyFor({ listDir: fakeListDir({ [REPO]: names(200, (i) => `f${i}.cs`) }) });

    // Act
    const read = pathVerdict(`${REPO}\\*.cs`, 'read', policy);

    // Assert
    assert.equal(read.verdict, 'SAFE');
});

test('Paths_Wildcard_TooManyEntriesScanned_IsUnbounded', () => {
    // Arrange: only 3 matches, but more than 2000 entries have to be looked at
    const tree = { [REPO]: names(1500, (i) => `d${i}`).concat(['x1', 'x2', 'x3']) };
    for (const x of ['x1', 'x2', 'x3']) tree[`${REPO}\\${x}`] = names(1000, (j) => `n${j}`);
    const policy = policyFor({ listDir: fakeListDir(tree) });

    // Act
    const read = pathVerdict(`${REPO}\\x*\\n99?`, 'read', policy);

    // Assert
    assert.equal(read.verdict, 'AI');
    assert.deepEqual(read.ruleIds, ['DIR-WILDCARD-UNBOUNDED']);
});

test('Paths_Wildcard_ListingFails_IsUnboundedAndMissingFolderIsEmpty', () => {
    // Arrange
    const failing = policyFor({ listDir: fakeListDir({ [REPO]: ['a'] }, { fail: [REPO] }) });
    const missing = policyFor({ listDir: fakeListDir({}) });

    // Act
    const failed = pathVerdict(`${REPO}\\*.cs`, 'read', failing);
    const absent = pathVerdict(`${REPO}\\nope\\*.cs`, 'read', missing);

    // Assert
    assert.deepEqual(failed.ruleIds, ['DIR-WILDCARD-UNBOUNDED']);
    assert.equal(failed.verdict, 'AI');
    assert.equal(absent.verdict, 'SAFE');
});

test('Paths_Wildcard_InvalidSet_MatchesEverythingInsteadOfThrowing', () => {
    // Arrange: "[z-a]" is an invalid range
    const policy = policyFor({ listDir: fakeListDir({ [HOME]: ['.ssh', 'docs'] }) });

    // Act
    const write = pathVerdict(`${HOME}\\[z-a]sh\\id_rsa`, 'write', policy);
    const read = pathVerdict(`${HOME}\\[z-a]*\\id_rsa`, 'read', policy);

    // Assert
    assert.equal(write.verdict, 'ASK');
    assert.equal(read.verdict, 'ASK');
    assert.deepEqual(read.ruleIds, ['DIR-SECRET']);
});

test('Paths_Wildcard_RealFs_ExpandsHiddenFolderToSecretRule', (t) => {
    // Arrange: synthetic folders under the temp folder only
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'sg-wild-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const home = join(base, 'home');
    const repo = join(base, 'repo');
    for (const d of [join(home, '.ssh'), join(home, 'docs'), join(repo, '.git')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'synthetic');
    writeFileSync(join(repo, 'a.cs'), 'synthetic');
    const policy = compileDirectoryPolicy([
        { id: 'repo', repo: true, level: 'normal', allow: ['read', 'write', 'delete', 'execute'] },
        { id: 'secret-ssh', pattern: `${home}\\.ssh\\**`, level: 'secret', allow: [] },
    ], { repoRoot: repo });

    // Act
    const secret = pathVerdict(join(home, '.S*', 'id_rsa'), 'read', policy);
    const plain = pathVerdict(join(repo, '*.cs'), 'read', policy);
    const docs = pathVerdict(join(home, 'd?cs', '*'), 'read', policy);

    // Assert
    assert.equal(secret.verdict, 'ASK');
    assert.deepEqual(secret.ruleIds, ['DIR-SECRET']);
    assert.equal(plain.verdict, 'SAFE');
    assert.equal(docs.verdict, 'SAFE');
});

// ---------- TFIX-4: recursion roots that can reach a secret base ----------

test('Paths_ReachesSecretBase_EqualInsideAndAncestorOfConcreteBases', () => {
    // Arrange
    const policy = policyFor({});

    // Act / Assert: equal, ancestor (also the drive root), inside
    assert.equal(reachesSecretBase(`${HOME}\\.ssh`, policy), 'secret-ssh');
    assert.ok(reachesSecretBase(HOME, policy), 'the home is an ancestor of .ssh');
    assert.ok(reachesSecretBase('C:\\Users', policy));
    assert.ok(reachesSecretBase('C:\\', policy));
    assert.ok(reachesSecretBase(`${HOME}\\.ssh\\keys`, policy), 'inside a secret tree');
    assert.ok(reachesSecretBase(COPILOT_HOME, policy), 'the copilot home holds mcp-secrets and config.json');
    assert.ok(reachesSecretBase(`${COPILOT_HOME}\\extensions\\shell-governor`, policy), 'ancestor of the governor logs');
    assert.ok(reachesSecretBase(`${HOME}\\.config`, policy), 'ancestor of the concrete base .config\\gh\\hosts.yml');
    assert.ok(reachesSecretBase(HOME.toUpperCase(), policy), 'case-insensitive');
});

test('Paths_ReachesSecretBase_UnrelatedFoldersAndAnywhereGlobsDoNotCount', () => {
    // Arrange
    const policy = policyFor({});

    // Act / Assert: **\*.pem, **\.env and the like have no concrete base and never make every recursion a hit
    assert.equal(reachesSecretBase(`${COPILOT_HOME}\\session-state\\x`, policy), null);
    assert.equal(reachesSecretBase(`${HOME}\\Documents\\notes`, policy), null);
    assert.equal(reachesSecretBase('C:\\code\\proj', policy), null);
    assert.equal(reachesSecretBase(TEMP, policy), null);
    assert.equal(reachesSecretBase('D:\\data', policy), null);
    assert.equal(reachesSecretBase(`${HOME}\\.sshx`, policy), null, 'a sibling that only shares a prefix');
});

test('Paths_ReachesSecretBase_WildcardRootsAreMatchedPerSegment', () => {
    // Arrange
    const policy = policyFor({});

    // Act / Assert
    assert.ok(reachesSecretBase(`${HOME}\\*`, policy), 'the star can stand for the folder holding .ssh');
    assert.ok(reachesSecretBase(`C:\\Users\\Te*`, policy));
    assert.equal(reachesSecretBase(`${HOME}\\Doc*`, policy), null);
});