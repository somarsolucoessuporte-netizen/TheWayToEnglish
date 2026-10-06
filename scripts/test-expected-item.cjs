const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// In a repeat drill the expected answer is what the tutor asked for, and a
// correction must point at it — never at the (wrong) word the student said.
// See src/core/ai/expectedItem.ts.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

const { askedItem, expectedAnswerFor, pointCorrectionAtExpected } = loadTs(path.resolve(__dirname, '../src/core/ai/expectedItem.ts'));

// Reading the item back from the tutor's line.
assert.equal(askedItem("Let's start with the first symbol. Repeat after me: SPEAKING."), 'SPEAKING');
assert.equal(askedItem('Good try! The correct way is: A. Now you try: A.'), 'A');
assert.equal(askedItem('Repeat after me: "I am 25 years old".'), 'I am 25 years old');
assert.equal(askedItem('Repeat after me: A. Great! Now repeat after me: B!'), 'B', 'the LAST item asked for wins');
assert.equal(askedItem('Where are you from?'), undefined);

const tutor = (content) => ({ role: 'assistant', content });
const student = (content) => ({ role: 'user', content });
assert.equal(expectedAnswerFor([student('(start)'), tutor('Repeat after me: SPEAKING.'), student('LISTENING')]), 'SPEAKING');
assert.equal(expectedAnswerFor([student('(start)'), tutor('Repeat after me: SPEAKING.')]), undefined, 'no student reply yet');

// The production bug: asked SPEAKING, student said LISTENING, the model "corrected" to LISTENING.
const wrong = {
  speech: { english: 'Good try! The correct way is: LISTENING. Repeat after me: LISTENING.', portuguese: '' },
  praise: false,
  correction: { studentSaid: 'Listening', corrected: 'LISTENING', explanation: '...' },
};
let r = pointCorrectionAtExpected(wrong, 'SPEAKING');
assert.equal(r.fixed, true);
assert.equal(r.response.correction.corrected, 'SPEAKING');
assert.equal(r.response.correction.studentSaid, 'Listening', 'what the student said is kept as is');
assert.equal(r.response.speech.english, 'Good try! The correct way is: SPEAKING. Repeat after me: SPEAKING.');

// A correction that already targets the asked item is untouched.
const right = { ...wrong, speech: { english: 'Good try! The correct way is: SPEAKING. Repeat after me: SPEAKING.', portuguese: '' }, correction: { studentSaid: 'Listening', corrected: 'SPEAKING', explanation: '...' } };
assert.equal(pointCorrectionAtExpected(right, 'SPEAKING').fixed, false);

// A different, legitimate correction (not just echoing the student) is untouched.
const other = { ...wrong, correction: { studentSaid: 'I have 25 years', corrected: 'I am 25 years old', explanation: '...' } };
assert.equal(pointCorrectionAtExpected(other, 'I am 25 years old.').fixed, false);
assert.equal(pointCorrectionAtExpected(other, 'SPEAKING').fixed, false);

// Nothing expected, or no correction: untouched.
assert.equal(pointCorrectionAtExpected(wrong, undefined).fixed, false);
assert.equal(pointCorrectionAtExpected({ speech: { english: 'Great job!', portuguese: '' }, praise: true }, 'SPEAKING').fixed, false);

// A "correction" of exactly the expected item (case aside) is spotted.
const { correctsAnExpectedAnswer } = loadTs(path.resolve(__dirname, '../src/core/ai/expectedItem.ts'));
const falseError = { speech: { english: 'Good try! The correct way is: LISTENING. Now you try: LISTENING.', portuguese: '' }, praise: false, correction: { studentSaid: 'Listening', corrected: 'LISTENING', explanation: '' } };
assert.equal(correctsAnExpectedAnswer(falseError, 'LISTENING'), true);
assert.equal(correctsAnExpectedAnswer({ ...falseError, correction: { ...falseError.correction, studentSaid: 'bible search.' } }, 'BIBLE SEARCH'), true);
assert.equal(correctsAnExpectedAnswer(wrong, 'SPEAKING'), false, 'a wrong word is a real error');
assert.equal(correctsAnExpectedAnswer({ speech: { english: 'Great job!', portuguese: '' }, praise: true }, 'LISTENING'), false);

// Praise for a different word is spotted; for the right one (any case,
// punctuation, extra words) it is not. Sentences are not text-checked.
const { praisesAWrongAnswer } = loadTs(path.resolve(__dirname, '../src/core/ai/expectedItem.ts'));
const praise = { speech: { english: 'Great job! Now repeat after me: SPEAKING.', portuguese: '' }, praise: true };
assert.equal(praisesAWrongAnswer(praise, 'LISTENING', 'Speaking'), true);
assert.equal(praisesAWrongAnswer(praise, 'LISTENING', 'listening!'), false);
assert.equal(praisesAWrongAnswer(praise, 'LISTENING', 'Listening, please'), false);
assert.equal(praisesAWrongAnswer(praise, 'BIBLE SEARCH', 'Bible search.'), false);
assert.equal(praisesAWrongAnswer(praise, 'A', 'B'), true);
assert.equal(praisesAWrongAnswer(praise, 'I am 25 years old', "I'm 25 years old"), false, 'sentences are left to the model');
assert.equal(praisesAWrongAnswer(praise, undefined, 'Speaking'), false);
assert.equal(praisesAWrongAnswer(falseError, 'LISTENING', 'Speaking'), false, 'only praise turns');

console.log('expected item: corrections point at what was asked for; correct answers are not "corrected"; wrong ones are not praised');
