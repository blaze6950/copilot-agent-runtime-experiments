import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import { RATINGS } from '../../extensions/shell-governor/lib/contracts.mjs';
import { stage3 } from '../../extensions/shell-governor/lib/policy.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createConfigSandbox } from './helpers/fixtures.mjs';

const WINDOWS_ENV = Object.freeze({
    USERPROFILE: 'C:\\Users\\Tester',
    TEMP: 'C:\\Users\\Tester\\AppData\\Local\\Temp',
    APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
});

/** Opens a store on a sandbox with the directories group registered, collecting warnings into `warnings`. */
function openStore(sb, { warnings = [], env = WINDOWS_ENV, copilotHome = sb.copilotHome, clock = createFakeClock() } = {}) {
    const store = createConfigStore({
        rootDir: sb.root,
        copilotHome,
        env,
        clock,
        onWarning: (w) => warnings.push(w),
    });
    store.register('directories', sb.directoriesPath);
    return store;
}

/** Name → content of every file in a folder, used to prove a folder was not touched. */
function folderState(dir) {
    return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

test('Config_RealGovernorJson_HasNoUnreadTogglesBlockAndTruthfulReloadWording', () => {
    // Arrange
    const path = new URL('../../extensions/shell-governor/config/governor.json', import.meta.url);
    // Act
    const governor = JSON.parse(readFileSync(path, 'utf8'));
    // Assert: nothing reads `toggles`, so it must not exist; the reload wording matches the two stacked 1 s snapshots
    assert.equal(Object.hasOwn(governor, 'toggles'), false);
    assert.match(governor._about, /within about 2 seconds/);
    assert.doesNotMatch(governor._about, /next call/);
});

test('Config_RealGovernorJson_HasNoDialogScriptLines', () => {
    // Arrange
    const path = new URL('../../extensions/shell-governor/config/governor.json', import.meta.url);
    // Act
    const governor = JSON.parse(readFileSync(path, 'utf8'));
    // Assert: the shipped file leaves the dialog limit unset (full script shown); the knob is documented in _about
    assert.equal(governor.dialog?.scriptLines, undefined);
    assert.match(governor._about, /dialog\.scriptLines/);
    assert.match(governor._about, /within about 2 seconds/);
});

test('Config_RealGovernorJson_Stage3HasBothRelaxations', () => {
    // Arrange
    const path = new URL('../../extensions/shell-governor/config/governor.json', import.meta.url);
    const governor = JSON.parse(readFileSync(path, 'utf8'));
    const ratings = { values: Object.fromEntries(RATINGS.map((k) => [k, k === 'task_mismatch' ? 2 : 0])), confidence: 0.9 };
    // Act
    const decision = stage3(ratings, governor.stage3).decision;
    // Assert: both relaxation keys ship with the values the policy needs, and a lone task_mismatch of 2 is allowed
    assert.equal(governor.stage3.taskMismatchAloneAsksAt, 3);
    assert.equal(governor.stage3.credentialAccessReadOnlyAllowed, true);
    assert.equal(decision, 'ALLOW');
});

test('Config_ChangedFile_NextCallUsesNewValues', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const warnings = [];
    const store = openStore(sb, { warnings });
    assert.equal(store.get().governor.judge.timeoutMs, 30000);
    const base = JSON.parse(readFileSync(sb.configFile('governor.json'), 'utf8'));
    sb.write(sb.configFile('governor.json'), JSON.stringify({ ...base, judge: { ...base.judge, timeoutMs: 45000 } }));

    // Act
    const snapshot = store.get();

    // Assert
    assert.equal(snapshot.governor.judge.timeoutMs, 45000);
    assert.deepEqual(warnings, []);
});

test('Config_InvalidJson_KeepsLastValidAndWarns', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const warnings = [];
    const store = openStore(sb, { warnings });
    assert.equal(store.get().enabled, true);
    sb.write(sb.configFile('governor.json'), '{ "enabled": false, ');

    // Act
    const snapshot = store.get();
    store.get();

    // Assert
    assert.equal(snapshot.enabled, true, 'last valid config must stay in effect');
    assert.equal(snapshot.governor.enabled, true);
    assert.equal(warnings.length, 1, 'one warning per broken version, not one per call');
    assert.equal(warnings[0].code, 'CONFIG_INVALID_JSON');
    assert.match(warnings[0].file, /governor\.json$/);
});

test('Config_EnabledFalse_ReportsDisabled', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const warnings = [];
    sb.useVariant('governor-disabled.json', 'governor.json');
    const store = openStore(sb, { warnings });

    // Act
    const snapshot = store.get();

    // Assert
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.governor.enabled, false);
    assert.deepEqual(warnings, []);
});

test('Config_AgentOverride_CannotLoosenProtectedOrSecret', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const warnings = [];
    sb.useVariant('agents-override.json', 'agents.json');
    const store = openStore(sb, { warnings });

    // Act
    const policy = store.agentPolicy('sub-attacker');
    const rule = (id) => policy.directories.find((r) => r.id === id);

    // Assert
    assert.equal(rule('copilot-home').level, 'protected');
    assert.deepEqual(rule('copilot-home').allow, ['read'], 'protected rule must not gain write');
    assert.equal(rule('secret-ssh').level, 'secret', 'secret rule must not be downgraded');
    assert.deepEqual(rule('temp').allow, ['read'], 'a normal rule may still be tightened');
    const rejected = warnings.filter((w) => w.code === 'AGENT_OVERRIDE_REJECTED').map((w) => w.message);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.some((m) => m.includes('copilot-home')));
    assert.ok(rejected.some((m) => m.includes('secret-ssh')));
});

test('Config_Placeholders_ResolveHomeTempAppdataCopilotHome', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const store = openStore(sb, { copilotHome: 'C:\\Users\\Tester\\.copilot' });

    // Act
    const policy = store.agentPolicy('sub-explorer-code');
    const patterns = Object.fromEntries(policy.directories.filter((r) => r.pattern).map((r) => [r.id, r.pattern]));

    // Assert
    assert.deepEqual(patterns, {
        temp: 'C:\\Users\\Tester\\AppData\\Local\\Temp\\**',
        'copilot-home': 'C:\\Users\\Tester\\.copilot\\**',
        'secret-ssh': 'C:\\Users\\Tester\\.ssh\\**',
        'user-secrets': 'C:\\Users\\Tester\\AppData\\Roaming\\Microsoft\\UserSecrets\\**',
        'chrome-profile': 'C:\\Users\\Tester\\AppData\\Local\\Google\\Chrome\\User Data\\**',
    });
});

test('Config_CliToolsAccess_ReadOnlyMappedPerAgent', (t) => {
    // Arrange
    const sb = createConfigSandbox();
    t.after(() => sb.remove());
    const toolsDir = join(sb.copilotHome, 'cli-tools');
    const before = folderState(toolsDir);
    const store = openStore(sb);

    // Act
    const prod = store.agentPolicy('sub-expert-snow-prod').cliTools;
    const nonprod = store.agentPolicy('sub-expert-snow-nonprod').cliTools;
    const unknown = store.agentPolicy('sub-explorer-code').cliTools;

    // Assert
    assert.equal(prod.snow, 'read-only');
    assert.equal(nonprod.snow, 'default');
    assert.equal(unknown.snow, undefined, 'an agent without the tool gets no mapping for it');
    assert.equal(prod.git, 'default', 'shared _shell.json tools apply to every agent');
    assert.equal(unknown.git, 'default');
    assert.deepEqual(folderState(toolsDir), before, 'cli-tools must be read-only for the governor');
});
