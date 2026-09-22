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
const response = { speech: { english: 'Hello!', portuguese: '' } };

async function check({ chatFails = false, prefetched = false }) {
  const statuses = [];
  const errors = [];
  let entries = [];
  let sendCount = 0;
  const sttListeners = {};
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => {
      sendCount++;
      if (chatFails) throw new Error('Chat unavailable');
      return response;
    } },
    speech: {
      on: () => () => {}, // "start" never fires — simulates a TTS call that fails immediately
      speak: async () => { throw new Error('Audio unavailable'); },
      cancel: () => {}, // required by SpeechProvider (no optional chaining at call sites) — reset() calls this unconditionally
    },
    stt: {
      on: (event, cb) => { sttListeners[event] = cb; return () => {}; },
      start: async () => {},
      stop: async () => '',
    },
    avatar: { setState() {} },
  });
  orchestrator.onApiStatus((status) => statuses.push(status));
  orchestrator.onError((error) => errors.push(error));
  orchestrator.onEntriesChange((value) => { entries = value; });
  await orchestrator.runTurn(prefetched ? { prefetchedResponse: response } : {});
  assert.deepEqual(statuses, chatFails ? [false] : [true]);
  assert.deepEqual(errors, [chatFails ? 'Chat unavailable' : 'Audio unavailable']);
  assert.equal(orchestrator.isBusy(), false);
  assert.equal(entries.some((entry) => entry.pending), false);
  if (!chatFails) {
    // Regression check: a TTS failure with "start" never firing used to
    // leave the character state wedged on "thinking" (SPEECH_END has no
    // defined transition from there — see PERSISTENT_TRANSITIONS), which
    // silently broke every future turn: the STT "final" handler refuses to
    // process a transcript unless the state machine is genuinely
    // "listening", and startListening() can never reach "listening" from
    // a stuck "thinking". Proving the FULL next-turn path still works
    // (not just checking the state label) is what actually catches that
    // class of bug, since a stale/incomplete state check could pass while
    // the STT handler is still silently dropping everything.
    assert.notEqual(orchestrator.getState(), 'thinking', 'must not be wedged on "thinking" after a swallowed TTS failure');
    const startedListening = await orchestrator.startListening();
    assert.equal(startedListening, true, 'startListening() must not be blocked by busy after a swallowed TTS failure');
    sendCount = 0;
    sttListeners.final({ transcript: 'Hi Debbie', detectedLanguage: 'en' });
    // handleUserMessage's ai.send() call is async but not awaited by the
    // "final" handler itself — give its microtask/promise chain a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sendCount, 1, 'a real student answer after a swallowed TTS failure must still reach /api/chat, not be silently dropped');

    await orchestrator.runTurn(prefetched ? { prefetchedResponse: response } : {});
    assert.equal(errors.length, 3, 'A repeated reply to a student must still be spoken');
  }
  orchestrator.updateCorrectionAttemptTracking({ correction: { corrected: 'LISTENING' } });
  orchestrator.updateCorrectionAttemptTracking({ correction: { corrected: 'Listening.' } });
  assert.equal(orchestrator.correctionAttemptCount, 2, 'Punctuation must not reset attempts');

  // Load-bearing, not just tidy-up: landing on "idle" (this file's whole
  // point) starts the real idle-nudge clock (setInterval, real wall-clock
  // timers — see orchestrator.startIdleClock). A real page.tsx eventually
  // tears this down (component unmount / orchestrator.reset()); a
  // standalone script never does on its own, so without this the process
  // is kept alive by that interval and nudges keep firing forever (6s,
  // 14s, 25s, 40s, then the cycle repeats) — reset() is what stops it.
  orchestrator.reset();
}

(async () => {
  await check({});
  await check({ prefetched: true });
  await check({ chatFails: true });
  console.log('PASS: live/prefetched audio failures preserve chat status; chat failures mark offline.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
