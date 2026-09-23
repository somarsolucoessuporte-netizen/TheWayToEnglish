const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Bug 3: the tutor SPOKE Portuguese on a correction turn —
//   "Em português, dizemos 'A', mas em inglês é apenas a letra A."
//   "Em português, não usamos a letra A dessa forma. Vamos tentar de novo."
// The model put the explanation inside speech.english (the field read
// aloud); f7ae36f only kept speech.portuguese silent. School rule:
// Portuguese is written, never spoken. Checks the sentence-level detector
// and that the orchestrator never sends Portuguese (either field) to TTS.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => name.startsWith('.')
    ? loadTs(path.resolve(path.dirname(filename), `${name}.ts`))
    : require(name);
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const quiet = { ...console };
console.log = () => {};
console.warn = () => {};

const { splitOutPortuguese, isPortugueseSentence } = loadTs(path.resolve(__dirname, '../src/core/speech/portugueseGuard.ts'));
const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));

function detector() {
  // The exact lines from the report.
  for (const pt of [
    "Em português, dizemos 'A', mas em inglês é apenas a letra A.",
    'Em português, não usamos a letra A dessa forma.',
    'Vamos tentar de novo.',
    'Muito bem!',
    'Ótimo!',
  ]) assert.equal(isPortugueseSentence(pt), true, `must be flagged as Portuguese: ${pt}`);

  // Lesson B lines and other English that must stay spoken.
  for (const en of [
    'Hi! How are you doing today?',
    'Great try! The correct way is: A. Now you try: A.',
    "Perfect! Now let's continue. Repeat after me: B.",
    'Exactly right! Now repeat after me: D.',
    'Nice to meet you, José.',
    'Good try! The correct way is: I AM 25 years old.',
    "Today we're practicing Book 1, Lesson B — The Alphabet.",
  ]) {
    const { english, portuguese } = splitOutPortuguese(en);
    assert.deepEqual(portuguese, [], `must NOT be flagged: ${en}`);
    assert.equal(english, en, 'clean English must come back byte-identical');
  }

  const mixed = "Great try! Em português, não usamos a letra A dessa forma. Vamos tentar de novo. Repeat after me: A.";
  assert.deepEqual(splitOutPortuguese(mixed), {
    english: 'Great try! Repeat after me: A.',
    portuguese: ['Em português, não usamos a letra A dessa forma.', 'Vamos tentar de novo.'],
  });

  const allPt = "Em português dizemos 'A', mas em inglês é apenas a letra A.";
  assert.equal(splitOutPortuguese(allPt).english, '', 'nothing English left -> empty (server regenerates)');
}

async function orchestratorNeverSpeaksPortuguese() {
  const spoken = [];
  const replies = [
    // Model violated the schema: Portuguese inside speech.english.
    {
      speech: {
        english: "Great try! Em português, dizemos 'A', mas em inglês é apenas a letra A. Now you try: A.",
        portuguese: '',
      },
    },
    // Normal turn with a Portuguese helper — shown, never spoken.
    { speech: { english: 'Where are you from?', portuguese: 'De onde você é?' } },
  ];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => replies.shift() },
    speech: {
      on: () => () => {},
      speak: async (text, opts) => { spoken.push({ text, lang: opts.lang }); },
      cancel: () => {},
    },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });

  await orchestrator.runTurn({});
  await orchestrator.runTurn({});

  assert.deepEqual(spoken, [
    { text: 'Great try! Now you try: A.', lang: 'en-US' },
    { text: 'Where are you from?', lang: 'en-US' },
  ]);
  assert.equal(spoken.some((s) => s.lang === 'pt-BR'), false, 'no pt-BR speak() call, on any turn');
  orchestrator.reset();
}

(async () => {
  detector();
  await orchestratorNeverSpeaksPortuguese();
  quiet.log('PASS: Portuguese in speech.english is detected and never spoken; speech.portuguese is never spoken on any turn');
})().catch((error) => { quiet.error(error); process.exitCode = 1; });
