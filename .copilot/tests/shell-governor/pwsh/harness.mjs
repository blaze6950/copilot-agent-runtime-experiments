import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock } from '../helpers/fake-clock.mjs';
import { PwshClient } from '../../../extensions/shell-governor/lib/pwsh-client.mjs';

/** Synthetic user home handed to the worker in its config request (stands in for the real profile folder). */
export const HOME = join(tmpdir(), 'gov-t2-home');
/** Synthetic working directory of the analysed call. */
export const CWD = join(tmpdir(), 'gov-t2-cwd');
/** A second folder that is neither HOME nor CWD. */
export const ELSEWHERE = join(tmpdir(), 'gov-t2-elsewhere');
export const TEMP = process.env.TEMP ?? tmpdir();

/** Small synthetic per-tool flag table (shape of the catalog specs; T3 owns the real catalog files). */
export const FLAG_TABLE = {
    git: { caseSensitive: true, globalNoValue: ['--no-pager', '--bare'], globalWithValue: ['-C', '-c'], valueFlags: ['-m'] },
    gh: { caseSensitive: true, valueFlags: ['-X', '--method', '-f', '-F', '-H'] },
    snow: { caseSensitive: true, valueFlags: ['-c', '-q', '--connection', '--query'] },
    curl: { caseSensitive: true, posix: true, valueFlags: ['-w', '-o', '-H', '-X', '-d'] },
    python: { caseSensitive: true, valueFlags: ['-m', '-c'] },
    az: { caseSensitive: false, valueFlags: ['--query', '-o'] },
};

/** Startup config request payload (machine-specific values come from the caller, never from the worker). */
export function workerConfig(overrides = {}) {
    return {
        userHome: HOME,
        copilotHome: join(HOME, '.copilot'),
        secretPatterns: ['\\\\\\.ssh(\\\\|$)', '\\\\id_(rsa|ed25519)'],
        systemRoots: [process.env.SystemRoot ?? 'C:\\Windows'],
        flagTable: FLAG_TABLE,
        ...overrides,
    };
}

/**
 * Creates a client for the real worker. The caller owns it: stop it in an `after` hook.
 * @param {object} [overrides] PwshClient options
 */
export function createClient(overrides = {}) {
    const clock = createFakeClock();
    const client = new PwshClient({
        pwshPath: 'pwsh',
        idleMs: 600000,
        clock,
        workerConfig: workerConfig(),
        requestTimeoutMs: 30000,
        ...overrides,
    });
    return { client, clock };
}

/** Case-insensitive path equality (Windows paths). */
export const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** First command with the given (lower-case) name. */
export const commandNamed = (facts, name) => facts.commands.find((c) => c.name === name);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the predicate holds or the timeout expires. */
export async function waitFor(predicate, timeoutMs = 10000, stepMs = 25) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (predicate()) return true;
        await sleep(stepMs);
    }
    return predicate();
}
