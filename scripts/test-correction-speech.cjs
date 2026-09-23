const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));

async function testCorrectionSpeaksOnlyEnglishNormalized() {
  const spoken = []; // {text, lang}
  let entries = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async () => ({
        speech: {
          english: 'Good try! The correct way is: LISTENING.',
          portuguese: "Em português dizemos 'escutando'...",
        },
        correction: {
          studentSaid: 'listning',
          corrected: 'LISTENING',
          explanation: "Em português dizemos 'escutando'...",
        },
        praise: false,
      }),
    },
    speech: {
      on: () => () => {},
      speak: async (text, opts) => { spoken.push({ text, lang: opts.lang }); },
      speakSlow: async (text, opts) => { spoken.push({ text, lang: opts.lang, slow: true }); },
      cancel: () => {},
    },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });
  orchestrator.onEntriesChange((value) => { entries = value; });

  await orchestrator.runTurn({});

  // Only the English part (normalized, no ALL-CAPS) must ever reach speak().
  assert.deepEqual(
    spoken.map((s) => ({ text: s.text, lang: s.lang })),
    [
      { text: 'Good try! The correct way is: Listening.', lang: 'en-US' },
      // The pronunciation drill's slow re-say of the target word.
      { text: 'Listening', lang: 'en-US' },
      { text: 'Now you try.', lang: 'en-US' },
    ],
    'Portuguese must never be spoken for a correction, and ALL-CAPS words must be normalized before TTS'
  );
  assert.equal(spoken.some((s) => s.lang === 'pt-BR'), false, 'no pt-BR speak() call for a correction turn');
  assert.equal(spoken.some((s) => /[A-Z]{2,}/.test(s.text)), false, 'no ALL-CAPS word ever reaches speak()');

  // The Portuguese explanation must still be fully VISIBLE in the entry,
  // even though it was never spoken — see speakPartsWithReveal's final
  // safety-net replaceEntry, which shows the whole response regardless of
  // which parts were actually sent to speak().
  const tutorEntry = entries.find((e) => e.role === 'tutor');
  assert.ok(tutorEntry, 'a tutor entry must exist');
  assert.equal(tutorEntry.response.speech.portuguese, "Em português dizemos 'escutando'...");
  assert.equal(tutorEntry.response.speech.english, 'Good try! The correct way is: LISTENING.', 'the ORIGINAL casing is preserved for display');
  assert.equal(tutorEntry.pending, undefined, 'must not be left showing the typing indicator');

  orchestrator.reset();
}

async function testNormalTurnSpeaksOnlyEnglish() {
  const spoken = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => ({ speech: { english: 'Where are you from?', portuguese: 'De onde você é?' } }) },
    speech: {
      on: () => () => {},
      speak: async (text, opts) => { spoken.push({ text, lang: opts.lang }); },
      cancel: () => {},
    },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });

  await orchestrator.runTurn({});

  assert.deepEqual(spoken, [
    { text: 'Where are you from?', lang: 'en-US' },
  ], 'school rule: Portuguese is written, never spoken — on non-correction turns too');

  orchestrator.reset();
}

(async () => {
  await testCorrectionSpeaksOnlyEnglishNormalized();
  await testNormalTurnSpeaksOnlyEnglish();
  console.log('PASS: correction turns speak only normalized English; no turn ever speaks Portuguese');
})().catch((error) => { console.error(error); process.exitCode = 1; });
