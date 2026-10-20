const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The picture on the student's screen follows TutorResponse.item. When the
// model moves on but still reports the previous item, the cue it actually
// spoke decides (core/ai/itemGuard.ts) — seen in a real 6A run: "Perfect!
// … Joel – hug Mirna." with item = task-2-item-2 (the drama group).

const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/core/ai/itemGuard.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', source)(require, mod, mod.exports);
const { itemAskedInSpeech } = mod.exports;

const sixA = [
  { id: 'task-1-item-1', prompt: 'Do you like to take pictures?' },
  { id: 'task-2-item-1', prompt: 'The celebration group – dance' },
  { id: 'task-2-item-2', prompt: 'The drama group – act out a play' },
  { id: 'task-2-item-3', prompt: 'Joel – hug Mirna' },
];

assert.equal(
  itemAskedInSpeech('Perfect! Now let\'s move on to the next picture. Look at the picture. What are they doing? Joel – hug Mirna.', 'task-2-item-2', sixA),
  'task-2-item-3',
  'the cue spoken last wins over a stale id'
);
assert.equal(
  itemAskedInSpeech('Good try! The correct way is: The drama group is acting out a play. Now you try.', 'task-2-item-2', sixA),
  'task-2-item-2',
  'a correction (no cue spoken) keeps the reported item'
);
assert.equal(
  itemAskedInSpeech('Great! Do you like to take pictures?', undefined, sixA),
  'task-1-item-1',
  'a missing id is filled from the spoken cue'
);
assert.equal(itemAskedInSpeech('How are you today?', undefined, sixA), undefined, 'no cue, no id');

// Same cue for every item (9A): the reported one stands.
const weather = [1, 2, 3].map((m) => ({ id: `task-1-item-${m}`, prompt: 'What’s the weather like?' }));
assert.equal(itemAskedInSpeech("Look at this picture. What's the weather like?", 'task-1-item-3', weather), 'task-1-item-3');

// Short cues ("Ear") are ignored — too likely to appear by chance.
assert.equal(itemAskedInSpeech('Can you hear me? Say ear.', 'task-2-item-4', [{ id: 'task-2-item-1', prompt: 'Ear' }]), 'task-2-item-4');

// The tutor answering her own picture question — real 6A turns.
const { stripLeakedAnswer } = mod.exports;
const joel = { prompt: 'Joel – hug Mirna', expectedAnswer: 'Joel is hugging Mirna.' };
const drama = { prompt: 'The drama group – act out a play', expectedAnswer: 'The drama group is acting out a play.' };
const children = { prompt: 'The children – sing and dance', expectedAnswer: 'The children are singing and dancing.' };
assert.deepEqual(
  stripLeakedAnswer('Great job! The drama group is acting out a play. Now look at the picture. What is Joel doing? He is hugging Mirna.', joel, false),
  { speech: 'Great job! The drama group is acting out a play. Now look at the picture. What is Joel doing?', leaked: 'He is hugging Mirna.' },
  'the answer after the question is cut; praise for the previous item stays'
);
assert.equal(
  stripLeakedAnswer('Exactly right! Now look at the picture. What is the drama group doing? They are acting out a play.', drama, false).speech,
  'Exactly right! Now look at the picture. What is the drama group doing?'
);
assert.equal(
  stripLeakedAnswer('Look at the picture. What are they doing? The children – sing and dance. They are singing and dancing.', children, false).speech,
  'Look at the picture. What are they doing? The children – sing and dance.',
  'the cue after the question stays'
);
const cueOnly = 'Look at the picture. What are they doing? The drama group – act out a play.';
assert.deepEqual(stripLeakedAnswer(cueOnly, drama, false), { speech: cueOnly }, 'the cue alone is not a leak');
const correction = 'Good try! The correct way is: Joel is hugging Mirna. Now you try: Joel is hugging Mirna.';
assert.deepEqual(stripLeakedAnswer(correction, joel, true), { speech: correction }, 'a correction may say the answer');
assert.deepEqual(stripLeakedAnswer('What is Joel doing?', { prompt: 'x', expectedAnswer: null }, false), { speech: 'What is Joel doing?' });
assert.equal(
  stripLeakedAnswer("Look at this picture. What's the weather like? It's cold.", { prompt: 'What’s the weather like?', expectedAnswer: 'It’s cold.' }, false).speech,
  "Look at this picture. What's the weather like?"
);

console.log('item guard: the spoken cue decides which picture is on screen; a self-answered picture question is cut after the question');
