// Replay tool checks (AC-17). Synthetic fixtures only: the tool is never pointed at the user's real session-state here.
// Every run writes to a throw-away output folder; the real .local/replay folder is only checked for git-ignore status.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { PwshClientError } from '../../extensions/shell-governor/lib/pwsh-client.mjs';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import { createEngine } from '../../extensions/shell-governor/lib/engine.mjs';
import { registerDirectoryPolicy } from '../../extensions/shell-governor/lib/paths.mjs';
import { evaluateReadTool } from '../../extensions/shell-governor/lib/read-tools.mjs';
import { createSessionContext } from '../../extensions/shell-governor/lib/session-context.mjs';
import {
    DEFAULT_OUT_DIR, PARITY_TOLERANCE_POINTS, S6_REFERENCE_SHARES,
    assertClean, checkSignaturePrivacy, configuredExcludeCwds, formatSummary, isExcludedCwd, main, maskForReview, maskText, parityOf, runReplay, sanitizeSignature,
} from '../../extensions/shell-governor/tools/replay.mjs';
import * as replayModule from '../../extensions/shell-governor/tools/replay.mjs';
import { RATINGS } from '../../extensions/shell-governor/lib/contracts.mjs';
import { createConfigSandbox } from './helpers/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolve(HERE, '..', '..', 'extensions', 'shell-governor');
const FIXTURE_HOME = resolve(HERE, 'fixtures', 'replay', 'copilot-home');
const SYNTH_HOME = 'C:\\synthetic-home';
const SYNTH_TEMP = 'C:\\synthetic-temp';
const ENV = Object.freeze({ USERPROFILE: SYNTH_HOME, TEMP: SYNTH_TEMP });
const WORK_CWD = 'C:\\replay-fixture\\app';
const AZ_TOKEN = 'az account get-access-token --query accessToken -o tsv';

const trash = [];
after(() => {
    for (const p of trash) rmSync(p, { recursive: true, force: true });
});

/** Fresh output folder for one run (never the real .local folder). */
function makeOut() {
    const dir = mkdtempSync(join(tmpdir(), 'replay-out-'));
    trash.push(dir);
    return dir;
}

/** Synthetic copilot home: session-state/<id>/{workspace.yaml?, events.jsonl}. */
function makeCopilotHome(sessions) {
    const root = mkdtempSync(join(tmpdir(), 'replay-home-'));
    trash.push(root);
    for (const s of sessions) {
        const dir = join(root, 'session-state', s.id);
        mkdirSync(dir, { recursive: true });
        if (s.workspaceCwd) writeFileSync(join(dir, 'workspace.yaml'), `cwd: ${s.workspaceCwd}\n`);
        writeFileSync(join(dir, 'events.jsonl'), `${s.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
    return root;
}

const start = (cwd) => ({ type: 'session.start', timestamp: '2026-10-18T10:00:00.000Z', data: { context: { cwd } } });
const call = (id, command, agentId) => ({
    type: 'tool.execution_start', timestamp: '2026-10-18T10:00:01.000Z', ...(agentId ? { agentId } : {}),
    data: { toolCallId: id, toolName: 'powershell', arguments: { command } },
});
const read = (id, tool, args, agentId) => ({
    type: 'tool.execution_start', timestamp: '2026-10-18T10:00:02.000Z', ...(agentId ? { agentId } : {}),
    data: { toolCallId: id, toolName: tool, arguments: args },
});

/** Worker stand-in that fails every request the way a dead pwsh worker does. */
function deadWorker() {
    return {
        calls: 0,
        async argv() {
            this.calls++;
            throw new PwshClientError('WORKER_UNAVAILABLE', 'pwsh worker exited (code 1)', 'exited');
        },
    };
}

/** Relative file list of a tree, for "input is untouched" checks. */
function listTree(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else out.push(relative(root, p));
        }
    };
    walk(root);
    return out.sort();
}

describe('replay tool (AC-17)', () => {
    it('Replay_Fixture_CountsVerdictsAndRules', async () => {
        // Arrange: synthetic fixture home; real engine and real pwsh worker
        // Act
        const { results } = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut() });
        // Assert: sessions a and d replayed (6 PowerShell calls); spike and live-scratch sessions excluded
        assert.equal(results.corpus.includedSessions, 2);
        assert.equal(results.corpus.excludedSessions, 2);
        assert.equal(results.corpus.powershellCalls, 6);
        assert.equal(results.verdicts.SAFE.calls, 1, 'Get-Content README.md is a SAFE read');
        assert.equal(results.verdicts.ASK.calls, 4);
        assert.equal(results.verdicts.SYNTAX.calls, 1, 'unterminated quote is a SYNTAX deny');
        assert.equal(results.verdicts.AI.calls, 0);
        assert.equal(results.byRule.SYNTAX.calls, 1);
        assert.equal(results.byRule.CREDENTIAL.calls, 3, 'token retrieval, twice in session a and once in session d');
        assert.equal(results.byRule['DYNAMIC-CODE'].calls, 1);
        assert.equal(results.byAgent['sub-worker-main'].calls, 1, 'subagent call joined via subagent.started');
        assert.equal(results.byAgent.main.calls, 5);
        assert.equal(results.workerErrors.total, 0);
    });

    it('Replay_Output_GoesToIgnoredLocalFolder', async () => {
        // Arrange
        const out = makeOut();
        const inputBefore = listTree(FIXTURE_HOME);
        // Act
        const { files } = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: out, worker: deadWorker() });
        // Assert
        assert.equal(DEFAULT_OUT_DIR, join(EXTENSION_DIR, '.local', 'replay'));
        assert.equal(files.results, join(out, 'results.json'));
        assert.equal(files.askReview, join(out, 'ask-review.md'));
        for (const f of ['results.json', 'ask-review.md']) {
            const ignored = spawnSync('git', ['check-ignore', '-q', join(DEFAULT_OUT_DIR, f)], { cwd: EXTENSION_DIR });
            assert.equal(ignored.status, 0, `${f} must be git-ignored under .local/`);
            assert.ok(existsSync(join(out, f)), `${f} written to the output folder`);
        }
        assert.deepEqual(listTree(FIXTURE_HOME), inputBefore, 'session-state is read-only');
    });

    it('Replay_Review_MasksSecrets', async () => {
        // Arrange: one ASK call (token printed) whose comment carries token-like values
        const script = `$t = ${AZ_TOKEN}; Write-Host $t # ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abcdefghijklmnop12345678`;
        const home = makeCopilotHome([{ id: 'secret-session', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('s-1', script)] }]);
        // Act
        const { results, files } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut() });
        const review = readFileSync(files.askReview, 'utf8');
        // Assert
        assert.equal(results.byRule.CREDENTIAL.calls, 1);
        assert.ok(review.includes('CREDENTIAL'), 'the ASK group is in the review');
        assert.ok(review.includes('***'), 'masked values are marked');
        assert.ok(!review.includes('ghp_abcdefghijklmnop'), 'no GitHub token in the review');
        assert.ok(!review.includes('abcdefghijklmnop12345678'), 'no bearer value in the review');
        assert.ok(!maskForReview('x -password hunter22').includes('hunter22'), 'password flag value masked');
        assert.ok(!maskText('Bearer abcdefghijklmnop12345678').includes('abcdefghijklmnop'), 'bearer masked');
    });

    it('Replay_Sessions_ExcludeConfiguredCwds', async () => {
        // Arrange: fixture home with spike (b), live-scratch (c) and sibling-folder (d) sessions; counts only
        // Act
        const byDefault = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker() });
        const configured = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker(), excludeCwds: [WORK_CWD] });
        // Assert: defaults exclude the spike repo and {temp}\shell-governor-live (not its sibling folder)
        assert.equal(byDefault.results.corpus.excludedSessions, 2);
        assert.equal(byDefault.results.corpus.includedSessions, 2);
        assert.equal(byDefault.results.corpus.powershellCalls, 6);
        // Assert: a configured list replaces the defaults
        assert.equal(configured.results.corpus.excludedSessions, 1);
        assert.equal(configured.results.corpus.includedSessions, 3);
        assert.equal(configured.results.corpus.powershellCalls, 3);
        // Assert: "under" means the folder itself or a child, case-insensitively
        assert.equal(isExcludedCwd('C:\\code\\governance-spike\\bench', ['C:\\code\\governance-spike']), true);
        assert.equal(isExcludedCwd('C:\\CODE\\Governance-Spike', ['C:\\code\\governance-spike']), true);
        assert.equal(isExcludedCwd('C:\\code\\governance-spike-old', ['C:\\code\\governance-spike']), false);
        assert.equal(isExcludedCwd(null, ['C:\\code\\governance-spike']), false);
    });

    it('Replay_SourceHasNoLiteralExcludedFolder', () => {
        // Arrange / Act: the excluded folders are configuration (config/governor.json, replay.excludeCwds), not code
        const source = readFileSync(join(EXTENSION_DIR, 'tools', 'replay.mjs'), 'utf8');
        // Assert
        assert.ok(!source.includes('governance-spike'), 'tools/replay.mjs contains a literal excluded folder');
        assert.ok(!/[A-Za-z]:\\\\code\\\\/.test(source), 'tools/replay.mjs contains a literal machine path');
    });

    it('Replay_ExcludeCwds_ShippedDefaultsAreInGovernorConfig', () => {
        // Arrange / Act: the store reads the real config/governor.json, as runReplay does
        const store = createConfigStore({ rootDir: EXTENSION_DIR, copilotHome: FIXTURE_HOME, env: ENV });
        // Assert
        assert.deepEqual(configuredExcludeCwds(store), ['C:\\code\\governance-spike', '{temp}\\shell-governor-live']);
    });

    it('Replay_ExcludeCwds_ReadFromFixtureConfig', (t) => {
        // Arrange: a fixture config (sandbox copy of the extension config folder) with its own replay section
        const sb = createConfigSandbox('replay-config-');
        t.after(() => sb.remove());
        const storeWith = (text) => {
            sb.write(sb.configFile('governor.json'), text);
            return createConfigStore({ rootDir: sb.root, copilotHome: sb.copilotHome, env: ENV });
        };
        // Act / Assert
        assert.deepEqual(
            configuredExcludeCwds(storeWith(JSON.stringify({ enabled: true, replay: { excludeCwds: ['D:\\fixture-spike', '{temp}\\fixture-live'] } }))),
            ['D:\\fixture-spike', '{temp}\\fixture-live'],
        );
        assert.deepEqual(configuredExcludeCwds(storeWith(JSON.stringify({ enabled: true }))), [], 'a missing key excludes nothing');
        assert.throws(() => configuredExcludeCwds(storeWith(JSON.stringify({ replay: { excludeCwds: 'D:\\x' } }))), /array of strings/);
        assert.throws(() => configuredExcludeCwds(storeWith('{ not json')), /could not be read/);
    });

    it('Replay_ExtraExcludeCwds_AddToConfiguredList', async () => {
        // Act: the --exclude-cwd option adds to the governor.json list (the two configured folders plus WORK_CWD)
        const { results } = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker(), extraExcludeCwds: [WORK_CWD] });
        // Assert
        assert.equal(results.corpus.excludedSessions, 3);
        assert.equal(results.corpus.includedSessions, 1);
    });

    it('Replay_Parity_ReportsDeviationPerShare', () => {
        // Arrange
        const onBoundary = { SAFE: 74.8, AI: 19.1, ASK: 5.4, SYNTAX: 0.7 };
        const outside = { SAFE: 74.81, AI: 20.1, ASK: 5.4, SYNTAX: 0.7 };
        // Act
        const a = parityOf(onBoundary);
        const b = parityOf(outside);
        // Assert
        assert.deepEqual(S6_REFERENCE_SHARES, { SAFE: 73.8, AI: 20.1, ASK: 5.4, SYNTAX: 0.7 });
        assert.equal(PARITY_TOLERANCE_POINTS, 1.0);
        assert.equal(a.pass, true);
        assert.equal(a.shares.SAFE.delta, 1);
        assert.equal(a.shares.AI.pass, true, 'exactly one point below the reference passes');
        assert.equal(b.pass, false);
        assert.equal(b.shares.SAFE.pass, false);
        assert.equal(b.shares.SAFE.delta, 1.01);
        assert.equal(b.shares.AI.pass, true);
    });

    it('Replay_Window_SinceUntilFilterSessionsByStartTime', async () => {
        // Arrange: fixture sessions start at 10:00Z (a), 11:00Z (b), 12:00Z (c), 13:00Z (d)
        const run = (window) => runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker(), ...window });
        // Act
        const all = await run({});
        const until = await run({ until: '2026-10-18T12:30:00Z' });
        const since = await run({ since: '2026-10-18T13:00:00Z' });
        const both = await run({ since: '2026-10-18T11:30:00+00:00', until: '2026-10-18T15:30:00+02:00' });
        const none = await run({ until: '2026-10-18T10:00:00Z' });
        // Assert: since is inclusive, until exclusive; the cwd exclusion still applies inside the window
        assert.equal(all.results.corpus.outOfRangeSessions, 0);
        assert.equal(until.results.corpus.includedSessions, 1, 'only a is included (b and c are excluded folders)');
        assert.equal(until.results.corpus.excludedSessions, 2);
        assert.equal(until.results.corpus.outOfRangeSessions, 1, 'd starts after the window');
        assert.equal(since.results.corpus.includedSessions, 1, 'a session starting exactly at since is inside');
        assert.equal(since.results.corpus.outOfRangeSessions, 3);
        assert.equal(both.results.corpus.outOfRangeSessions, 2, 'a and b start before since; c (12:00Z) and d (13:00Z) are before until (13:30Z)');
        assert.equal(none.results.corpus.includedSessions, 0, 'until is exclusive');
        assert.equal(none.results.corpus.powershellCalls, 0);
        assert.equal(until.results.corpus.window.until, '2026-10-18T12:30:00.000Z');
        assert.equal(until.results.corpus.window.since, null);
    });

    it('Replay_Window_SessionWithoutStartTimeIsOutsideAnyWindow', async () => {
        // Arrange: no session.start event, so no start time
        const home = makeCopilotHome([{ id: 'undated', workspaceCwd: WORK_CWD, events: [call('x-1', 'git status')] }]);
        // Act
        const open = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        const windowed = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), since: '2000-01-01T00:00:00Z' });
        // Assert
        assert.equal(open.results.corpus.includedSessions, 1);
        assert.equal(windowed.results.corpus.includedSessions, 0);
        assert.equal(windowed.results.corpus.outOfRangeSessions, 1);
    });

    it('Replay_Window_InvalidDateIsAnError', async () => {
        // Arrange / Act / Assert
        await assert.rejects(runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker(), until: 'yesterday-ish' }), /until/);
        const logs = [];
        const code = await main(['--since', 'not-a-date'], { log: (s) => logs.push(s), error: (s) => logs.push(s) });
        assert.equal(code, 2);
        assert.match(logs.join('\n'), /--since/);
    });

    it('Replay_Cli_UntilSinceAndOutArguments', async () => {
        // Arrange
        const out = makeOut();
        const logs = [];
        // Act
        const code = await main(['--summary', '--copilot-home', FIXTURE_HOME, '--until', '2026-10-18T12:30:00Z', '--since', '2026-10-18T09:00:00Z', '--out', out],
            { log: (s) => logs.push(s), error: (s) => logs.push(s) });
        // Assert
        assert.equal(code, 0, logs.join('\n'));
        assert.match(logs[0], /^replay: 2 sessions \(1 excluded\)/, 'a and c replayed, b (spike) excluded, d outside the window');
        assert.match(logs[0], /\(1 sessions outside\)/);
        assert.ok(existsSync(join(out, 'results.json')));
    });

    it('Replay_OnCall_ObservesEveryCallWithVerdictAndRule', async () => {
        // Arrange
        const seen = [];
        // Act
        const { results } = await runReplay({ copilotHome: FIXTURE_HOME, env: ENV, outDir: makeOut(), worker: deadWorker(), onCall: (out, call) => seen.push({ rule: out.rule, agent: call.agent }) });
        // Assert
        assert.equal(seen.length, results.corpus.powershellCalls);
        assert.ok(seen.every((s) => s.rule === 'WORKER-ERROR'));
    });

    it('Replay_Scan_FailsOnUnmaskedSecret', () => {
        // Arrange
        const leaky = { 'ask-review.md': 'call: ghp_abcdefghijklmnopqrstuvwxyz0123' };
        const clean = { 'ask-review.md': maskForReview('call: ghp_abcdefghijklmnopqrstuvwxyz0123') };
        // Act / Assert
        assert.throws(() => assertClean(leaky), (err) => err.message.includes('ask-review.md')
            && !err.message.includes('ghp_abcdef'), 'the error names the file and pattern, never the value');
        assert.doesNotThrow(() => assertClean(clean));
    });

    it('Replay_Signature_RejectsLiteralAndPackedFlag', () => {
        // Arrange / Act / Assert
        assert.deepEqual(checkSignaturePrivacy('git/status[read]{repo} > Get-Content[read]{C}'), []);
        assert.ok(checkSignaturePrivacy('gh/api.repos/alice@corp[read]{url}').includes('literal'), 'literal value in a subcommand slot');
        assert.ok(checkSignaturePrivacy('mysql/-psecret123[read]{}').includes('flag'), 'packed flag value became a parameter name');
    });

    it('Replay_Summary_PrintsSharesAndParityOnly', async () => {
        // Arrange
        const home = makeCopilotHome([{ id: 'summary', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('u-1', 'git status')] }]);
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        // Act
        const text = formatSummary(results);
        // Assert: shares, parity PASS/FAIL, worker error count; no command text
        assert.match(text, /ASK\s+100\.00 %/);
        assert.match(text, /SAFE\s+0\.00 %/);
        assert.match(text, /parity.*FAIL/);
        assert.match(text, /worker errors: 1/);
        assert.ok(!text.includes('git status'));
    });

    it('Replay_WorkerError_CountedAndMappedToAsk', async () => {
        // Arrange
        const home = makeCopilotHome([{ id: 'dead', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('d-1', 'git status'), call('d-2', 'Get-Content README.md')] }]);
        const worker = deadWorker();
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker });
        // Assert
        assert.equal(worker.calls, 2);
        assert.equal(results.workerErrors.total, 2);
        assert.equal(results.workerErrors.WORKER_UNAVAILABLE, 2);
        assert.equal(results.verdicts.ASK.calls, 2, 'a worker error is an ASK for the governor');
        assert.equal(results.byRule['WORKER-ERROR'].calls, 2);
    });

    it('Replay_Signature_RealWorkerShapesPass', async () => {
        // Arrange: one of each shape family (inline, cmdlet, dynamic, executable by path, native tools, token retrieval)
        const scripts = [
            'git status',
            'dotnet build --nologo -v q',
            'Get-Content README.md',
            '& $v x',
            "& 'C:\\synthetic-tools\\tool.exe' a",
            AZ_TOKEN,
            'gh api repos/a/b/pulls',
            "Remove-Item -Recurse 'C:\\Windows\\Temp\\x'",
        ];
        const home = makeCopilotHome([{ id: 'shapes', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), ...scripts.map((s, i) => call(`s-${i}`, s))] }]);
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut() });
        // Assert: every signature passes the privacy check (a violation would fail the run)
        assert.equal(results.corpus.powershellCalls, scripts.length);
        assert.equal(results.privacy.signatureViolations, 0);
        assert.ok(results.privacy.signaturesChecked >= 1);
    });

    it('Replay_Signature_RedactsLiteralCmdTarget', async () => {
        // Arrange: cmd /c whose first token is a path; the engine now labels the inner text <inner>, so no path reaches the replay
        const folder = 'secret-folder';
        const home = makeCopilotHome([{
            id: 'cmd-path', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('p-1', `cmd /c C:\\replay-fixture\\${folder}\\tool.bat a`)],
        }]);
        // Act
        const { results, files } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut() });
        // Assert: the literal path never reaches the outputs; the engine emits no redactable token for it (defence in depth below)
        assert.equal(sanitizeSignature('cmd:c:\\x\\tool.bat[unknown]{}').signature, 'cmd:<redacted>[unknown]{}');
        assert.deepEqual(sanitizeSignature('git/git.read[read]{READ-ANYWHERE}'), { signature: 'git/git.read[read]{READ-ANYWHERE}', redacted: 0 });
        // the engine's inner-text placeholder is a shape word, not a redaction
        assert.deepEqual(sanitizeSignature('cmd:<inner>[read]{}'), { signature: 'cmd:<inner>[read]{}', redacted: 0 });
        assert.deepEqual(sanitizeSignature('pwsh/pwsh.inline[read]{READ-ANYWHERE} > <inner>[execute-code:exe]{DIR-OUTSIDE}'),
            { signature: 'pwsh/pwsh.inline[read]{READ-ANYWHERE} > <inner>[execute-code:exe]{DIR-OUTSIDE}', redacted: 0 });
        assert.equal(results.privacy.signatureRedactions, 0);
        assert.equal(results.privacy.signatureViolations, 0);
        assert.ok(!readFileSync(files.results, 'utf8').includes(folder));
        assert.ok(!readFileSync(files.askReview, 'utf8').includes(folder));
    });

    it('Replay_Signature_SanitizedAlwaysPassesPrivacyCheck', () => {
        // Arrange: awkward raw signatures (paths, spaces, flags, brackets, empty slots)
        const raw = [
            'cmd:c:\\x\\tool.bat[unknown]{}', 'a/b/c[x]{y}', 'tool[exe:x y]{}', 'x[ ]{ }', '-flag/-x.y[read]{-p}',
            'name[read]{a b, /x, C}', 'bad segment', 'git/git.read[read]{READ-ANYWHERE} > cmd:-x[unknown]{}',
            'gh/api.repos/alice@corp[read]{url}', 'mysql/-psecret123[read]{}', '<dynamic>[dynamic]{}', 'cmd:<inner>[unknown]{}', '<inner>[write]{DIR-OUTSIDE}',
        ];
        for (const s of raw) {
            // Act
            const clean = sanitizeSignature(s).signature;
            // Assert
            assert.deepEqual(checkSignaturePrivacy(clean), [], `${JSON.stringify(clean)} must pass the privacy check`);
        }
        assert.deepEqual(sanitizeSignature(''), { signature: '', redacted: 0 });
    });
});

describe('replay read tools, session selection and arguments (AC-7)', () => {
    it('Replay_ReadTools_CountedPerToolVerdictAndRule', async () => {
        // Arrange: a secret view, a plain view, a view without a path, a grep with paths and a glob without paths
        const home = makeCopilotHome([{
            id: 'reads', workspaceCwd: WORK_CWD,
            events: [
                start(WORK_CWD),
                read('r-1', 'view', { path: `${SYNTH_HOME}\\.ssh\\id_rsa` }),
                read('r-2', 'view', { path: 'README.md' }),
                read('r-3', 'view', {}),
                read('r-4', 'grep', { pattern: 'TODO', paths: [WORK_CWD] }),
                read('r-5', 'glob', { pattern: '*.md' }),
            ],
        }]);
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        // Assert
        assert.equal(results.corpus.readToolCalls, 5);
        assert.equal(results.readTools.byTool.view.calls, 3);
        assert.equal(results.readTools.byTool.view.verdicts.SAFE.calls, 1);
        assert.equal(results.readTools.byTool.view.verdicts.ASK.calls, 2);
        assert.equal(results.readTools.byTool.view.byRule['DIR-SECRET'], 1);
        assert.equal(results.readTools.byTool.view.byRule['READ-ARGS-UNRECOGNISED'], 1);
        assert.equal(results.readTools.byTool.grep.verdicts.SAFE.calls, 1);
        assert.equal(results.readTools.byTool.glob.verdicts.SAFE.calls, 1);
        assert.equal(results.corpus.powershellCalls, 0, 'read tools are not PowerShell calls');
    });

    it('Replay_ReadTools_SecretRootSearchesCounted', async () => {
        // Arrange: grep and glob whose search root is the synthetic home, which reaches the ssh secret rule base
        const home = makeCopilotHome([{
            id: 'secret-roots', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), read('s-1', 'grep', { pattern: 'token', paths: [SYNTH_HOME] }), read('s-2', 'glob', { pattern: '*', path: SYNTH_HOME })],
        }]);
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        // Assert
        assert.equal(results.readTools.secretRootSearches.calls, 2);
        assert.equal(results.readTools.secretRootSearches.byRule['secret-ssh'], 2);
        assert.equal(results.readTools.byTool.grep.verdicts.ASK.calls, 1);
        assert.equal(results.readTools.byTool.grep.byRule['READ-SECRET-ROOT-SEARCH'], 1);
        assert.equal(results.readTools.byTool.glob.verdicts.SAFE.calls, 1);
    });

    it('Replay_OnReadCall_DecisionMatchesSharedEvaluator', async () => {
        // Arrange: one secret view and one grep of the home; the expected decisions come from the shared evaluator with the same inputs
        const events = [
            start(WORK_CWD),
            read('e-1', 'view', { path: `${SYNTH_HOME}\\.ssh\\id_rsa` }),
            read('e-2', 'grep', { pattern: 'x', paths: [SYNTH_HOME] }),
        ];
        const home = makeCopilotHome([{ id: 'shared', workspaceCwd: WORK_CWD, events }]);
        const seen = [];
        // Act
        await runReplay({
            copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(),
            onReadCall: (decision, call) => seen.push({ decision, call }),
        });
        // Assert
        const store = createConfigStore({ rootDir: EXTENSION_DIR, copilotHome: home, env: { ...ENV, USERPROFILE: SYNTH_HOME } });
        registerDirectoryPolicy(store);
        const ctx = createSessionContext({ cwd: WORK_CWD });
        for (const event of events) ctx.observe(event);
        const caller = await ctx.callerOf(null);
        const engine = createEngine({
            config: store, session: { scriptStatus: (p) => ctx.scriptStatus(p) }, sessionId: 'shared',
            home: SYNTH_HOME, copilotHome: home, temp: SYNTH_TEMP,
        });
        const policy = engine.directoryPolicyFor({ agent: caller.name, cwd: WORK_CWD });
        assert.equal(seen.length, 2, 'every read call is observed');
        assert.equal(seen[0].call.tool, 'view');
        assert.equal(seen[1].call.tool, 'grep');
        assert.deepEqual(seen[0].decision, evaluateReadTool({ tool: 'view', args: events[1].data.arguments, cwd: WORK_CWD, policy, home: SYNTH_HOME }));
        assert.deepEqual(seen[1].decision, evaluateReadTool({ tool: 'grep', args: events[2].data.arguments, cwd: WORK_CWD, policy, home: SYNTH_HOME }));
    });

    it('Replay_SessionPrefix_SelectsOnlyMatchingSessions', async () => {
        // Arrange
        const home = makeCopilotHome([
            { id: 'abc123-x', workspaceCwd: WORK_CWD, events: [start(WORK_CWD)] },
            { id: 'def456-y', workspaceCwd: WORK_CWD, events: [start(WORK_CWD)] },
        ]);
        // Act: the prefix is matched case-insensitively
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), sessions: ['ABC'] });
        // Assert
        assert.equal(results.corpus.includedSessions, 1);
        assert.equal(results.corpus.unselectedSessions, 1);
        assert.deepEqual(results.corpus.sessionPrefixes, ['ABC']);
    });

    it('Replay_ParseArgs_SessionFlagRepeatable', () => {
        // Act / Assert
        assert.deepEqual(replayModule.parseArgs(['--session', 'a', '--session', 'b']).sessions, ['a', 'b']);
        assert.throws(() => replayModule.parseArgs(['--unknown-flag']), /unknown argument/);
    });

    it('Replay_Summary_PrintsReadToolLines', async () => {
        // Arrange: one plain view and one grep of the work folder (both SAFE)
        const home = makeCopilotHome([{
            id: 'summary-reads', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), read('m-1', 'view', { path: 'README.md' }), read('m-2', 'grep', { pattern: 'x', paths: [WORK_CWD] })],
        }]);
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        // Act
        const text = formatSummary(results);
        // Assert
        assert.match(text, /read tools: 2 calls \(view 1, grep 1, glob 0\)/);
        assert.match(text, /^ {2}view {2}SAFE 1 {2}ASK 0/m);
        assert.match(text, /^ {2}grep {2}SAFE 1 {2}ASK 0/m);
        assert.match(text, /^ {2}glob {2}SAFE 0 {2}ASK 0 {2}rules: none$/m);
        assert.match(text, /secret-root searches \(grep\/glob root reaches a secret rule base\): 0/);
    });

    it('Replay_ReadTools_NoPathTextInOutputs', async () => {
        // Arrange: a secret view and a search of the synthetic home, so the paths would show up if they leaked
        const home = makeCopilotHome([{
            id: 'no-paths', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), read('n-1', 'view', { path: `${SYNTH_HOME}\\.ssh\\id_rsa` }), read('n-2', 'grep', { pattern: 'x', paths: [SYNTH_HOME] })],
        }]);
        // Act
        const { results, files } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker() });
        // Assert: the read counts are in the results, so the path check below covers them
        assert.equal(results.readTools.calls, 2);
        for (const file of [files.results, files.askReview]) {
            assert.ok(!readFileSync(file, 'utf8').includes('synthetic-home'), `${file} must not contain a path`);
        }
    });

    // ---------- judge mode (AC-8) ----------

    const AI_FACTS = Object.freeze({ classes: ['unknown'], intents: ['read'], paths: [], notes: [], signature: 'x[unknown]{}' });
    const READ_FACTS = Object.freeze({ classes: ['read'], intents: ['read'], paths: [], notes: [] });
    // The shipped stage3 thresholds plus the two stage-2 relaxations (the shipped config does not carry the keys yet).
    const STAGE3_RELAXED = Object.freeze({
        hardRatings: ['destructive', 'irreversible', 'credential_access', 'exfiltration'],
        hardThreshold: 1,
        softThreshold: 2,
        minConfidence: 0.7,
        taskMismatchAloneAsksAt: 3,
        credentialAccessReadOnlyAllowed: true,
    });

    /** Engine stand-in with engine facts: AI for every script; read-only facts for scripts starting with `read `. */
    function factsEngine() {
        return {
            evaluate: async ({ script }) => ({
                verdict: 'AI', primaryRule: 'FAKE-AI', rules: [{ verdict: 'AI', rule: script.startsWith('read ') ? 'READ-REMOTE' : 'FAKE-AI' }], reason: 'fake',
                facts: script.startsWith('read ') ? READ_FACTS : AI_FACTS,
            }),
        };
    }

    /** Engine stand-in: AI for every script, except text starting with `safe ` (SAFE) or `ask ` (ASK). */
    function fakeEngine() {
        return {
            evaluate: async ({ script }) => {
                const verdict = script.startsWith('safe ') ? 'SAFE' : (script.startsWith('ask ') ? 'ASK' : 'AI');
                return { verdict, primaryRule: `FAKE-${verdict}`, rules: [{ verdict, rule: `FAKE-${verdict}` }], reason: 'fake', facts: AI_FACTS };
            },
        };
    }

    /** Judge outcome with ratings: every rating 0 unless overridden. */
    function ratingsOutcome(over = {}, confidence = 0.9) {
        const values = Object.fromEntries(RATINGS.map((k) => [k, 0]));
        return { outcome: 'ratings', ratings: { values: { ...values, ...over }, confidence, whatItDoes: 'fake', worstConsequence: 'none' }, latencyMs: 7, cached: false };
    }

    /** Judge stand-in: records every request and answers with the next queued outcome (clean ratings when the queue is empty). */
    function fakeJudge(outcomes = []) {
        const queue = [...outcomes];
        const judge = { calls: [], stops: 0 };
        judge.judge = (request) => {
            judge.calls.push(request);
            return Promise.resolve(queue.length ? queue.shift() : ratingsOutcome());
        };
        judge.stop = () => {
            judge.stops++;
            return Promise.resolve();
        };
        return judge;
    }

    const taskStart = (id, args) => ({ type: 'tool.execution_start', timestamp: '2026-10-18T10:00:01.000Z', data: { toolCallId: id, toolName: 'task', arguments: args } });
    const subagentStarted = (agentId, toolCallId, agentName) => ({
        type: 'subagent.started', timestamp: '2026-10-18T10:00:01.000Z', agentId, data: { toolCallId, agentName, agentType: agentName },
    });
    const callWithPurpose = (id, command, agentId, description) => ({
        type: 'tool.execution_start', timestamp: '2026-10-18T10:00:01.000Z', agentId, data: { toolCallId: id, toolName: 'powershell', arguments: { command, description } },
    });

    it('Replay_JudgeMode_OffByDefault_NoJudgeCalls', async () => {
        // Arrange
        const home = makeCopilotHome([{ id: 'judge-off', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('j-1', 'Get-Stuff')] }]);
        const judge = fakeJudge();
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge });
        // Assert
        assert.equal(results.judge, null);
        assert.equal(judge.calls.length, 0);
        assert.match(formatSummary(results), /^judge mode: off$/m);
    });

    it('Replay_JudgeMode_AiCallsRejudgedWithLiveInputs', async () => {
        // Arrange: a dispatched sub-agent (task, then subagent.started) whose powershell call carries a purpose
        const home = makeCopilotHome([{
            id: 'judge-live', workspaceCwd: WORK_CWD,
            events: [
                start(WORK_CWD),
                taskStart('task-1', { name: 'fix-build', description: 'Fix the build', prompt: 'Fix it' }),
                subagentStarted('agent-1', 'task-1', 'sub-worker-main'),
                callWithPurpose('j-2', 'Get-Stuff', 'agent-1', 'clean output'),
            ],
        }]);
        const judge = fakeJudge();
        // Act
        await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Assert
        assert.equal(judge.calls.length, 1);
        const [request] = judge.calls;
        assert.equal(request.script, 'Get-Stuff');
        assert.equal(request.taskName, 'fix-build');
        assert.equal(request.taskDescription, 'Fix the build');
        assert.equal(request.callPurpose, 'clean output');
        assert.equal(request.dispatchPrompt, 'Fix it');
        assert.equal(request.agentName, 'sub-worker-main');
    });

    it('Replay_JudgeMode_CountsAllowAskAndTriggers', async () => {
        // Arrange: three AI calls answered clean, destructive 1 and an unavailable judge
        const home = makeCopilotHome([{
            id: 'judge-count', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), call('c-1', 'Get-One'), call('c-2', 'Get-Two'), call('c-3', 'Get-Three')],
        }]);
        const judge = fakeJudge([ratingsOutcome(), ratingsOutcome({ destructive: 1 }), { outcome: 'ask' }]);
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Assert
        assert.equal(results.judge.calls, 3);
        assert.deepEqual(results.judge.decisions, { ALLOW: 1, ASK: 2 });
        assert.equal(results.judge.unavailable, 1);
        assert.deepEqual(results.judge.triggers, { destructive: 1 });
        assert.deepEqual(results.judge.singleTrigger, { destructive: 1 });
        assert.deepEqual(results.judge.relaxedAllows, {});
    });

    it('Replay_JudgeMode_NonAiVerdicts_NotJudged', async () => {
        // Arrange: a SAFE, an ASK and an AI call
        const home = makeCopilotHome([{
            id: 'judge-verdicts', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), call('v-1', 'safe Get-Item'), call('v-2', 'ask Remove-Thing'), call('v-3', 'Get-Stuff')],
        }]);
        const judge = fakeJudge();
        // Act
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Assert
        assert.equal(judge.calls.length, 1, 'only the AI-verdict call is judged');
        assert.equal(judge.calls[0].script, 'Get-Stuff');
        assert.equal(results.judge.calls, 1);
    });

    it('Replay_JudgeMode_InjectedJudgeNotStopped', async () => {
        // Arrange
        const home = makeCopilotHome([{ id: 'judge-injected', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('i-1', 'Get-Stuff')] }]);
        const judge = fakeJudge();
        // Act
        await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Assert: the caller owns an injected judge
        assert.equal(judge.stops, 0);
    });

    it('Replay_ParseArgs_JudgeFlag', () => {
        // Act / Assert
        assert.equal(replayModule.parseArgs(['--judge']).judgeMode, true);
        assert.equal(replayModule.parseArgs([]).judgeMode, false);
    });

    it('Replay_Summary_PrintsJudgeModeLines', async () => {
        // Arrange
        const home = makeCopilotHome([{ id: 'judge-summary', workspaceCwd: WORK_CWD, events: [start(WORK_CWD), call('s-1', 'Get-Stuff'), call('s-2', 'Get-Other')] }]);
        const judge = fakeJudge([ratingsOutcome(), ratingsOutcome({ destructive: 1 })]);
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: fakeEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Act
        const text = formatSummary(results);
        // Assert: counts and trigger names only
        assert.match(text, /^judge mode: 2 AI calls re-judged: ALLOW 1, ASK 1 \(judge unavailable 0, cached 0\)$/m);
        assert.match(text, /^ {2}ASK triggers: destructive 1$/m);
        assert.match(text, /^ {2}single-trigger ASKs: destructive 1$/m);
        assert.match(text, /^ {2}relaxed to ALLOW: none$/m);
        assert.ok(!text.includes('Get-Stuff'));
    });

    it('Replay_JudgeMode_RelaxationsUseEngineFacts', async () => {
        // Arrange: a read-only script with credential_access 1 (allowed), the same rating on a script without read-only
        // facts (asks), and task_mismatch 2 on a script without read-only facts (allowed by the relaxation)
        const home = makeCopilotHome([{
            id: 'judge-relaxed', workspaceCwd: WORK_CWD,
            events: [start(WORK_CWD), call('r-1', 'read Get-A'), call('r-2', 'Get-B'), call('r-3', 'Get-C')],
        }]);
        const judge = fakeJudge([ratingsOutcome({ credential_access: 1 }), ratingsOutcome({ credential_access: 1 }), ratingsOutcome({ task_mismatch: 2 })]);
        const { results } = await runReplay({ copilotHome: home, env: ENV, outDir: makeOut(), worker: deadWorker(), engine: factsEngine(), judge, judgeMode: true, stage3: STAGE3_RELAXED });
        // Assert
        assert.deepEqual(results.judge.decisions, { ALLOW: 2, ASK: 1 });
        assert.deepEqual(results.judge.relaxedAllows, { credential_access: 1, task_mismatch: 1 });
        assert.deepEqual(results.judge.singleTrigger, { credential_access: 1 });
        assert.match(formatSummary(results), /^ {2}relaxed to ALLOW: credential_access 1, task_mismatch 1$/m);
    });
});

