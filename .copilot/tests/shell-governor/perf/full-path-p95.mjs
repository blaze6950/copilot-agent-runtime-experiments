// Full-path latency check (AC-16): evaluates a typical one-line script through the engine with a warm real pwsh worker
// (worker round trip included) and exits non-zero when the p95 exceeds the budget. Not part of the unit suite (the worker
// round trip depends on machine load): run it on a quiet machine, for example in the final verification.
// Usage: node tests/shell-governor/perf/full-path-p95.mjs [iterations=100] [budgetMs=50]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigStore } from '../../../extensions/shell-governor/lib/config.mjs';
import { loadCatalog, registerCatalogGroups } from '../../../extensions/shell-governor/lib/catalog.mjs';
import { registerDirectoryPolicy } from '../../../extensions/shell-governor/lib/paths.mjs';
import { createEngine, flagTableOf } from '../../../extensions/shell-governor/lib/engine.mjs';
import { PwshClient } from '../../../extensions/shell-governor/lib/pwsh-client.mjs';
import { createFakeClock } from '../helpers/fake-clock.mjs';
import { createConfigSandbox } from '../helpers/fixtures.mjs';

const iterations = Number(process.argv[2] ?? 100);
const budgetMs = Number(process.argv[3] ?? 50);
const SESSION_ID = '0b7e2c1a-5d3f-4e8a-9c21-7f6a1b2c3d4e';
const SCRIPT = 'git status';

const sandbox = createConfigSandbox('shell-governor-perf-');
const home = join(sandbox.base, 'home');
const temp = join(sandbox.base, 'temp');
const code = join(sandbox.base, 'code');
const repo = join(code, 'repo');
for (const d of [home, temp, join(repo, '.git')]) mkdirSync(d, { recursive: true });
sandbox.write(sandbox.configFile('governor.json'), JSON.stringify({ enabled: true, codeRoots: [code] }));
const store = createConfigStore({
    rootDir: sandbox.root,
    copilotHome: sandbox.copilotHome,
    env: { USERPROFILE: home, TEMP: temp, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') },
    clock: createFakeClock(),
});
registerDirectoryPolicy(store);
registerCatalogGroups(store);
const client = new PwshClient({
    clock: createFakeClock(),
    requestTimeoutMs: 30000,
    workerConfig: { userHome: home, copilotHome: sandbox.copilotHome, secretPatterns: [], systemRoots: [process.env.SystemRoot ?? 'C:\\Windows'], flagTable: flagTableOf(loadCatalog()) },
});
const engine = createEngine({ config: store, worker: client, sessionId: SESSION_ID, home, copilotHome: sandbox.copilotHome, temp });

let exitCode = 0;
try {
    for (let i = 0; i < 10; i++) await engine.evaluate({ script: SCRIPT, cwd: repo }); // warm-up (skipped in the statistics)
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        const r = await engine.evaluate({ script: SCRIPT, cwd: repo });
        times.push(performance.now() - t0);
        if (r.verdict !== 'SAFE') throw new Error(`unexpected verdict ${r.verdict}/${r.primaryRule}`);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    console.log(`full path "${SCRIPT}": n=${times.length} median=${times[Math.floor(times.length / 2)].toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${times[times.length - 1].toFixed(1)} ms budget=${budgetMs} ms`);
    if (p95 > budgetMs) {
        console.error(`FAIL: p95 ${p95.toFixed(1)} ms exceeds ${budgetMs} ms`);
        exitCode = 1;
    } else {
        console.log('PASS');
    }
} catch (err) {
    console.error(`ERROR: ${err.message}`);
    exitCode = 2;
} finally {
    await client.stop();
    sandbox.remove();
}
process.exit(exitCode);
