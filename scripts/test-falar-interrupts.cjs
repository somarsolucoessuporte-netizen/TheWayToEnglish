const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Regression for "durante a correção o botão Falar fica travado": the Falar
// button must never be refused. Pressing it while the tutor is speaking has
// to stop her (with a fade), drop whatever she still had queued (the rest
// of the correction, the drill), release `busy`, and open the mic — and the
// interrupted turn must not later knock the state machine out of
// "listening". Also: the "error" state must drop back to idle on its own.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => name.startsWith('.')
    ? loadTs(path.resolve(path.dirname(filename), `${name}.ts`))
    : name.startsWith('@/')
      ? loadTs(path.resolve(__dirname, '../src', `${name.slice(2)}.ts`))
      : require(name);
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const quiet = { ...console };
console.log = () => {};
console.warn = () => {};

function makeSpeech() {
  const listeners = { start: new Set(), end: new Set(), error: new Set() };
  const spoken = [];
  const cancels = [];
  let pending = null;
  return {
    spoken,
    cancels,
    on: (event, cb) => { listeners[event].add(cb); return () => listeners[event].delete(cb); },
    cancel: (fadeMs) => { cancels.push(fadeMs ?? 0); const p = pending; pending = null; p?.(); },
    // Each line "plays" until cancelled — the tutor is mid-sentence when
    // the student presses Falar.
    speak: (text) => new Promise((resolve) => {
      spoken.push(text);
      pending = resolve;
      for (const cb of listeners.start) cb();
    }),
    speakSlow(text) { return this.speak(text); },
    isSpeaking: () => false,
  };
}

async function falarInterruptsCorrection() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const speech = makeSpeech();
  let sttStarts = 0;
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async () => ({
        speech: { english: 'Great try! The correct way is: A. Now you try: A.', portuguese: 'Quase!' },
        correction: { original: 'ei', corrected: 'A', explanation: '' },
      }),
    },
    speech,
    stt: { on: () => () => {}, start: async () => { sttStarts++; }, stop: async () => '' },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });

  const turn = orchestrator.sendTextMessage('ei'); // idle -> thinking -> speaking, like a real answer
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(orchestrator.getState(), 'speaking', 'precondition: tutor is mid-correction');
  assert.equal(orchestrator.isBusy(), true);

  const accepted = await orchestrator.startListening();
  assert.equal(accepted, true, 'Falar must never be refused while the tutor is speaking');
  assert.equal(sttStarts, 1, 'the mic must open');
  assert.equal(orchestrator.getState(), 'listening');
  assert.equal(orchestrator.isBusy(), false, 'busy must be released by the interruption');
  assert.ok(speech.cancels.includes(120), 'speech must be stopped with the 120ms fade');

  await turn;
  await new Promise((r) => setTimeout(r, 700)); // past the drill's 600ms pause, if it wrongly ran
  assert.equal(orchestrator.getState(), 'listening', 'the interrupted turn must not reset the state out from under the mic');
  assert.deepEqual(speech.spoken, ['Great try! The correct way is: A. Now you try: A.'],
    'nothing after the interruption (drill, "Now you try.") may still be spoken');
}

async function errorStateRecovers() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => { throw new Error('Chat HTTP 500'); } },
    speech: makeSpeech(),
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  await orchestrator.runTurn({});
  assert.equal(orchestrator.getState(), 'error');
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(orchestrator.getState(), 'idle', 'error must drop back to idle within 3s');
  orchestrator.reset();
}

(async () => {
  await falarInterruptsCorrection();
  await errorStateRecovers();
  quiet.log('PASS: Falar interrupts the tutor mid-correction (fade, queue dropped, mic open, busy free); error auto-recovers to idle in 3s');
  process.exit(0);
})().catch((error) => { quiet.error(error); process.exit(1); });
