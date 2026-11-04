import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import * as paths from '../../extensions/shell-governor/lib/paths.mjs';
import { compileDirectoryPolicy, registerDirectoryPolicy } from '../../extensions/shell-governor/lib/paths.mjs';
import { evaluateReadTool, READ_ARGS_RULE, READ_TARGET_RULE } from '../../extensions/shell-governor/lib/read-tools.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'shell-governor');
const HOME = 'C:\\Users\\Tester';
const COPILOT_HOME = `${HOME}\\.copilot`;
const APPDATA = `${HOME}\\AppData\\Roaming`;
const LOCALAPPDATA = `${HOME}\\AppData\\Local`;
const TEMP = `${HOME}\\AppData\\Local\\Temp`;
const ENV = Object.freeze({ USERPROFILE: HOME, TEMP, APPDATA, LOCALAPPDATA });
const SESSION_ID = '0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e';
const REPO = 'C:\\code\\proj';
const SECRET_SSH_DIR = `${HOME}\\.ssh`;
const SECRET_MCP_DIR = `${COPILOT_HOME}\\mcp-secrets`;

/** Config store on the extension root with the production directories file registered. */
function openStore() {
    const store = createConfigStore({
        rootDir: EXTENSION_DIR,
        copilotHome: COPILOT_HOME,
        env: ENV,
        clock: createFakeClock(),
        onWarning: () => {},
    });
    registerDirectoryPolicy(store);
    return store;
}

const STORE = openStore();

/** Realpath stand-in for a file system where nothing exists behind a path (every lookup throws ENOENT). */
const missing = () => {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
};

/** Injected folder listing: lower-case folder path → entry names; a folder that is not listed does not exist (null). */
function fakeListDir(tree) {
    const map = new Map(Object.entries(tree).map(([k, v]) => [k.toLowerCase(), v]));
    return (dir) => map.get(dir.toLowerCase().replace(/\\+$/, '')) ?? null;
}

const names = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/** Directory policy of the main agent for the repository REPO, with the given realpath and folder listing. */
function directoryPolicy({ realpath = missing, listDir } = {}) {
    return compileDirectoryPolicy(STORE.agentPolicy('main').directories, { sessionId: SESSION_ID, repoRoot: REPO, realpath, listDir });
}

test('ReadTools_ViewOrdinaryFile_Safe', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: `${REPO}\\README.md` };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.deepEqual(decision.ruleIds, ['DIR-OK']);
    assert.deepEqual(decision.findings, []);
});

test('ReadTools_ViewSecretFile_AsksDirSecret', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: `${SECRET_SSH_DIR}\\id_rsa` };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
});

test('ReadTools_ViewRelativePath_ResolvedAgainstCwd', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: 'src\\a.cs' };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.deepEqual(decision.targets, [`${REPO}\\src\\a.cs`]);
});

test('ReadTools_ViewRelativePathWithoutCwd_AsksTargetUnresolved', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: 'src\\a.cs' };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, [READ_TARGET_RULE]);
    assert.deepEqual(decision.targets, ['unresolved: src\\a.cs']);
});

test('ReadTools_ViewUncPath_AsksTargetUnresolved', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: '\\\\server\\share\\x' };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, [READ_TARGET_RULE]);
    assert.deepEqual(decision.targets, ['unresolved: \\\\server\\share\\x']);
});

test('ReadTools_ViewWithoutPathOrNonObjectArgs_AsksArgsUnrecognised', () => {
    // Arrange
    const policy = directoryPolicy();

    // Act
    const withoutPath = evaluateReadTool({ tool: 'view', args: {}, cwd: REPO, policy, home: HOME });
    const nonObject = evaluateReadTool({ tool: 'view', args: 'x', cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(withoutPath.verdict, 'ASK');
    assert.deepEqual(withoutPath.ruleIds, [READ_ARGS_RULE]);
    assert.equal(nonObject.verdict, 'ASK');
    assert.deepEqual(nonObject.ruleIds, [READ_ARGS_RULE]);
});

test('ReadTools_GrepPathsArrayWithOneSecret_Asks', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'token', paths: [REPO, SECRET_MCP_DIR] };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
    assert.deepEqual(decision.targets, [REPO, SECRET_MCP_DIR]);
});

test('ReadTools_GrepPathsString_Safe', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'TODO', paths: REPO };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.deepEqual(decision.ruleIds, ['DIR-OK']);
    assert.deepEqual(decision.targets, [REPO]);
});

test('ReadTools_GrepSingularPath_Evaluated', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'token', path: SECRET_SSH_DIR };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
    assert.deepEqual(decision.targets, [SECRET_SSH_DIR]);
});

test('ReadTools_GrepGlobFilter_NotTreatedAsPath', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: '*.cs', paths: REPO, glob: '**/.ssh/*' };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.deepEqual(decision.targets, [REPO]);
});

test('ReadTools_GrepPathsAndPathTogether_BothChecked', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'token', paths: [REPO], path: SECRET_SSH_DIR };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
    assert.deepEqual(decision.targets, [REPO, SECRET_SSH_DIR]);
});

test('ReadTools_GlobPathsAndPathTogether_BothChecked', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: '**/*.cs', paths: [REPO], path: SECRET_SSH_DIR };

    // Act
    const decision = evaluateReadTool({ tool: 'glob', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
    assert.deepEqual(decision.targets, [REPO, SECRET_SSH_DIR]);
});

test('ReadTools_GlobWithoutPaths_UsesWorkingDirectory', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: '**/*.cs' };

    // Act
    const inSecretDirectory = evaluateReadTool({ tool: 'glob', args, cwd: SECRET_SSH_DIR, policy, home: HOME });
    const inRepo = evaluateReadTool({ tool: 'glob', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(inSecretDirectory.verdict, 'ASK');
    assert.deepEqual(inSecretDirectory.ruleIds, ['DIR-SECRET']);
    assert.equal(inRepo.verdict, 'SAFE');
    assert.deepEqual(inRepo.targets, [REPO]);
});

test('ReadTools_GlobWithoutPathsOrCwd_AsksArgsUnrecognised', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: '**/*.cs' };

    // Act
    const decision = evaluateReadTool({ tool: 'glob', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, [READ_ARGS_RULE]);
});

test('ReadTools_GrepEmptyOrNonStringPaths_AsksArgsUnrecognised', () => {
    // Arrange
    const policy = directoryPolicy();
    const invalidPaths = [[], [42], '  '];

    // Act
    const decisions = invalidPaths.map((value) => evaluateReadTool({ tool: 'grep', args: { pattern: 'x', paths: value }, cwd: REPO, policy, home: HOME }));

    // Assert
    for (const decision of decisions) {
        assert.equal(decision.verdict, 'ASK');
        assert.deepEqual(decision.ruleIds, [READ_ARGS_RULE]);
    }
});

test('ReadTools_WildcardTooManyMatches_AiBecomesAsk', () => {
    // Arrange
    const listDir = fakeListDir({ [REPO]: names(201, (i) => `file${i}.cs`) });
    const policy = directoryPolicy({ listDir });
    const args = { path: `${REPO}\\*.cs` };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-WILDCARD-UNBOUNDED']);
    assert.match(decision.findings[0].explanation, /never go to the AI judge/);
});

test('ReadTools_RealpathError_AiBecomesAsk', () => {
    // Arrange
    const denied = () => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    };
    const policy = directoryPolicy({ realpath: denied });
    const args = { path: `${REPO}\\README.md` };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: REPO, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-REALPATH-UNRESOLVED']);
});

test('ReadTools_GrepRootAboveSecretBase_AsksSecretRootSearch', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'x', paths: HOME };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['READ-SECRET-ROOT-SEARCH']);
    assert.equal(decision.findings.length, 1);
    const explanation = decision.findings[0].explanation;
    assert.ok(explanation.includes('secret-ssh'));
    assert.equal(explanation.includes(HOME), false, 'explanation names no path');
    assert.equal(explanation.includes('\\'), false, 'explanation names no path');
    assert.ok(decision.secretRootRuleIds.includes('secret-ssh'));
});

test('ReadTools_GlobRootAboveSecretBase_SafeAndCounted', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: '*', paths: HOME };

    // Act
    const decision = evaluateReadTool({ tool: 'glob', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.ok(decision.secretRootRuleIds.includes('secret-ssh'));
});

test('ReadTools_ViewOfFolderAboveSecretBase_Unchanged', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { path: HOME };

    // Act
    const decision = evaluateReadTool({ tool: 'view', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'SAFE');
    assert.deepEqual(decision.secretRootRuleIds, []);
});

test('ReadTools_GrepSecretTarget_KeepsDirSecretOnly', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'x', paths: SECRET_SSH_DIR };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: null, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['DIR-SECRET']);
});

test('ReadTools_GrepWorkingDirectoryAboveSecretBase_Asks', () => {
    // Arrange
    const policy = directoryPolicy();
    const args = { pattern: 'x' };

    // Act
    const decision = evaluateReadTool({ tool: 'grep', args, cwd: HOME, policy, home: HOME });

    // Assert
    assert.equal(decision.verdict, 'ASK');
    assert.deepEqual(decision.ruleIds, ['READ-SECRET-ROOT-SEARCH']);
});

test('Paths_SecretBasesReached_ReturnsEveryReachedRuleInOrder', () => {
    // Arrange
    const policy = directoryPolicy();

    // Act
    const reached = paths.secretBasesReached(HOME, policy);
    const outsideDrive = paths.secretBasesReached('\\\\server\\share', policy);

    // Assert
    assert.ok(reached.includes('secret-ssh'));
    assert.ok(reached.includes('governor-logs'));
    assert.ok(reached.indexOf('governor-logs') < reached.indexOf('secret-ssh'), 'ids follow policy.rules order');
    assert.equal(new Set(reached).size, reached.length, 'each id once');
    assert.deepEqual(outsideDrive, []);
});

test('Paths_SecretBasesReached_UnknownRealLocation_ReturnsRealpathRule', () => {
    // Arrange
    const denied = () => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    };
    const policy = directoryPolicy({ realpath: denied });

    // Act
    const reached = paths.secretBasesReached(REPO, policy);

    // Assert
    assert.deepEqual(reached, ['DIR-REALPATH-UNRESOLVED']);
});
