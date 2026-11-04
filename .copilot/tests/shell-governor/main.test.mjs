// main.mjs wiring checks (T9 review fixes F4, F7, F9). main.mjs imports the Copilot SDK, which only exists inside the CLI, so
// each case runs main.mjs in a child node process with a module-resolution hook that swaps in a fake joinSession (and, per
// case, a broken config store or a throwing governor). Nothing in the repository is changed and no real session is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_URL = pathToFileURL(resolve(HERE, '..', '..', 'extensions', 'shell-governor', 'main.mjs')).href;
const REAL_LOGS = resolve(HERE, '..', '..', 'extensions', 'shell-governor', 'logs');
const SHIPPED_CONFIG = resolve(HERE, '..', '..', 'extensions', 'shell-governor', 'config');
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
/** Temp state folder (logs/ and reviews/) of this suite; created in before(), removed in after(). */
let suiteState = '';
/** Temp config root of this suite (enabled: true); created in before(), removed in after(). */
let suiteConfig = '';

/** Temp config root: config/governor.json = the shipped file with `enabled` set, config/agents.json copied from the shipped file. */
function writeConfigRoot(enabled) {
    const root = mkdtempSync(join(tmpdir(), 'gov-main-config-'));
    mkdirSync(join(root, 'config'));
    const shipped = JSON.parse(readFileSync(join(SHIPPED_CONFIG, 'governor.json'), 'utf8').replace(/^\uFEFF/, ''));
    writeFileSync(join(root, 'config', 'governor.json'), JSON.stringify({ ...shipped, enabled }, null, 4));
    copyFileSync(join(SHIPPED_CONFIG, 'agents.json'), join(root, 'config', 'agents.json'));
    return root;
}

/** Child program: installs the resolve hook, imports main.mjs, then drives the registered hook and prints one JSON line. */
const CHILD = String.raw`
import { register } from 'node:module';
const MODE = process.env.MAIN_TEST_MODE;
const sdk = 'export async function joinSession(c){ globalThis.__hooks = c.hooks; globalThis.__listeners = []; return { sessionId: "0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e", on(f){ globalThis.__listeners.push(f); }, ui: { elicitation: async () => ({ action: "cancel" }) }, capabilities: { ui: { elicitation: false } }, rpc: { agent: { getCurrent: async () => ({ agent: null }) } } }; }';
const brokenConfig = 'export const realClock = { now: () => Date.now() }; export function createConfigStore(){ return { register(){}, get(){ throw new Error("config store broken"); }, agentPolicy(){ throw new Error("config store broken"); } }; }';
const syncGovernor = 'export function createGovernor(){ return { onPreToolUse(){ throw new Error("sync boom"); }, onEvent(){}, beginShutdown(){} }; }';
const rejectGovernor = 'export function createGovernor(){ return { onPreToolUse: async () => { throw new Error("async boom"); }, onEvent(){}, beginShutdown(){} }; }';
const data = (text) => 'data:text/javascript,' + encodeURIComponent(text);
const loader = 'const sdk = ' + JSON.stringify(data(sdk)) + ', broken = ' + JSON.stringify(data(brokenConfig)) + ', syncG = ' + JSON.stringify(data(syncGovernor)) + ', rejectG = ' + JSON.stringify(data(rejectGovernor)) + ', mode = ' + JSON.stringify(MODE) + ';'
  + 'export async function resolve(s, c, n){'
  + ' if (s === "@github/copilot-sdk/extension") return { url: sdk, shortCircuit: true };'
  + ' const fromMain = (c.parentURL ?? "").endsWith("/shell-governor/main.mjs");'
  + ' if (fromMain && s === "./lib/config.mjs" && mode === "config-broken") return { url: broken, shortCircuit: true };'
  + ' if (fromMain && s === "./lib/governor.mjs" && mode === "sync-throw") return { url: syncG, shortCircuit: true };'
  + ' if (fromMain && s === "./lib/governor.mjs" && mode === "reject") return { url: rejectG, shortCircuit: true };'
  + ' return n(s, c); }';
register(data(loader));
await import(process.env.MAIN_URL);
const hooks = globalThis.__hooks;
const out = { hookKeys: Object.keys(hooks ?? {}) };
if (MODE === 'shutdown') for (const f of globalThis.__listeners) f({ type: 'session.shutdown', data: {} });
const call = (toolName, toolArgs) => hooks.onPreToolUse({ toolName, toolArgs, workingDirectory: process.cwd() });
out.powershell = await call('powershell', { command: 'Get-Date' });
out.view = await call('view', {});
process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
process.exit(0);
`;

/** Runs the child in the given mode and returns the parsed result. Runtime files go to the suite's temp state folder. */
function runChild(mode, extraEnv = {}) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: CHILD,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, MAIN_TEST_MODE: mode, MAIN_URL, SHELL_GOVERNOR_STATE_DIR: suiteState, SHELL_GOVERNOR_CONFIG_ROOT: suiteConfig, ...extraEnv },
    });
    const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `child printed no result (exit ${run.status}): ${run.stderr}`);
    return JSON.parse(line.slice('RESULT '.length));
}

describe('main.mjs wiring', () => {
    before(() => {
        suiteState = mkdtempSync(join(tmpdir(), 'gov-main-suite-'));
        suiteConfig = writeConfigRoot(true);
    });
    after(() => {
        rmSync(suiteState, { recursive: true, force: true });
        rmSync(suiteConfig, { recursive: true, force: true });
    });

    it('Main_ConfigUnreadableAtLoad_HookStillRegisteredAndAsks', () => {
        // Arrange / Act (F4)
        const out = runChild('config-broken');
        // Assert: view is a governed read tool now, so with no config it asks (fail-closed)
        assert.deepEqual(out.hookKeys, ['onPreToolUse']);
        assert.equal(out.powershell.permissionDecision, 'ask');
        assert.equal(out.view.permissionDecision, 'ask');
    });

    it('Main_GovernorThrowsSynchronously_HookAsks', () => {
        // Arrange / Act (F7)
        const out = runChild('sync-throw');
        // Assert
        assert.equal(out.powershell.permissionDecision, 'ask');
        assert.match(out.powershell.permissionDecisionReason, /internal error/);
    });

    it('Main_GovernorRejects_HookAsks', () => {
        // Arrange / Act (F7)
        const out = runChild('reject');
        // Assert
        assert.equal(out.powershell.permissionDecision, 'ask');
        assert.match(out.powershell.permissionDecisionReason, /internal error/);
    });

    it('Main_AfterSessionShutdown_HookAsksWithoutStartingWorker', () => {
        // Arrange / Act (F9)
        const out = runChild('shutdown');
        // Assert: view is a governed read tool now, so after shutdown it asks too
        assert.equal(out.powershell.permissionDecision, 'ask');
        assert.match(out.powershell.permissionDecisionReason, /shutting down/);
        assert.equal(out.view.permissionDecision, 'ask');
        assert.match(out.view.permissionDecisionReason, /shutting down/);
    });

    it('Main_ErrorsInGovernorLog_NameCodeReasonAndSizeOnly', () => {
        // Arrange: the fake governor throws an Error whose message stands in for script text
        const stateDir = mkdtempSync(join(tmpdir(), 'gov-main-log-'));
        try {
            // Act
            runChild('sync-throw', { SHELL_GOVERNOR_STATE_DIR: stateDir });
            // Assert
            const text = readFileSync(join(stateDir, 'logs', 'governor.log'), 'utf8');
            assert.ok(!text.includes('sync boom'), `error message leaked into governor.log: ${text}`);
            assert.match(text, /error:hook name=Error messageBytes=9/);
        } finally {
            rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('Main_GovernorLogOverOneMegabyte_RotatedToDotOneKeepingOneOlderFile', () => {
        // Arrange: an oversized log and an older rotated file
        const stateDir = mkdtempSync(join(tmpdir(), 'gov-main-rotate-'));
        const logs = join(stateDir, 'logs');
        mkdirSync(logs, { recursive: true });
        writeFileSync(join(logs, 'governor.log'), 'x'.repeat(1024 * 1024 + 10));
        writeFileSync(join(logs, 'governor.log.1'), 'OLDEST');
        try {
            // Act: the config-broken run writes a config-error line
            runChild('config-broken', { SHELL_GOVERNOR_STATE_DIR: stateDir });
            // Assert
            assert.equal(statSync(join(logs, 'governor.log.1')).size, 1024 * 1024 + 10, 'the big file became governor.log.1');
            assert.ok(statSync(join(logs, 'governor.log')).size < 4096, 'a fresh governor.log was started');
            assert.deepEqual(readdirSync(logs).filter((n) => n.startsWith('governor.log')).sort(), ['governor.log', 'governor.log.1']);
        } finally {
            rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('Main_StateDirOverride_RuntimeFilesGoToTheOverrideFolderOnly', () => {
        // the suite's sandbox config (enabled: true) keeps this test independent of the shipped "enabled" value, which the user switches by hand
        // Arrange: a throw-away state folder; the real logs/ folder must not change
        const stateDir = mkdtempSync(join(tmpdir(), 'gov-main-state-'));
        const realBefore = listing(REAL_LOGS);
        try {
            // Act: a normal run makes a governed decision (audit line) and writes the governor log
            runChild('normal', { SHELL_GOVERNOR_STATE_DIR: stateDir });
            // Assert
            assert.ok(listing(join(stateDir, 'logs')).some((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)),
                `no audit file under the override: ${listing(stateDir).join(', ') || 'empty'}`);
            assert.deepEqual(listing(REAL_LOGS), realBefore, 'no new file appeared under extensions/shell-governor/logs/');
        } finally {
            rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('Main_ConfigRootOverride_DisabledSandbox_NoDecision', () => {
        // Arrange: a config root whose governor.json says enabled: false, and a throw-away state folder
        const configRoot = writeConfigRoot(false);
        const stateDir = mkdtempSync(join(tmpdir(), 'gov-main-off-'));
        try {
            // Act
            const out = runChild('normal', { SHELL_GOVERNOR_CONFIG_ROOT: configRoot, SHELL_GOVERNOR_STATE_DIR: stateDir });
            // Assert: no decision for either tool and no audit line, whatever the shipped "enabled" value is
            assert.equal(out.powershell, undefined);
            assert.equal(out.view, undefined);
            assert.deepEqual(listing(join(stateDir, 'logs')).filter((n) => /^audit-.*\.jsonl$/.test(n)), []);
        } finally {
            rmSync(configRoot, { recursive: true, force: true });
            rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('Main_NoConfigRootOverride_FollowsShippedEnabledValue', () => {
        // Arrange: no config root override (the production default); a throw-away state folder
        const stateDir = mkdtempSync(join(tmpdir(), 'gov-main-shipped-'));
        const realBefore = listing(REAL_LOGS);
        const shippedEnabled = JSON.parse(readFileSync(join(SHIPPED_CONFIG, 'governor.json'), 'utf8').replace(/^\uFEFF/, '')).enabled !== false;
        try {
            // Act
            const out = runChild('normal', { SHELL_GOVERNOR_CONFIG_ROOT: '', SHELL_GOVERNOR_STATE_DIR: stateDir });
            // Assert: the shipped file decides; the real logs/ folder must not change
            if (shippedEnabled) assert.equal(out.view.permissionDecision, 'ask');
            else assert.equal(out.view, undefined);
            assert.deepEqual(listing(REAL_LOGS), realBefore, 'no new file appeared under extensions/shell-governor/logs/');
        } finally {
            rmSync(stateDir, { recursive: true, force: true });
        }
    });
});
