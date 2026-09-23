const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Regression for the real cause of "texto aparece, voz não sai" on praise
// turns (Lição A, turno 3 — a nudge with praise:true):
//   [turn] response processing failed: TypeError: Illegal invocation
//     at enterTransient / dispatch / enterPraiseBeforeSpeaking / runTurn / fireNudge
// CharacterStateMachine stored the bare global setTimeout and called it as
// `this.setTimeoutFn(...)` — the browser's native setTimeout throws unless
// `this` is the window. Node's doesn't care, so every script passed. The
// timers below behave like the browser's: a foreign `this` throws.
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
function strict(real) {
  return function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return real(...args);
  };
}
global.setTimeout = strict(realSetTimeout);
global.clearTimeout = strict(realClearTimeout);

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
const errors = [];
console.error = (...a) => errors.push(a.map(String).join(' '));

async function stateMachineTransientsWork() {
  const { CharacterStateMachine } = loadTs(path.resolve(__dirname, '../src/core/character-state-machine/stateMachine.ts'));
  const sm = new CharacterStateMachine({ transientDurationMs: 20 });
  sm.dispatch({ type: 'STOP_LISTENING' }); // idle -> thinking
  sm.dispatch({ type: 'PRAISE' }); // threw "Illegal invocation" before the fix
  assert.equal(sm.getState(), 'praise');
  await new Promise((r) => realSetTimeout(r, 40));
  assert.equal(sm.getState(), 'thinking', 'praise must revert to the persistent state on its own');
  sm.dispatch({ type: 'CORRECTION' });
  sm.dispatch({ type: 'RESET' }); // clearTimeout path
  assert.equal(sm.getState(), 'idle');
}

async function nudgeWithPraiseSpeaks() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const spoken = [];
  const states = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async () => ({
        speech: { english: "Perfect! Now let's continue. Repeat after me: READING.", portuguese: '' },
        praise: true,
      }),
    },
    speech: {
      on: () => () => {},
      speak: async (text) => { spoken.push(text); },
      cancel: () => {},
    },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });
  orchestrator.onStateChange((s) => states.push(s));

  await orchestrator.fireNudge('gentle'); // same path as the production stack trace

  // normalizeForSpeech (f7ae36f) turns the ALL-CAPS word into "Reading" for the TTS.
  assert.deepEqual(spoken, ["Perfect! Now let's continue. Repeat after me: Reading."], 'the praise turn must reach the TTS');
  assert.ok(states.includes('praise'), 'the praise pose must actually play');
  assert.equal(states.includes('error'), false, `must never enter "error" (states: ${states.join(' -> ')})`);
  assert.equal(orchestrator.isBusy(), false);
  assert.deepEqual(errors.filter((e) => /Illegal invocation|response processing failed/.test(e)), []);
  orchestrator.reset();
}

(async () => {
  await stateMachineTransientsWork();
  await nudgeWithPraiseSpeaks();
  quiet.log('PASS: praise/correction transients work with browser-strict timers; a praise nudge turn is spoken, never "error"');
  process.exit(0);
})().catch((error) => { quiet.error(error); quiet.error(errors.join('\n')); process.exit(1); });
