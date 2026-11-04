import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dialogModule from '../../extensions/shell-governor/lib/dialog.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';

const { createDialog } = dialogModule;

const SCRIPT_25 = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}`).join('\n');
const CONFIG = Object.freeze({ dialog: { scriptLines: 20 } });
/** Time a scripted answer takes on the fake clock unless the step sets afterMs. */
const SLOW_ANSWER_MS = 3000;

function makeRoot(t) {
    const root = mkdtempSync(join(tmpdir(), 'gov dialog '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function tempReviewsDir(t) {
    return join(makeRoot(t), 'reviews');
}

/** A reviews folder whose parent is a regular file, so the folder cannot be created. */
function blockedReviewsDir(t) {
    const root = makeRoot(t);
    writeFileSync(join(root, 'blocker'), 'not a folder');
    return join(root, 'blocker', 'reviews');
}

/** Fake session.ui: each queued step is an answer (advances the clock) or an Error (thrown). Records every shown form. */
function scriptedUi(clock, steps) {
    const queue = [...steps];
    const shown = [];
    return {
        shown,
        elicitation: async (params) => {
            shown.push(params);
            const step = queue.shift();
            if (step === undefined) throw new Error('test: no scripted answer left');
            if (step instanceof Error) throw step;
            clock.advance(step.afterMs ?? SLOW_ANSWER_MS);
            return step.result;
        },
    };
}

const approveOnce = () => ({ result: { action: 'accept', content: { decision: 'approve_once' } } });
const decision = (value) => ({ result: { action: 'accept', content: { decision: value } } });
const cancelled = () => ({ result: { action: 'cancel' } });
const dismissed = () => ({ result: { action: 'decline' } });
const instant = (step) => ({ ...step, afterMs: 0 });

function sampleRequest(overrides = {}) {
    return {
        agentName: 'sub-worker-wt',
        agentType: 'sub-worker',
        taskName: 'T3 build cleanup',
        cwd: 'C:\\code\\proj',
        tool: 'powershell',
        script: SCRIPT_25,
        ruleIds: [{ id: 'DEL-01', explanation: 'deletes files recursively' }],
        ratings: {
            values: {
                destructive: 2, irreversible: 1, credential_access: 0, exfiltration: 0, blast_radius: 2,
                privilege_persistence: 0, prod_external: 0, obfuscation: 0, task_mismatch: 1,
            },
            confidence: 0.9,
            whatItDoes: 'Deletes a build folder.',
            worstConsequence: 'The build output must be rebuilt.',
        },
        facts: { classes: ['delete'], intents: ['delete'], paths: ['C:\\code\\proj\\bin'], notes: [] },
        agentDescription: 'Clean the build output',
        ...overrides,
    };
}

/** The review-file link of a message (the agent-file link is also file:///, so it is matched by its label). */
const linkOf = (message) => message.match(/Full script and details: (file:\/\/\/\S+)/)[1];
const reviewPathFrom = (message) => fileURLToPath(linkOf(message));

/** Creates <root>/agents/<name>.agent.md and returns the agents folder. */
function agentsDirWith(t, name) {
    const agentsDir = join(makeRoot(t), 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${name}.agent.md`), '---\nname: x\n---\n');
    return agentsDir;
}

/** Asserts that each needle occurs in the text, each one after the previous one. */
function assertInOrder(text, needles) {
    let from = 0;
    for (const needle of needles) {
        const at = text.indexOf(needle, from);
        assert.ok(at >= 0, `missing or out of order: "${needle}"`);
        from = at + needle.length;
    }
}

test('Dialog_Message_LayoutInAcceptedOrder', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const agentsDir = agentsDirWith(t, 'sub-worker-wt');
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG, agentsDir });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    const { message } = ui.shown[0];
    assertInOrder(message, [
        'Shell governor: approval needed',
        'Agent: sub-worker-wt — "T3 build cleanup"',
        'Agent file: file:///',
        'Purpose stated by the agent (unverified):',
        'What it does (AI): Deletes a build folder.',
        'Worst realistic consequence (AI): The build output must be rebuilt.',
        'Rules: DEL-01',
        'Full script and details: file:///',
        'Script (first 20 of 25 lines):',
    ]);
    assert.ok(message.includes('20 | Line 20'));
    assert.ok(message.includes('[cut at 20 lines, full script in the review file]'));
    assert.ok(!message.includes('Line 21'));
    assert.ok(message.includes('Answer "Approve once" or "Decline", or type guidance in "Other" (counts as Decline).'));
    assert.equal(reviewPathFrom(message), join(reviewsDir, readdirSync(reviewsDir)[0]));
});

test('Dialog_Message_NoTaskName_HeaderWithoutTaskPart', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ taskName: undefined }));
    // Assert
    assert.match(ui.shown[0].message, /^Agent: sub-worker-wt$/m);
});

test('Dialog_Message_AgentFileMissing_NoAgentFileLine', async (t) => {
    // Arrange: the agents folder exists, but holds no file for this agent
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const agentsDir = join(makeRoot(t), 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, agentsDir });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    assert.ok(!ui.shown[0].message.includes('Agent file:'));
});

test('Dialog_Message_AgentNameWithPathCharacters_NoAgentFileLine', async (t) => {
    // Arrange: the joined paths exist, but the names are not plain agent names
    const clock = createFakeClock();
    const agentsDir = agentsDirWith(t, 'sub-worker-wt');
    mkdirSync(join(agentsDir, 'a'));
    writeFileSync(join(agentsDir, 'a', 'b.agent.md'), '');
    writeFileSync(join(agentsDir, '..\\x.agent.md'), '');
    for (const agentName of ['..\\x', 'a/b']) {
        const ui = scriptedUi(clock, [approveOnce()]);
        const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, agentsDir });
        // Act
        await dialog.ask(sampleRequest({ agentName }));
        // Assert
        assert.ok(!ui.shown[0].message.includes('Agent file:'), `agent name "${agentName}" must not be linked`);
    }
});

test('Dialog_Message_RatingsFactsClaimAndExplanations_OnlyInReviewFile', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    for (const hidden of ['AI ratings', 'AI confidence', 'Extracted facts', "Agent's description", 'deletes files recursively']) {
        assert.ok(!message.includes(hidden), `message shows "${hidden}"`);
    }
    const review = readFileSync(reviewPathFrom(message), 'utf8');
    for (const shown of ['AI ratings', 'AI confidence: 0.90', 'Extracted facts', "Agent's description", 'deletes files recursively']) {
        assert.ok(review.includes(shown), `review file lacks "${shown}"`);
    }
});

test('Dialog_Message_JudgeSentencesMissing_ShowsNotGiven', async (t) => {
    // Arrange: ratings without the two judge sentences
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ ratings: { values: sampleRequest().ratings.values, confidence: 0.9 } }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('What it does (AI): not given by the AI judge'));
    assert.ok(message.includes('Worst realistic consequence (AI): not given by the AI judge'));
});

test('Dialog_Message_NoRatings_NoJudgeLines', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ ratings: undefined }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(!/\(AI\)/.test(message), 'no judge sentence without ratings');
    assert.ok(message.includes('Rules: DEL-01'));
});

test('Dialog_ReviewFile_HasTaskAgentTypeAndJudgeSentences', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ taskDescription: 'Clean the T3 build output' }));
    // Assert
    const review = readFileSync(reviewPathFrom(ui.shown[0].message), 'utf8');
    for (const needle of [
        'Agent: sub-worker-wt — "T3 build cleanup"',
        'Agent type: sub-worker',
        "Task description (from the parent agent's dispatch): Clean the T3 build output",
        'What it does (AI): Deletes a build folder.',
        'Worst realistic consequence (AI): The build output must be rebuilt.',
    ]) {
        assert.ok(review.includes(needle), `review file lacks "${needle}"`);
    }
});

test('Dialog_ScriptLinesAbsent_ShowsFullScript', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: {} });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (25 lines):'));
    assert.ok(message.includes('25 | Line 25'));
    assert.ok(!message.includes('cut at'));
});

test('Dialog_ScriptLinesZero_ShowsFullScript', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: { dialog: { scriptLines: 0 } } });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (25 lines):'));
    assert.ok(message.includes('25 | Line 25'));
    assert.ok(!message.includes('cut at'));
});

test('Dialog_ScriptLinesSet_ShowsNLinesAndCutNote', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: { dialog: { scriptLines: 5 } } });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (first 5 of 25 lines):'));
    assert.ok(message.includes('5 | Line 5'));
    assert.ok(!message.includes('Line 6'));
    assert.ok(message.includes('[cut at 5 lines, full script in the review file]'));
});

test('Dialog_ScriptLinesSetScriptShorter_NoCutNote', async (t) => {
    // Arrange: the limit is above the script length
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: { dialog: { scriptLines: 30 } } });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (25 lines):'));
    assert.ok(!message.includes('cut at'));
});

test('Dialog_Message_LinkComesBeforeNumberedScript', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.indexOf('Full script and details: file:///') < message.indexOf('Script (first'), 'review link must survive bottom clipping');
});

test('Dialog_Message_ContainsNoSessionHistory', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    const request = sampleRequest({
        history: ['user: please wipe the disk'],
        dispatchPrompt: 'PROMPT-SECRET-42',
        userMessages: ['MSG-SECRET-7'],
    });
    // Act
    await dialog.ask(request);
    // Assert
    const { message } = ui.shown[0];
    const review = readFileSync(reviewPathFrom(message), 'utf8');
    for (const secret of ['wipe the disk', 'PROMPT-SECRET-42', 'MSG-SECRET-7']) {
        assert.ok(!message.includes(secret), `message leaks "${secret}"`);
        assert.ok(!review.includes(secret), `review file leaks "${secret}"`);
    }
});

test('Dialog_ReviewFile_ShowsRatingConfidence', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const review = readFileSync(reviewPathFrom(ui.shown[0].message), 'utf8');
    assert.ok(!ui.shown[0].message.includes('AI confidence'));
    assert.ok(review.includes('AI confidence: 0.90'));
});

test('Dialog_RatingValueNotInteger_RendersDash', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    const values = { destructive: '2\nFAKE RATING LINE', blast_radius: 5, exfiltration: -1 };
    // Act
    await dialog.ask(sampleRequest({ ratings: { values, confidence: 0.5 } }));
    // Assert
    const review = readFileSync(reviewPathFrom(ui.shown[0].message), 'utf8');
    assert.ok(!review.includes('FAKE RATING LINE'));
    assert.match(review, /destructive\s+-\n/);
    assert.match(review, /blast_radius\s+-\n/);
    assert.match(review, /exfiltration\s+-\n/);
});

test('Dialog_ScriptControlChars_AreEscapedInMessageAndReview', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    const script = 'Echo first\rEcho \x1b[8mSECRET-CONCEAL\x1b[0m done\nEcho third\nEcho c1\u0085\u009b\u2028end';
    // Act
    await dialog.ask(sampleRequest({ script, agentDescription: 'claim\u2029end' }));
    // Assert
    const { message } = ui.shown[0];
    const review = readFileSync(reviewPathFrom(message), 'utf8');
    assert.ok(message.includes('1 | Echo first'), 'lone CR splits lines');
    assert.ok(message.includes('2 | Echo \\x1b[8mSECRET-CONCEAL\\x1b[0m done'));
    assert.ok(message.includes('3 | Echo third'));
    assert.ok(!message.includes('\x1b'), 'message has no raw ESC');
    assert.ok(!message.includes('\r'), 'message has no raw CR');
    assert.ok(review.includes('2 | Echo \\x1b[8mSECRET-CONCEAL\\x1b[0m done'));
    assert.ok(!review.includes('\x1b'), 'review file has no raw ESC');
    assert.ok(!review.includes('\r'), 'review file has no raw CR');
    assert.ok(message.includes('4 | Echo c1\\x85\\x9b\\u2028end'), 'C1 controls and line separator are escaped');
    for (const raw of ['\u0085', '\u009b', '\u2028', '\u2029']) {
        assert.ok(!message.includes(raw), `message has raw ${JSON.stringify(raw)}`);
        assert.ok(!review.includes(raw), `review file has raw ${JSON.stringify(raw)}`);
    }
});

test('Dialog_BidiAndZeroWidthChars_EscapedEverywhereWithWarning', async (t) => {
    // Arrange: RLO reorders the display, ZWSP and BOM are invisible; each also in a header field
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    const hidden = ['\u200b', '\u200f', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\ufeff'];
    const script = `Remove-Item .\\a${hidden.join('')}b\u202eEvil`;
    // Act
    await dialog.ask(sampleRequest({ script, agentName: 'sub-\u202eworker', cwd: 'C:\\code\u200b\\proj' }));
    // Assert
    const { message } = ui.shown[0];
    const review = readFileSync(reviewPathFrom(message), 'utf8');
    for (const [label, text] of [['message', message], ['review', review]]) {
        for (const ch of hidden) assert.ok(!text.includes(ch), `${label} has raw U+${ch.codePointAt(0).toString(16)}`);
        assert.ok(text.includes('\\u202e') && text.includes('\\u200b') && text.includes('\\ufeff'), `${label} shows the escapes`);
        assert.ok(text.includes('Agent: sub-\\u202eworker'), `${label} header field escaped`);
        assert.match(text, /WARNING: .*invisible or direction-control/i, `${label} warns`);
    }
});

test('Dialog_PlainScript_NoInvisibleCharWarning', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ script: 'Get-Date' }));
    // Assert
    assert.ok(!/WARNING/.test(ui.shown[0].message));
});

const LINE_CUT_NOTE = '[long lines cut at 120 characters, full script in the review file]';

test('Dialog_MaxLineCharsAbsent_ShowsLongLineInFull', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: {} });
    const longLine = 'X'.repeat(450);
    // Act
    await dialog.ask(sampleRequest({ script: `${longLine}\nshort` }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes(`1 | ${longLine}\n`), 'the long line is shown in full');
    assert.ok(!message.includes('long lines cut'), 'no line note');
    assert.ok(readFileSync(reviewPathFrom(message), 'utf8').includes(longLine), 'review file keeps the full line');
});

test('Dialog_MaxLineCharsZero_ShowsLongLineInFull', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: { dialog: { maxLineChars: 0 } } });
    const longLine = 'X'.repeat(450);
    // Act
    await dialog.ask(sampleRequest({ script: `${longLine}\nshort` }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes(`1 | ${longLine}\n`), 'the long line is shown in full');
    assert.ok(!message.includes('long lines cut'), 'no line note');
});

test('Dialog_MaxLineCharsSet_CutsLongLineAndShowsOneNoteBelowScript', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: { dialog: { maxLineChars: 120 } } });
    const longLine = 'X'.repeat(450);
    // Act
    await dialog.ask(sampleRequest({ script: `${longLine}\nshort` }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes(`1 | ${'X'.repeat(120)}\n`), 'the line is cut to 120 characters');
    assert.ok(!message.includes('X'.repeat(121)), 'no character beyond the limit is shown');
    assert.equal(message.split(LINE_CUT_NOTE).length - 1, 1, 'exactly one note');
    assert.ok(message.indexOf(LINE_CUT_NOTE) > message.indexOf('2 | short'), 'the note is below the script');
    assert.ok(readFileSync(reviewPathFrom(message), 'utf8').includes(longLine), 'review file keeps the full line');
});

test('Dialog_MaxLineCharsSetNoLongLine_NoLineNote', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: { dialog: { maxLineChars: 120 } } });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (25 lines):'));
    assert.ok(!message.includes('long lines cut'), 'no note when no line is cut');
});

const LINE_CUT_NOTE_50 = '[long lines cut at 50 characters, full script in the review file]';
const LINE_COUNT_NOTE_2 = '[cut at 2 lines, full script in the review file]';

test('Dialog_ScriptLinesAndMaxLineCharsSet_ShowsTwoLinesCutAndBothNotesInFixedOrder', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: { dialog: { scriptLines: 2, maxLineChars: 50 } } });
    const longLine = 'Y'.repeat(200);
    const script = ['Short first line', longLine, 'Third line', 'Fourth line', 'Fifth line'].join('\n');
    // Act
    await dialog.ask(sampleRequest({ script }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes('Script (first 2 of 5 lines):'));
    assert.ok(message.includes('1 | Short first line\n'));
    assert.ok(message.includes(`2 | ${'Y'.repeat(50)}\n`), 'the second line is cut to 50 characters');
    assert.ok(!message.includes('Y'.repeat(51)), 'no character beyond the limit is shown');
    assert.ok(!message.includes('Third line'), 'lines beyond scriptLines are left out');
    assert.equal(message.split(LINE_CUT_NOTE_50).length - 1, 1, 'exactly one line-length note');
    assert.equal(message.split(LINE_COUNT_NOTE_2).length - 1, 1, 'exactly one line-count note');
    assert.ok(message.indexOf('2 | ') < message.indexOf(LINE_CUT_NOTE_50), 'the line-length note sits below the shown lines');
    assert.ok(message.indexOf(LINE_CUT_NOTE_50) < message.indexOf(LINE_COUNT_NOTE_2), 'fixed order: line-length note, then line-count note');
    assert.ok(readFileSync(reviewPathFrom(message), 'utf8').includes(longLine), 'review file keeps the full line');
});

const INVALID_MAX_LINE_CHARS = [['Negative', -5], ['Text', 'abc'], ['NaN', NaN], ['Null', null], ['Fraction', 1.5]];

for (const [label, invalidValue] of INVALID_MAX_LINE_CHARS) {
    test(`Dialog_MaxLineCharsInvalid${label}_ShowsLongLineInFullWithoutNote`, async (t) => {
        // Arrange
        const clock = createFakeClock();
        const ui = scriptedUi(clock, [approveOnce()]);
        const reviewsDir = tempReviewsDir(t);
        const dialog = createDialog({ ui, clock, reviewsDir, config: { dialog: { maxLineChars: invalidValue } } });
        const longLine = 'X'.repeat(450);
        // Act
        await dialog.ask(sampleRequest({ script: `${longLine}\nshort` }));
        // Assert
        const { message } = ui.shown[0];
        assert.ok(message.includes(`1 | ${longLine}\n`), 'the long line is shown in full: no cap');
        assert.ok(!message.includes('long lines cut'), 'no line note');
    });
}

test('Dialog_Message_ShowsCallPurpose', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ callPurpose: 'Delete the build folder' }));
    // Assert: the purpose line is in the message; the agent's claim is review-only
    const { message } = ui.shown[0];
    assert.ok(message.includes('Purpose stated by the agent (unverified): Delete the build folder'));
    assert.ok(!message.includes("Agent's description"));
});

test('Dialog_Message_CallPurposeClippedAtThreeHundredChars', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ callPurpose: `a\n${'p'.repeat(400)}` }));
    // Assert
    const { message } = ui.shown[0];
    assert.ok(message.includes(`Purpose stated by the agent (unverified): a ${'p'.repeat(298)}...`));
    assert.ok(!message.includes('p'.repeat(299)));
});

test('Dialog_Message_CallPurposeMissing_ShowsNoneGiven', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce(), approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    await dialog.ask(sampleRequest({ callPurpose: 42 }));
    // Assert
    for (const { message } of ui.shown) {
        assert.ok(message.includes('Purpose stated by the agent (unverified): none given'));
    }
});

test('Dialog_CallPurposeWithHiddenChars_Warns', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ callPurpose: 'Delete\u202e tmp' }));
    // Assert
    const { message } = ui.shown[0];
    const review = readFileSync(reviewPathFrom(message), 'utf8');
    for (const [label, text] of [['message', message], ['review', review]]) {
        assert.ok(!text.includes('\u202e'), `${label} has no raw RLO`);
        assert.ok(text.includes('Purpose stated by the agent (unverified): Delete\\u202e tmp'), `${label} shows the escape`);
        assert.match(text, /WARNING: .*invisible or direction-control/i, `${label} warns`);
    }
});

test('Dialog_ReviewFile_ShowsCallPurpose', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest({ callPurpose: 'Delete the build folder' }));
    // Assert
    const review = readFileSync(reviewPathFrom(ui.shown[0].message), 'utf8');
    assert.match(review, /Purpose stated by the agent \(unverified\): Delete the build folder\nAgent's description/);
});

test('Dialog_DefaultOption_IsNotDecided', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    assert.equal(ui.shown[0].requestedSchema.properties.decision.default, 'not_decided');
});

test('Dialog_Schema_OnlyDecisionField', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const { properties } = ui.shown[0].requestedSchema;
    assert.deepEqual(Object.keys(properties), ['decision']);
    assert.deepEqual(properties.decision.oneOf, [
        { const: 'not_decided', title: '— not decided —' },
        { const: 'approve_once', title: 'Approve once' },
        { const: 'decline', title: 'Decline' },
    ]);
});

test('Dialog_NotDecided_ReShows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('not_decided'), approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 2);
});

test('Dialog_EscOrCtrlD_ReShows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [cancelled(), dismissed(), approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 3);
});

test('Dialog_MissingOrUnknownContent_ReShows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [
        { result: { action: 'accept' } },
        { result: { action: 'accept', content: {} } },
        approveOnce(),
    ]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 3);
});

test('Dialog_AnswerImmediately_Counts', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [instant(approveOnce())]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 1, 'an answer at once must not re-show the dialog');
});

test('Dialog_ApproveOnce_Allows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 1);
});

test('Dialog_Decline_DeniesWithPlainReason', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('decline')]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'deny', reason: 'declined by user' });
});

test('Dialog_TypedText_DeclinesWithGuidance', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('use the staging server instead')]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'deny', reason: 'declined by user: use the staging server instead' });
    assert.equal(ui.shown.length, 1);
});

test('Dialog_TypedTextTrimmedAndClipped', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('  keep it\n\n  short  '), decision('x'.repeat(600))]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const trimmed = await dialog.ask(sampleRequest());
    const clipped = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(trimmed, { outcome: 'deny', reason: 'declined by user: keep it short' });
    assert.equal(clipped.outcome, 'deny');
    assert.equal(clipped.reason, `declined by user: ${'x'.repeat(500)}`);
});

test('Dialog_TypedWhitespace_ReShows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('   '), decision('\t\n '), decision(''), approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 4, 'blank text must show the dialog again');
});

test('Dialog_TypedOptionValue_ActsAsOption', async (t) => {
    // Arrange: an exact option value typed into "Other" behaves like choosing that option
    const cases = [
        ['approve_once', { outcome: 'allow' }],
        ['decline', { outcome: 'deny', reason: 'declined by user' }],
    ];
    for (const [typed, expected] of cases) {
        const clock = createFakeClock();
        const ui = scriptedUi(clock, [decision(typed)]);
        const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
        // Act
        const outcome = await dialog.ask(sampleRequest());
        // Assert
        assert.deepEqual(outcome, expected, `typed "${typed}"`);
    }
});

test('Dialog_TypedUppercaseOptionValue_DeclinesWithGuidance', async (t) => {
    // Arrange: matching of the option values is exact and case-sensitive
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision('APPROVE_ONCE')]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'deny', reason: 'declined by user: APPROVE_ONCE' });
    assert.equal(ui.shown.length, 1);
});

test('Dialog_TypedOptionValueWithLeadingSpace_DeclinesWithGuidance', async (t) => {
    // Arrange: a leading space is not the option value, so " approve_once" never approves
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [decision(' approve_once')]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'deny', reason: 'declined by user: approve_once' });
    assert.equal(ui.shown.length, 1);
});

test('Dialog_NotDecidedOnSecondAttempt_ReShows', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [cancelled(), decision('not_decided'), approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 3, 'the not_decided answer must not count');
});

test('Dialog_NoUiHost_ReturnsAskWithoutLoop', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui: {}, clock, reviewsDir, config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.equal(outcome.outcome, 'ask');
    assert.equal(typeof outcome.reason, 'string');
    assert.equal(existsSync(reviewsDir), false, 'no review file is written without a dialog');
});

test('Dialog_CapabilityOff_ReturnsAskWithoutShowing', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({
        ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, capabilities: { ui: { elicitation: false } },
    });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.equal(outcome.outcome, 'ask');
    assert.equal(ui.shown.length, 0);
});

/** Host capability objects as observed in the live probe (T11 follow-up): interactive session and headless `copilot -p`. */
const INTERACTIVE_HOST = Object.freeze({ ui: { elicitation: true, mcpApps: false, canvases: true }, extensions: false });
const PROMPT_MODE_HOST = Object.freeze({ ui: { elicitation: true, mcpApps: false, canvases: false }, extensions: false });

/** Resolves with the promise's value, or with 'hung' when it has not settled within ms (a hang fails the test instead of blocking the run). */
async function settleWithin(promise, ms) {
    let timer;
    const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), ms); });
    try {
        return await Promise.race([promise, hung]);
    } finally {
        clearTimeout(timer);
    }
}

test('Dialog_PromptModeHostReportsElicitationSupported_ReturnsAskWithoutShowing', async (t) => {
    // Arrange: headless -p reports elicitation as supported, but canvases is off and the host shows no UI
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({
        ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, capabilities: PROMPT_MODE_HOST,
    });
    // Act
    const outcome = await settleWithin(dialog.ask(sampleRequest()), 2000);
    // Assert
    assert.notEqual(outcome, 'hung', 'the governor must not wait on an elicitation that a prompt-mode host never answers');
    assert.equal(outcome.outcome, 'ask');
    assert.match(outcome.reason, /no interactive UI/);
    assert.equal(ui.shown.length, 0, 'no dialog is shown in prompt mode');
});

test('Dialog_InteractiveHost_ShowsDialogAndReadsAnswer', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({
        ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, capabilities: INTERACTIVE_HOST,
    });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(ui.shown.length, 1);
});

test('Dialog_HostNotKnownInteractive_WatchdogReturnsHookAskInsteadOfWaitingForever', async (t) => {
    // Arrange: no capability object at all, and an elicitation that never settles
    const clock = createFakeClock();
    const ui = { elicitation: () => new Promise(() => {}) };
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, watchdogMs: 20 });
    // Act
    const outcome = await settleWithin(dialog.ask(sampleRequest()), 2000);
    // Assert
    assert.notEqual(outcome, 'hung');
    assert.equal(outcome.outcome, 'hook-ask');
    assert.match(outcome.reason, /no answer/);
});

test('Dialog_KnownInteractiveHost_NoWatchdogEvenWhenAnswerIsSlow', async (t) => {
    // Arrange: an interactive host whose user takes longer than the watchdog limit
    const clock = createFakeClock();
    const ui = {
        elicitation: async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            clock.advance(SLOW_ANSWER_MS);
            return approveOnce().result;
        },
    };
    const dialog = createDialog({
        ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG, capabilities: INTERACTIVE_HOST, watchdogMs: 20,
    });
    // Act
    const outcome = await settleWithin(dialog.ask(sampleRequest()), 2000);
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
});

test('Dialog_AutopilotMode_ReturnsAskWithoutShowing', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest({ permissionMode: 'autopilot' }));
    // Assert
    assert.equal(outcome.outcome, 'ask');
    assert.equal(ui.shown.length, 0);
});

test('Dialog_ElicitationThrows_ReturnsHookAsk', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [new Error('host refused the dialog')]);
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.equal(outcome.outcome, 'hook-ask');
    assert.ok(outcome.reason.includes('host refused the dialog'), outcome.reason);
});

test('Dialog_NeverAnswered_StopsAfterMaxFiftyDisplays', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, Array.from({ length: 60 }, () => decision('not_decided')));
    const dialog = createDialog({ ui, clock, reviewsDir: tempReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.equal(outcome.outcome, 'hook-ask');
    assert.equal(ui.shown.length, 50, 'at most 50 displays per request, the first included');
});

test('Dialog_ReviewWriteFails_ReturnsHookAskWithReasonAndShowsNothing', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const dialog = createDialog({ ui, clock, reviewsDir: blockedReviewsDir(t), config: CONFIG });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.equal(outcome.outcome, 'hook-ask');
    assert.ok(
        outcome.reason.startsWith('approval dialog unavailable: review file not written ('),
        outcome.reason,
    );
    assert.equal(ui.shown.length, 0);
});

test('Dialog_SameTickSameScript_WritesTwoReviewFiles', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [instant(approveOnce()), instant(approveOnce())]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG });
    // Act
    const [first, second] = await Promise.all([
        dialog.ask(sampleRequest({ agentName: 'agent-A' })),
        dialog.ask(sampleRequest({ agentName: 'agent-B' })),
    ]);
    // Assert
    assert.deepEqual(first, { outcome: 'allow' });
    assert.deepEqual(second, { outcome: 'allow' });
    assert.equal(readdirSync(reviewsDir).length, 2);
    const pathA = reviewPathFrom(ui.shown[0].message);
    const pathB = reviewPathFrom(ui.shown[1].message);
    assert.notEqual(pathA, pathB);
    assert.ok(readFileSync(pathA, 'utf8').includes('Agent: agent-A'));
    assert.ok(readFileSync(pathB, 'utf8').includes('Agent: agent-B'));
});

test('Dialog_ReviewFile_HasFullScriptAndDetails', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG });
    const hash = createHash('sha256').update(SCRIPT_25, 'utf8').digest('hex');
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const [name] = readdirSync(reviewsDir);
    assert.match(name, /^2026-10-19T00-00-00-000Z-[0-9a-f]{12}\.txt$/);
    const review = readFileSync(join(reviewsDir, name), 'utf8');
    for (const needle of [
        'Line 1', 'Line 21', 'Line 25', 'DEL-01', 'deletes files recursively', 'destructive',
        'Deletes a build folder.', 'AI confidence: 0.90', 'C:\\code\\proj', 'Clean the build output',
        `Script SHA-256: ${hash}`,
    ]) {
        assert.ok(review.includes(needle), `review file lacks "${needle}"`);
    }
});

test('Dialog_ReviewLink_IsFileUrlWithEncodedSpaces', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const link = linkOf(ui.shown[0].message);
    assert.match(link, /^file:\/\/\/[A-Za-z]:\/.+%20.+\.txt$/);
    assert.ok(!link.includes('\\'), 'forward slashes only');
    assert.equal(fileURLToPath(link), join(reviewsDir, readdirSync(reviewsDir)[0]));
});

test('Dialog_FileUrl_DrivePathUsesForwardSlashesAndEncodedSpaces', () => {
    assert.equal(dialogModule.fileUrl('C:\\some dir\\reviews\\a.txt'), 'file:///C:/some%20dir/reviews/a.txt');
});

test('Dialog_FileUrl_UncPathBecomesFileHostUrl', () => {
    assert.equal(
        dialogModule.fileUrl('\\\\server\\share\\reviews\\a b.txt'),
        'file://server/share/reviews/a%20b.txt',
    );
});

test('Dialog_ReviewRetention_RemovesReviewFilesOlderThanFourteenDays', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    mkdirSync(reviewsDir, { recursive: true });
    const old = '2026-09-01T00-00-00-000Z-aaaaaaaaaaaa.txt';
    const recent = '2026-10-10T00-00-00-000Z-bbbbbbbbbbbb.txt';
    const unrelated = 'notes-2026-09-01.txt';
    for (const name of [old, recent, unrelated]) writeFileSync(join(reviewsDir, name), 'x');
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    const names = readdirSync(reviewsDir);
    assert.ok(!names.includes(old), 'file older than 14 days is removed');
    assert.ok(names.includes(recent), 'recent review file is kept');
    assert.ok(names.includes(unrelated), 'files that are not review files are never touched');
});

test('Dialog_ReviewRetention_HonoursConfiguredDays', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    mkdirSync(reviewsDir, { recursive: true });
    const old = '2026-09-01T00-00-00-000Z-aaaaaaaaaaaa.txt';
    writeFileSync(join(reviewsDir, old), 'x');
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG, reviewRetentionDays: 60 });
    // Act
    await dialog.ask(sampleRequest());
    // Assert
    assert.ok(readdirSync(reviewsDir).includes(old));
});

test('Dialog_ReviewRetention_ErrorsAreReportedAndIgnored', async (t) => {
    // Arrange
    const clock = createFakeClock();
    const ui = scriptedUi(clock, [approveOnce()]);
    const reviewsDir = tempReviewsDir(t);
    // A folder named like an expired review cannot be unlinked, so the prune fails.
    mkdirSync(join(reviewsDir, '2026-09-01T00-00-00-000Z-cccccccccccc.txt'), { recursive: true });
    const errors = [];
    const dialog = createDialog({ ui, clock, reviewsDir, config: CONFIG, onError: (err) => errors.push(err) });
    // Act
    const outcome = await dialog.ask(sampleRequest());
    // Assert
    assert.deepEqual(outcome, { outcome: 'allow' });
    assert.equal(errors.length, 1);
});
