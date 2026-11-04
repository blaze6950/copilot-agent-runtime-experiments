import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit } from '../../extensions/shell-governor/lib/audit.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';

const DAY_FILE = 'audit-2026-10-19.jsonl';

function tempRoot(t) {
    const root = mkdtempSync(join(tmpdir(), 'gov audit '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function tempLogsDir(t) {
    return join(tempRoot(t), 'logs');
}

/** A logs folder whose parent is a regular file, so the folder cannot be created. */
function blockedLogsDir(t) {
    const root = tempRoot(t);
    writeFileSync(join(root, 'blocker'), 'not a folder');
    return join(root, 'blocker', 'logs');
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);

test('Audit_Decision_WritesOneJsonLineWithoutScriptText', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const clock = createFakeClock('2026-10-19T08:00:00.000Z');
    const audit = createAudit({ logsDir, clock });
    const script = 'Remove-Item -Recurse C:\\data\npassword=SECRET-SCRIPT-7';
    // Act
    audit.write({
        session: 'session-1',
        agent: 'sub-worker-wt',
        tool: 'powershell',
        script,
        verdict: 'ASK',
        ruleIds: ['DEL-01'],
        ratings: { destructive: 2 },
        judgeLatencyMs: 812,
        dialogOutcome: 'deny',
        reason: 'declined by user: token=SECRET-REASON-9',
        args: '--password SECRET-ARG-5',
        text: 'leaked text field',
    });
    // Assert
    const raw = readFileSync(join(logsDir, DAY_FILE), 'utf8');
    const lines = linesOf(join(logsDir, DAY_FILE));
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
        time: '2026-10-19T08:00:00.000Z',
        session: 'session-1',
        agent: 'sub-worker-wt',
        tool: 'powershell',
        scriptHash: sha256(script),
        verdict: 'ASK',
        ruleIds: ['DEL-01'],
        ratings: { destructive: 2 },
        judgeLatencyMs: 812,
        dialogOutcome: 'deny',
    });
    for (const secret of ['SECRET-SCRIPT-7', 'SECRET-REASON-9', 'SECRET-ARG-5', 'leaked text field', 'Remove-Item']) {
        assert.ok(!raw.includes(secret), `audit line leaks "${secret}"`);
    }
});

test('Audit_SignatureAndSecretShapedRuleId_NeverPersisted', (t) => {
    // Arrange: a signature of a cmd /c whose first token is secret-like, a cmd script, and a rule id that holds a secret
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    const secret = 'abc123secret';
    // Act
    audit.write({
        session: 's',
        agent: 'main',
        tool: 'powershell',
        script: `cmd /c set TOKEN=${secret}`,
        signature: `cmd:${secret}.exe[execute-code]{}`,
        verdict: 'ASK',
        ruleIds: [`${secret} TOKEN=${secret}`, 'DEL-01'],
    });
    // Assert: only the hash, the verdict and the rule id that matches the rule-id pattern
    const raw = readFileSync(join(logsDir, DAY_FILE), 'utf8');
    assert.ok(!raw.includes(secret), 'audit line leaks the secret-like token');
    const [record] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.deepEqual(record.ruleIds, ['DEL-01']);
    assert.equal(record.scriptHash, sha256(`cmd /c set TOKEN=${secret}`));
    assert.equal(Object.hasOwn(record, 'signature'), false);
});

test('Audit_TwoDecisionsOnOneDay_AppendsTwoLines', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const clock = createFakeClock('2026-10-19T08:00:00.000Z');
    const audit = createAudit({ logsDir, clock });
    // Act
    audit.write({ session: 's', agent: 'a', tool: 'powershell', verdict: 'SAFE', ruleIds: [] });
    clock.advance(1000);
    audit.write({ session: 's', agent: 'a', tool: 'powershell', verdict: 'AI', ruleIds: [] });
    // Assert
    assert.deepEqual(linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line).verdict), ['SAFE', 'AI']);
});

test('Audit_DecisionsOnTwoDays_WritesOneFilePerDay', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const clock = createFakeClock('2026-10-19T23:59:00.000Z');
    const audit = createAudit({ logsDir, clock });
    // Act
    audit.write({ session: 's', verdict: 'SAFE', ruleIds: [] });
    clock.advance(120_000);
    audit.write({ session: 's', verdict: 'SAFE', ruleIds: [] });
    // Assert
    assert.equal(linesOf(join(logsDir, 'audit-2026-10-19.jsonl')).length, 1);
    assert.equal(linesOf(join(logsDir, 'audit-2026-10-20.jsonl')).length, 1);
});

test('Audit_LogWriteFails_ReturnsFalseAndReportsWithoutThrowing', (t) => {
    // Arrange
    const errors = [];
    const audit = createAudit({
        logsDir: blockedLogsDir(t),
        clock: createFakeClock(),
        onError: (err) => errors.push(err),
    });
    let result;
    // Act
    assert.doesNotThrow(() => {
        result = audit.write({ session: 's', verdict: 'SAFE', ruleIds: [] });
    });
    // Assert
    assert.equal(result, false);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
});

test('Audit_OnErrorThrows_WriteStillReturnsFalse', (t) => {
    // Arrange
    const audit = createAudit({
        logsDir: blockedLogsDir(t),
        clock: createFakeClock(),
        onError: () => {
            throw new Error('reporter failed');
        },
    });
    let result;
    // Act
    assert.doesNotThrow(() => {
        result = audit.write({ session: 's', verdict: 'SAFE', ruleIds: [] });
    });
    // Assert
    assert.equal(result, false);
});

test('Audit_InvalidIdentifiers_AreWrittenAsNull', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({ session: 'bad\nsession', agent: 'agent with spaces', tool: '../../evil', verdict: 'SAFE' });
    audit.write({ session: 'session-1', agent: 'a'.repeat(65), tool: 'powershell', verdict: 'SAFE' });
    // Assert
    const [first, second] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.equal(first.session, null);
    assert.equal(first.agent, null);
    assert.equal(first.tool, null);
    assert.equal(second.agent, null);
    assert.equal(second.session, 'session-1');
    assert.equal(second.tool, 'powershell');
});

test('Audit_IdentifierLongerThanThirtyTwo_IsWrittenAsNull', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({
        session: 's'.repeat(33),
        agent: 'a'.repeat(32),
        tool: 't'.repeat(33),
        verdict: 'SAFE',
        ruleIds: ['R'.repeat(40)],
    });
    // Assert
    const [record] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.equal(record.session, null, 'session of 33 characters is dropped');
    assert.equal(record.agent, 'a'.repeat(32), 'agent of 32 characters is kept');
    assert.equal(record.tool, null, 'tool of 33 characters is dropped');
    assert.deepEqual(record.ruleIds, ['R'.repeat(40)], 'rule ids keep the 64-character limit');
});

test('Audit_UnknownVerdict_IsWrittenAsNull', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({ session: 's', verdict: 'ALLOW' });
    audit.write({ session: 's', verdict: 'ASK' });
    // Assert
    const [unknown, known] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.equal(unknown.verdict, null);
    assert.equal(known.verdict, 'ASK');
});

test('Audit_UnknownDialogOutcome_IsWrittenAsNull', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({ session: 's', verdict: 'ASK', dialogOutcome: 'declined by user: no thanks' });
    audit.write({ session: 's', verdict: 'ASK', dialogOutcome: 'hook-ask' });
    // Assert
    const [free, known] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.equal(free.dialogOutcome, null);
    assert.equal(known.dialogOutcome, 'hook-ask');
});

test('Audit_RuleIdsWithUnsafeTokens_AreDropped', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({
        session: 's',
        verdict: 'ASK',
        ruleIds: ['DEL-01', 'bad id\nFAKE', 'x'.repeat(65), { id: 'OK.2', explanation: 'not written' }],
    });
    // Assert
    const [record] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.deepEqual(record.ruleIds, ['DEL-01', 'OK.2']);
});

test('Audit_RatingValuesOutsideZeroToThree_AreDropped', (t) => {
    // Arrange
    const logsDir = tempLogsDir(t);
    const audit = createAudit({ logsDir, clock: createFakeClock('2026-10-19T08:00:00.000Z') });
    // Act
    audit.write({
        session: 's',
        verdict: 'ASK',
        ratings: { destructive: 2, irreversible: 9, exfiltration: 1.5, blast_radius: '3', obfuscation: -1 },
    });
    // Assert
    const [record] = linesOf(join(logsDir, DAY_FILE)).map((line) => JSON.parse(line));
    assert.deepEqual(record.ratings, { destructive: 2 });
});
