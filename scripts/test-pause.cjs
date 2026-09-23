const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Pause button: a way out of any loop. Pausing stops the tutor (fade),
// drops queued speech, closes the mic, and allows NO turn/nudge until
// resumed; resuming repeats the current instruction once (same task, via
// the "resume" nudge) and rearms nudges from zero. Progress is untouched.

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
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const sends = [];
  const spoken = [];
  const cancels = [];
  const sttCalls = { start: 0, abort: 0 };
  const listeners = { start: new Set(), end: new Set(), error: new Set() };
  let pending = null;
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async (_m, opts) => {
        sends.push(opts?.nudge ?? 'turn');
        return { speech: { english: 'Repeat after me: READING.', portuguese: 'Repita: leitura.' } };
      },
    },
    speech: {
      on: (e, cb) => { listeners[e].add(cb); return () => listeners[e].delete(cb); },
      // Plays until cancelled, so pause() lands mid-sentence.
      speak: (text) => new Promise((resolve) => {
        spoken.push(text);
        pending = resolve;
        for (const cb of listeners.start) cb();
        setTimeout(() => { if (pending === resolve) { pending = null; resolve(); } }, 50);
      }),
      cancel: (fade) => { cancels.push(fade ?? 0); const p = pending; pending = null; p?.(); },
      isSpeaking: () => pending !== null,
    },
    stt: {
      on: () => () => {},
      start: async () => { sttCalls.start++; },
      stop: async () => '',
      abort: () => { sttCalls.abort++; },
    },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  const paused = [];
  orchestrator.onPausedChange((p) => paused.push(p));
  return { orchestrator, sends, spoken, cancels, sttCalls, paused };
}

async function pauseMidSpeechAndResume() {
  const { orchestrator, sends, spoken, cancels, paused } = setup();
  orchestrator.lessonGoals = ['task-1'];
  orchestrator.dispatchState({ type: 'STOP_LISTENING' });
  const turn = orchestrator.runTurn({});
  await tick(10);
  assert.equal(orchestrator.getState(), 'speaking');

  orchestrator.pause();
  await turn;
  assert.ok(cancels.includes(120), 'speech must fade out');
  assert.equal(orchestrator.isPaused(), true);
  assert.equal(orchestrator.isBusy(), false);
  assert.equal(orchestrator.getState(), 'idle', 'avatar idle while paused');
  assert.deepEqual(paused, [true]);
  const entriesBefore = orchestrator.entries.length;

  // No nudge may fire while paused, however long it lasts.
  orchestrator.idleAccumulatedMs = 5900;
  await tick(1200);
  await orchestrator.runTurn({}); // any stray trigger
  assert.deepEqual(sends, ['turn'], 'no turn/nudge while paused');

  await orchestrator.resume({ repeatInstruction: true });
  assert.deepEqual(sends, ['turn', 'resume'], 'resume repeats the current instruction via the "resume" nudge');
  assert.equal(spoken.at(-1), 'Repeat after me: Reading.');
  assert.equal(orchestrator.idleAccumulatedMs, 0, 'nudge escalation starts over');
  assert.ok(orchestrator.entries.length > entriesBefore, 'progress kept, instruction added');
  assert.deepEqual(paused, [true, false]);
  orchestrator.reset();
}

async function pauseClosesMicAndFalarResumesQuietly() {
  const { orchestrator, sends, sttCalls } = setup();
  await orchestrator.startListening();
  assert.equal(orchestrator.getState(), 'listening');
  orchestrator.pause();
  assert.equal(sttCalls.abort, 1, 'mic closed on pause');
  assert.equal(orchestrator.getState(), 'idle');

  // Falar while paused: leave the pause without repeating, open the mic.
  await orchestrator.startListening();
  assert.equal(orchestrator.isPaused(), false);
  assert.equal(orchestrator.getState(), 'listening');
  assert.equal(sttCalls.start, 2);
  assert.deepEqual(sends, [], 'no repeated instruction — the student is answering');
  orchestrator.reset();
}

(async () => {
  await pauseMidSpeechAndResume();
  await pauseClosesMicAndFalarResumesQuietly();
  quiet.log('PASS: pause stops speech/mic/nudges and keeps progress; resume repeats the instruction once; Falar while paused resumes quietly');
  process.exit(0);
})().catch((error) => { quiet.error(error); process.exit(1); });
