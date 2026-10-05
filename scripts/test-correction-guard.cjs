const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// A correct answer (praise: true, no correction) never also says "The correct
// way is: …" — see src/core/ai/correctionGuard.ts. A real correction is
// never touched.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

const { removeCorrectionFromPraise } = loadTs(path.resolve(__dirname, '../src/core/ai/correctionGuard.ts'));
const turn = (english, extra = {}) => ({ speech: { english, portuguese: '' }, ...extra });

// The production case (lesson A, student said "Speaking").
let r = removeCorrectionFromPraise(turn("Great job! The correct way is: SPEAKING. Now let's try the next symbol. Repeat after me: LISTENING.", { praise: true }));
assert.equal(r.removed, true);
assert.equal(r.response.speech.english, "Great job! Now let's try the next symbol. Repeat after me: LISTENING.");

// Variants, and the Portuguese counterpart.
r = removeCorrectionFromPraise({ speech: { english: 'Perfect! The correct form is "I am". Next: how old are you?', portuguese: 'Muito bem! A forma correta é: I am. Próxima pergunta.' }, praise: true });
assert.equal(r.response.speech.english, 'Perfect! Next: how old are you?');
assert.equal(r.response.speech.portuguese, 'Muito bem! Próxima pergunta.');

// A clean praise turn is returned as is.
const clean = turn('Great job! Repeat after me: LISTENING.', { praise: true });
r = removeCorrectionFromPraise(clean);
assert.equal(r.removed, false);
assert.equal(r.response, clean);

// A real correction is never touched — even a capitalization-only one
// (the student may have said the wrong word: "Listening" for SPEAKING).
const correction = turn('Good try! The correct way is: LISTENING. Repeat after me: LISTENING.', {
  praise: false,
  correction: { studentSaid: 'Listening', corrected: 'LISTENING', explanation: '...' },
});
r = removeCorrectionFromPraise(correction);
assert.equal(r.removed, false);
assert.equal(r.response.speech.english, correction.speech.english);

// Not marked as correct (praise missing/false, no correction): left alone.
assert.equal(removeCorrectionFromPraise(turn('The correct way is: A. Now you try: A.')).removed, false);
assert.equal(removeCorrectionFromPraise(turn('The correct way is: A.', { praise: false })).removed, false);

// Never empties the spoken line.
r = removeCorrectionFromPraise(turn('The correct way is: SPEAKING.', { praise: true }));
assert.equal(r.removed, false);
assert.equal(r.response.speech.english, 'The correct way is: SPEAKING.');

console.log('correction guard: praise turns never say "The correct way is"; real corrections untouched');
