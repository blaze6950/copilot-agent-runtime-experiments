import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage3, stage3Triggers, combine } from '../../extensions/shell-governor/lib/policy.mjs';
import * as policyModule from '../../extensions/shell-governor/lib/policy.mjs';
import { CLASS_INTENT, INTENT, OP_CLASS_RANK, RATINGS } from '../../extensions/shell-governor/lib/contracts.mjs';

// Thresholds as shipped in config/governor.json (user decision "stricter").
const THRESHOLDS = Object.freeze({
    hardRatings: ['destructive', 'irreversible', 'credential_access', 'exfiltration'],
    hardThreshold: 1,
    softThreshold: 2,
    minConfidence: 0.7,
});

// The Stage-3 relaxations switched on (stage 2 decisions); the shipped config does not carry these keys yet.
const RELAXED = Object.freeze({ ...THRESHOLDS, taskMismatchAloneAsksAt: 3, credentialAccessReadOnlyAllowed: true });
const READ_FACTS = Object.freeze({ classes: ['read'], intents: ['read'], paths: [], notes: [] });
const READ_CALL = Object.freeze({ facts: READ_FACTS, ruleIds: ['READ-REMOTE'] }); // an allowlisted engine rule id (READ_ONLY_RULES)

/** Engine evidence of one call, as the policy receives it. Default: one allowlisted rule id. */
const call = (facts, ruleIds = ['READ']) => ({ facts, ruleIds });

/** @param {Record<string, number>} [over] @param {number} [confidence] */
function ratings(over = {}, confidence = 0.9) {
    const values = Object.fromEntries(RATINGS.map((k) => [k, 0]));
    return { values: { ...values, ...over }, confidence, whatItDoes: 'test', worstConsequence: 'none' };
}

test('Policy_StrictCategoryOne_Asks', () => {
    for (const key of THRESHOLDS.hardRatings) {
        const result = stage3(ratings({ [key]: 1 }), THRESHOLDS);
        assert.equal(result.decision, 'ASK', key);
        assert.ok(result.reasons.some((r) => r.includes(key)), `reason names ${key}`);
    }
});

test('Policy_OtherCategoryTwo_Asks', () => {
    const soft = RATINGS.filter((k) => !THRESHOLDS.hardRatings.includes(k));
    for (const key of soft) {
        assert.equal(stage3(ratings({ [key]: 1 }), THRESHOLDS).decision, 'ALLOW', `${key}=1 is below the soft threshold`);
        const result = stage3(ratings({ [key]: 2 }), THRESHOLDS);
        assert.equal(result.decision, 'ASK', key);
        assert.ok(result.reasons.some((r) => r.includes(key)));
    }
});

test('Policy_ConfidenceBelowPointSeven_Asks', () => {
    const result = stage3(ratings({}, 0.69), THRESHOLDS);
    assert.equal(result.decision, 'ASK');
    assert.ok(result.reasons.some((r) => r.includes('confidence')));
    assert.equal(stage3(ratings({}, 0.7), THRESHOLDS).decision, 'ALLOW', 'exactly the minimum is accepted');
});

test('Policy_AllBelowThresholds_Allows', () => {
    const result = stage3(ratings({ blast_radius: 1, prod_external: 1, task_mismatch: 1 }, 0.95), THRESHOLDS);
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
});

test('Policy_ThresholdsComeFromConfig_NotConstants', () => {
    const lax = { ...THRESHOLDS, hardThreshold: 2, softThreshold: 3, minConfidence: 0.5 };
    assert.equal(stage3(ratings({ destructive: 1, obfuscation: 2 }, 0.6), lax).decision, 'ALLOW');
    assert.equal(stage3(ratings({ destructive: 2 }), lax).decision, 'ASK');
    const custom = { ...THRESHOLDS, hardRatings: ['obfuscation'] };
    assert.equal(stage3(ratings({ obfuscation: 1 }), custom).decision, 'ASK');
    assert.equal(stage3(ratings({ destructive: 1 }), custom).decision, 'ALLOW', 'destructive is now a soft rating');
});

test('Policy_RuleAsk_NeverLowered', () => {
    const clean = { outcome: 'ratings', ratings: ratings(), latencyMs: 5, cached: false };
    for (const rule of ['ASK', { verdict: 'ASK', ruleIds: ['r1'], reason: 'rule says ask' }]) {
        const result = combine(rule, clean, THRESHOLDS);
        assert.equal(result.decision, 'ASK');
        assert.ok(result.reasons.length > 0);
    }
});

test('Policy_RuleSyntax_Denies', () => {
    const clean = { outcome: 'ratings', ratings: ratings(), latencyMs: 5, cached: false };
    assert.equal(combine('SYNTAX', clean, THRESHOLDS).decision, 'DENY');
});

test('Policy_RuleSafe_AllowsWithoutJudge', () => {
    assert.equal(combine('SAFE', undefined, THRESHOLDS).decision, 'ALLOW');
});

test('Policy_RuleAi_JudgeOutcomeDecides', () => {
    const clean = { outcome: 'ratings', ratings: ratings(), latencyMs: 5, cached: false };
    const risky = { outcome: 'ratings', ratings: ratings({ exfiltration: 3 }), latencyMs: 5, cached: false };
    const failed = { outcome: 'ask', reason: 'timeout' };
    assert.equal(combine('AI', clean, THRESHOLDS).decision, 'ALLOW');
    assert.equal(combine('AI', risky, THRESHOLDS).decision, 'ASK');
    const asked = combine('AI', failed, THRESHOLDS);
    assert.equal(asked.decision, 'ASK');
    assert.ok(asked.reasons.some((r) => r.includes('timeout')));
    assert.equal(combine('AI', undefined, THRESHOLDS).decision, 'ASK', 'no judge outcome for an AI verdict asks');
});

test('Policy_InvalidRatings_Asks', () => {
    assert.equal(stage3(undefined, THRESHOLDS).decision, 'ASK');
    assert.equal(stage3({ values: { destructive: 0 }, confidence: 0.9 }, THRESHOLDS).decision, 'ASK', 'missing ratings');
});

test('Policy_MissingOrInvalidThresholds_FailsClosed', () => {
    const clean = ratings();
    const bad = [
        undefined, null, {}, { ...THRESHOLDS, hardThreshold: undefined }, { ...THRESHOLDS, softThreshold: 'two' },
        { ...THRESHOLDS, minConfidence: NaN }, { ...THRESHOLDS, hardThreshold: Number.NaN }, { ...THRESHOLDS, hardRatings: 'destructive' },
        { ...THRESHOLDS, hardRatings: undefined }, { ...THRESHOLDS, hardRatings: [1, 2] },
    ];
    for (const thresholds of bad) {
        const result = stage3(clean, thresholds);
        assert.equal(result.decision, 'ASK', JSON.stringify(thresholds));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid']);
    }
});

test('Policy_NonFiniteConfidence_FailsClosed', () => {
    for (const confidence of [NaN, Infinity, -Infinity, undefined, '0.9']) {
        const result = stage3({ ...ratings(), confidence }, THRESHOLDS);
        assert.equal(result.decision, 'ASK', String(confidence));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid']);
    }
});

test('Policy_HardRatingsWithUnknownNameOrEmpty_FailsClosed', () => {
    const clean = ratings();
    for (const hardRatings of [['destructve'], ['destructive', 'nope'], []]) {
        const result = stage3(clean, { ...THRESHOLDS, hardRatings });
        assert.equal(result.decision, 'ASK', JSON.stringify(hardRatings));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid']);
    }
});

test('Policy_ValidHardRatingsList_DestructiveOneAsks', () => {
    const result = stage3(ratings({ destructive: 1 }), { ...THRESHOLDS, hardRatings: ['destructive', 'exfiltration'] });

    assert.equal(result.decision, 'ASK');
    assert.ok(result.reasons.some((r) => r.includes('destructive')));
});

test('Policy_CombineAiWithInvalidThresholds_Asks', () => {
    const clean = { outcome: 'ratings', ratings: ratings(), latencyMs: 5, cached: false };

    const result = combine('AI', clean, undefined);

    assert.equal(result.decision, 'ASK');
});

test('Policy_Stage3Triggers_ListsRatingsAtOrAboveLimitThenLowConfidence', () => {
    // Arrange
    const judged = ratings({ destructive: 1, blast_radius: 1, task_mismatch: 2 }, 0.5);

    // Act
    const triggers = stage3Triggers(judged, THRESHOLDS);

    // Assert
    assert.deepEqual(triggers, [
        { name: 'destructive', value: 1, limit: 1 },
        { name: 'task_mismatch', value: 2, limit: 2 },
        { name: 'confidence', value: 0.5, limit: 0.7 },
    ]);
});

test('Policy_Stage3Triggers_EmptyWhenAllowedOrInvalid', () => {
    // Arrange
    const allowed = ratings({ blast_radius: 1 }, 0.95);
    const noRatings = { values: { destructive: 0 }, confidence: 0.9 };

    // Act / Assert
    assert.deepEqual(stage3Triggers(allowed, THRESHOLDS), []);
    assert.deepEqual(stage3Triggers(undefined, THRESHOLDS), [], 'missing ratings');
    assert.deepEqual(stage3Triggers(noRatings, THRESHOLDS), [], 'malformed ratings');
    assert.deepEqual(stage3Triggers(ratings({ destructive: 3 }), undefined), [], 'missing thresholds');
    assert.deepEqual(stage3Triggers({ ...ratings(), confidence: NaN }, THRESHOLDS), [], 'non-finite confidence');
});

// ---- AC-14: task_mismatch alone asks at 3 (2 when another rating is 1 or more) ----

test('Policy_TaskMismatchAloneTwo_AllowsWhenRelaxed', () => {
    // Arrange
    const judged = ratings({ task_mismatch: 2 });

    // Act
    const result = stage3(judged, RELAXED);

    // Assert
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
});

test('Policy_TaskMismatchAloneThree_Asks', () => {
    // Arrange
    const judged = ratings({ task_mismatch: 3 });

    // Act
    const result = stage3(judged, RELAXED);

    // Assert
    assert.equal(result.decision, 'ASK');
    assert.deepEqual(result.reasons, ['task_mismatch=3 (asks at >= 2)']);
});

test('Policy_TaskMismatchTwoWithOtherRatingOne_Asks', () => {
    for (const key of RATINGS.filter((k) => k !== 'task_mismatch')) {
        // Arrange
        const judged = ratings({ task_mismatch: 2, [key]: 1 });

        // Act
        const result = stage3(judged, RELAXED);

        // Assert
        assert.equal(result.decision, 'ASK', `task_mismatch=2 with ${key}=1`);
        assert.ok(result.reasons.some((r) => r.includes('task_mismatch=2')), key);
    }
});

// ---- AC-15: credential_access = 1 alone is allowed only for a read-only script with engine facts ----

test('Policy_CredentialAccessOneReadOnlyFacts_Allows', () => {
    const classSets = [['read'], ['read-remote'], ['read', 'read-remote']];
    const ruleSets = [['READ'], ['READ-REMOTE'], ['DIR-PROTECTED-READ', 'READ', 'READ-REMOTE']];
    for (const classes of classSets) {
        for (const ruleIds of ruleSets) {
            // Arrange
            const judged = ratings({ credential_access: 1 });
            const evidence = call({ ...READ_FACTS, classes, intents: ['read'], notes: [] }, ruleIds);

            // Act
            const result = stage3(judged, RELAXED, evidence);

            // Assert
            assert.equal(result.decision, 'ALLOW', `${classes.join('+')} with rules ${ruleIds.join('+')}`);
            assert.deepEqual(result.reasons, []);
        }
    }
});

test('Policy_CredentialAccessOneNotReadOnlyFacts_Asks', () => {
    const cases = [
        ['class auth', call({ ...READ_FACTS, classes: ['auth'] })],
        ['class unknown', call({ ...READ_FACTS, classes: ['unknown'] })],
        ['class spawn-agent', call({ ...READ_FACTS, classes: ['spawn-agent'] })],
        ['class session', call({ ...READ_FACTS, classes: ['session'] })],
        ['class credential', call({ ...READ_FACTS, classes: ['credential'] })],
        ['class write', call({ ...READ_FACTS, classes: ['write'] })],
        ['read and execute-code classes', call({ ...READ_FACTS, classes: ['read', 'execute-code'] })],
        ['no classes', call({ ...READ_FACTS, classes: [] })],
        ['intents read and write', call({ ...READ_FACTS, intents: ['read', 'write'] })],
        ['intent execute', call({ ...READ_FACTS, intents: ['execute'] })],
        ['no intents', call({ ...READ_FACTS, intents: [] })],
        ['note dynamic-command', call({ ...READ_FACTS, notes: ['dynamic-command'] })],
        ['note nested-dynamic', call({ ...READ_FACTS, notes: ['nested-dynamic'] })],
        ['note download-exec', call({ ...READ_FACTS, notes: ['download-exec'] })],
        ['note sql-unresolved', call({ ...READ_FACTS, notes: ['sql-unresolved'] })],
        ['note syntax:1:2', call({ ...READ_FACTS, notes: ['syntax:1:2'] })],
        ['facts undefined', call(undefined)],
        ['facts null', call(null)],
        ['facts without arrays', call({})],
        ['classes not an array', call({ ...READ_FACTS, classes: 'read' })],
        ['rule ids undefined', { facts: READ_FACTS, ruleIds: undefined }],
        ['rule ids not an array', { facts: READ_FACTS, ruleIds: 'UNC-PATH' }],
        ['rule ids with a non-string', { facts: READ_FACTS, ruleIds: [42] }],
        ['call undefined', undefined],
        ['rule ids empty', { facts: READ_FACTS, ruleIds: [] }],
        ['class cost with CLASS-COST (aws ec2 run-instances)', call({ ...READ_FACTS, classes: ['cost'] }, ['CLASS-COST'])],
    ];
    for (const [label, evidence] of cases) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, evidence);

        // Assert
        assert.equal(result.decision, 'ASK', label);
        assert.deepEqual(result.reasons, ['credential_access=1 (asks at >= 1)'], label);
    }
});

test('Policy_CredentialAccessOneWithTaskMismatchTwo_Asks', () => {
    // Arrange: a second rating above zero blocks the credential relaxation
    const judged = ratings({ credential_access: 1, task_mismatch: 2 });

    // Act
    const result = stage3(judged, RELAXED, READ_CALL);

    // Assert
    assert.equal(result.decision, 'ASK');
    assert.ok(result.reasons.includes('credential_access=1 (asks at >= 1)'));
});

test('Policy_CredentialAccessOneReadOnlyFactsLowConfidence_Asks', () => {
    // Arrange: the read-only call is relaxed, but the low confidence still asks
    const judged = ratings({ credential_access: 1 }, 0.5);

    // Act
    const result = stage3(judged, RELAXED, READ_CALL);

    // Assert
    assert.equal(result.decision, 'ASK');
    assert.deepEqual(result.reasons, ['confidence 0.5 below 0.7']);
});

test('Policy_CredentialAccessOneDynamicPathNote_Asks', () => {
    const cases = [
        ['dynamic-path read note', { ...READ_FACTS, notes: ['dynamic-path:read'] }],
        ['dynamic-path read note with a remote read', { ...READ_FACTS, classes: ['read-remote'], notes: ['dynamic-path:read'] }],
        ['dynamic-path write note', { ...READ_FACTS, notes: ['dynamic-path:write'] }],
    ];
    for (const [label, facts] of cases) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(facts));

        // Assert
        assert.equal(result.decision, 'ASK', label);
    }
});

test('Policy_CredentialAccessOneUncOrRegistryRead_Asks', () => {
    for (const ruleIds of [['UNC-PATH'], ['READ', 'REGISTRY-READ']]) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(READ_FACTS, ruleIds));

        // Assert
        assert.equal(result.decision, 'ASK', ruleIds.join('+'));
        assert.deepEqual(result.reasons, ['credential_access=1 (asks at >= 1)']);
    }
});

test('Policy_CredentialAccessOneUnresolvedRealLocationOrWildcard_Asks', () => {
    for (const ruleId of ['DIR-SHORTNAME-UNRESOLVED', 'DIR-REALPATH-UNRESOLVED', 'DIR-WILDCARD-UNBOUNDED']) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(READ_FACTS, [ruleId]));

        // Assert
        assert.equal(result.decision, 'ASK', ruleId);
        assert.deepEqual(result.reasons, ['credential_access=1 (asks at >= 1)']);
    }
});

test('Policy_CredentialAccessTwoReadOnlyFacts_Asks', () => {
    // Arrange: only credential_access = 1 can be relaxed
    const judged = ratings({ credential_access: 2 });

    // Act
    const result = stage3(judged, RELAXED, READ_CALL);

    // Assert
    assert.equal(result.decision, 'ASK');
    assert.deepEqual(result.reasons, ['credential_access=2 (asks at >= 1)']);
});

test('Policy_RelaxationKeysAbsent_StrictAsToday', () => {
    // Arrange: the thresholds without the two optional keys
    const taskMismatch = ratings({ task_mismatch: 2 });
    const credential = ratings({ credential_access: 1 });

    // Act / Assert
    assert.equal(stage3(taskMismatch, THRESHOLDS).decision, 'ASK');
    assert.equal(stage3(credential, THRESHOLDS, READ_CALL).decision, 'ASK');
});

test('Policy_RelaxationKeysInvalid_FailsClosed', () => {
    // Arrange
    const clean = ratings();
    const invalid = [
        { ...RELAXED, taskMismatchAloneAsksAt: 'x' },
        { ...RELAXED, credentialAccessReadOnlyAllowed: 'yes' },
    ];
    for (const thresholds of invalid) {
        // Act
        const result = stage3(clean, thresholds, READ_CALL);

        // Assert
        assert.equal(result.decision, 'ASK', JSON.stringify(thresholds));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid']);
    }
});

test('Policy_ReadOnlyClasses_AreKnownOperationClasses', () => {
    for (const operationClass of policyModule.READ_ONLY_CLASSES) {
        // Act / Assert
        assert.ok(OP_CLASS_RANK.includes(operationClass), operationClass);
        assert.equal(CLASS_INTENT[operationClass], INTENT.READ, operationClass);
    }
});

test('Policy_CombinePassesEngineFactsToStage3', () => {
    // Arrange
    const judged = { outcome: 'ratings', ratings: ratings({ credential_access: 1 }), latencyMs: 5, cached: false };
    const hookShape = { verdict: 'AI', facts: READ_FACTS, rules: [{ verdict: 'AI', rule: 'READ-REMOTE' }] };
    const replayShape = { verdict: 'AI', facts: READ_FACTS, rules: ['READ-REMOTE'] };
    const uncShape = { verdict: 'AI', facts: READ_FACTS, rules: [{ verdict: 'AI', rule: 'UNC-PATH' }] };
    const unknownClass = { verdict: 'AI', facts: { ...READ_FACTS, classes: ['unknown'] }, rules: ['READ-REMOTE'] };

    // Act / Assert
    assert.equal(combine(hookShape, judged, RELAXED).decision, 'ALLOW', 'hook shape');
    assert.equal(combine(replayShape, judged, RELAXED).decision, 'ALLOW', 'replay shape');
    assert.equal(combine(uncShape, judged, RELAXED).decision, 'ASK', 'unchecked read rule');
    assert.equal(combine(unknownClass, judged, RELAXED).decision, 'ASK', 'unknown class');
    assert.equal(combine('AI', judged, RELAXED).decision, 'ASK', 'bare AI verdict has no facts');
});

// ---- review T15 W1 (READ-RECURSIVE) and W2 (DYNAMIC-INVOKE): an allowlist of engine rule ids ----

test('Policy_CredentialAccessOneRecursiveOrDynamicInvoke_Asks', () => {
    // Arrange: the real engine rule ids of the review
    const ruleSets = [['DIR-PROTECTED-READ', 'READ-RECURSIVE', 'READ'], ['READ-ANYWHERE', 'READ', 'DYNAMIC-INVOKE']];
    for (const ruleIds of ruleSets) {
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(READ_FACTS, ruleIds));

        // Assert
        assert.equal(result.decision, 'ASK', ruleIds.join('+'));
        assert.deepEqual(result.reasons, ['credential_access=1 (asks at >= 1)'], ruleIds.join('+'));
    }
});

test('Policy_CredentialAccessOneRuleNotAllowlisted_Asks', () => {
    const ids = [
        'READ-RECURSIVE', 'DYNAMIC-INVOKE', 'DYN-PATH-READ', 'UNC-PATH', 'REGISTRY-READ', 'DIR-SHORTNAME-UNRESOLVED',
        'DIR-REALPATH-UNRESOLVED', 'DIR-WILDCARD-UNBOUNDED', 'CLASS-COST', 'CLASS-UNKNOWN', 'AUTH', 'UNANALYZED', 'SQL-SESSION',
        'SPAWN', 'B3-INLINE', 'DIR-OUTSIDE', 'PROVIDER-WRITE', 'FUTURE-RULE', 'read',
    ];
    for (const id of ids) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(READ_FACTS, ['READ', id]));

        // Assert
        assert.equal(result.decision, 'ASK', id);
    }
});

test('Policy_CredentialAccessOneAllowlistedRule_Allows', () => {
    for (const id of policyModule.READ_ONLY_RULES) {
        // Arrange
        const judged = ratings({ credential_access: 1 });

        // Act
        const result = stage3(judged, RELAXED, call(READ_FACTS, [id]));

        // Assert
        assert.equal(result.decision, 'ALLOW', id);
        assert.deepEqual(result.reasons, [], id);
    }
});

test('Policy_ReadOnlyRules_ExactAllowlist', () => {
    // Act / Assert
    assert.deepEqual([...policyModule.READ_ONLY_RULES], ['READ', 'READ-REMOTE', 'D-OFFICIAL-READ', 'READ-ANYWHERE', 'DIR-OK', 'DIR-PROTECTED-READ']);
    assert.equal(Object.isFrozen(policyModule.READ_ONLY_RULES), true);
});

// ---- review T15 Suggestion 3: taskMismatchAloneAsksAt must be above softThreshold and at most RATING_MAX ----

test('Policy_TaskMismatchAloneAsksAtNotAboveSoftThreshold_FailsClosed', () => {
    for (const value of [2, 1]) {
        // Arrange
        const thresholds = { ...RELAXED, taskMismatchAloneAsksAt: value };

        // Act
        const result = stage3(ratings(), thresholds, READ_CALL);

        // Assert
        assert.equal(result.decision, 'ASK', String(value));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid'], String(value));
    }
});

test('Policy_TaskMismatchAloneAsksAtAboveMaxRating_FailsClosed', () => {
    for (const value of [4, 30]) {
        // Arrange
        const thresholds = { ...RELAXED, taskMismatchAloneAsksAt: value };

        // Act
        const result = stage3(ratings(), thresholds, READ_CALL);

        // Assert
        assert.equal(result.decision, 'ASK', String(value));
        assert.deepEqual(result.reasons, ['stage3 thresholds or confidence invalid'], String(value));
    }
    // Arrange / Act / Assert: the upper bound itself is valid
    assert.equal(stage3(ratings(), { ...RELAXED, taskMismatchAloneAsksAt: 3 }, READ_CALL).decision, 'ALLOW');
});

