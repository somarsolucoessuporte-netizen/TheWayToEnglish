const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Regression + hardening for the single shared <audio> element (7601230,
// reverting cd4e323's `new Audio()` per call, which silenced every turn
// after the first on iOS).
//
// The fake element below models the two browser rules that matter here,
// so the checks are about real behavior, not just "the promise resolved"
// (resolving with no audio was a1f77b5's bug):
//   - HTML spec: assigning .src (and, in most engines, pause()) while a
//     play() is still pending rejects that play() with AbortError.
//   - iOS policy: an element may only play with sound if it has played
//     once inside a user gesture; afterwards it may play freely, any src.
// A clip counts as HEARD only if "playing" fired while the element was
// unpaused, at volume > 0, on that clip's own src — and it then ended on
// its own (nothing paused it mid-clip).
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/speech/OpenAITTSProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeEnv({ pauseRejectsPending = true, silentPlayDelayMs = 0, injectAbortOnFirstRealPlay = false, fetchImpl } = {}) {
  const env = {
    inGesture: false,
    abortErrors: [], // { src, reason } for every pending play() the element aborted
    heard: [], // srcs that genuinely played to the end
    realPlayCalls: 0,
    elements: [],
  };
  let injected = false;
  class FakeAudioElement {
    constructor() {
      env.elements.push(this);
      this.paused = true;
      this.volume = 1;
      this.blessed = false;
      this._src = '';
      this.pending = [];
    }
    set src(v) {
      this.abortPending('src');
      this.paused = true;
      this._src = v;
    }
    get src() { return this._src; }
    abortPending(reason) {
      for (const p of this.pending.splice(0)) {
        env.abortErrors.push({ src: p.src, reason });
        const err = new Error('The play() request was interrupted');
        err.name = 'AbortError';
        p.reject(err);
      }
    }
    play() {
      const src = this._src;
      const isReal = src.startsWith('blob:');
      if (isReal) env.realPlayCalls++;
      if (!this.blessed && !env.inGesture) {
        const err = new Error('play() not allowed without a user gesture');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      if (env.inGesture) this.blessed = true;
      if (isReal && injectAbortOnFirstRealPlay && !injected) {
        injected = true;
        env.abortErrors.push({ src, reason: 'injected' });
        const err = new Error('The play() request was interrupted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      this.paused = false;
      return new Promise((resolve, reject) => {
        const entry = { src, resolve, reject };
        this.pending.push(entry);
        setTimeout(() => {
          const i = this.pending.indexOf(entry);
          if (i === -1) return; // aborted meanwhile
          this.pending.splice(i, 1);
          resolve();
          if (this.paused || this._src !== src) return;
          this.onplaying?.();
          const heardSrc = src;
          setTimeout(() => {
            if (this.paused || this._src !== heardSrc) return; // cut off mid-clip
            this.paused = true;
            if (heardSrc.startsWith('blob:') && this.volume > 0) env.heard.push(heardSrc);
            this.onended?.();
          }, 5);
        }, isReal ? 0 : silentPlayDelayMs);
      });
    }
    pause() {
      this.paused = true;
      if (pauseRejectsPending) this.abortPending('pause');
    }
  }

  const docListeners = {};
  let blobCounter = 0;
  const context = {
    exports: {},
    console: { ...console, log() {}, warn() {}, error() {} },
    Audio: FakeAudioElement,
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    document: {
      addEventListener: (type, cb) => { (docListeners[type] ??= []).push(cb); },
      removeEventListener: () => {},
    },
    URL: { createObjectURL: () => `blob:clip-${++blobCounter}`, revokeObjectURL: () => {} },
    fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const provider = new context.exports.OpenAITTSProvider();
  const events = { start: 0, end: 0, error: 0 };
  provider.on('start', () => events.start++);
  provider.on('end', () => events.end++);
  provider.on('error', () => events.error++);
  // A real tap: listeners run synchronously inside the gesture.
  env.tap = () => {
    env.inGesture = true;
    for (const cb of docListeners.click ?? []) cb();
    env.inGesture = false;
  };
  return { env, provider, events, FakeAudioElement };
}

// 0. The harness really reproduces the AbortError mechanism: swapping .src
//    under a pending play() rejects it. (If this didn't hold, the checks
//    below would prove nothing.)
async function harnessReproducesAbortError() {
  const { env, FakeAudioElement } = makeEnv({ silentPlayDelayMs: 30 });
  const el = new FakeAudioElement();
  el.blessed = true;
  el.src = 'data:silent';
  const pending = el.play();
  el.src = 'blob:real';
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(env.abortErrors.length, 1);
}

// 1+2. Worst case for the old code: a tap starts the unlock's silent
//      play(), it's still PENDING (slow decode, and this engine's pause()
//      does NOT reject it), and the tutor's line arrives right then.
//      playBlob must pause, WAIT for that play() to settle, and only then
//      swap .src — no AbortError on the real clip, and it must be heard
//      in full (the unlock's own pause() must not cut it).
async function noSrcSwapUnderPendingPlay() {
  const { env, provider, events } = makeEnv({ pauseRejectsPending: false, silentPlayDelayMs: 40 });
  env.tap();
  await provider.speakBlob(new Blob([new Uint8Array(8)]));
  assert.deepEqual(env.abortErrors.filter((a) => a.src.startsWith('blob:')), [], 'the real clip must never be aborted');
  assert.equal(env.abortErrors.length, 0, '.src must not be swapped while the unlock play() is still pending');
  assert.equal(env.realPlayCalls, 1, 'no retry needed — the cause is gone');
  assert.deepEqual(env.heard, ['blob:clip-1'], 'the clip must actually be heard to the end');
  assert.equal(events.start, 1);
  assert.equal(events.end, 1);
}

// 1. If a stray AbortError still happens, the ONE retry must genuinely
//    play with sound — not just resolve the promise.
async function strayAbortErrorRetryIsAudible() {
  const { env, provider, events } = makeEnv({ injectAbortOnFirstRealPlay: true });
  env.tap();
  await tick(5);
  await provider.speak('Perfect! Now let\'s continue. Repeat after me: B.', { lang: 'en-US' });
  assert.equal(env.realPlayCalls, 2, 'exactly one retry');
  assert.deepEqual(env.heard, ['blob:clip-1'], 'the retried clip must be heard to the end');
  assert.equal(events.start, 1, 'start must fire from real playback');
  assert.equal(events.end, 1);
  assert.equal(events.error, 0);
}

// 3. A whole voice session with NO touches between tutor turns: one tap
//    to pick the lesson, then turns and idle nudges back to back, with no
//    gesture in between. The element must stay unlocked throughout. Also
//    covers a Falar tap landing in the middle of a turn's /api/tts fetch.
async function voiceOnlySessionStaysUnlocked() {
  const { env, provider, events, FakeAudioElement } = makeEnv({ silentPlayDelayMs: 10 });
  const lines = [
    'Hi! How are you doing today? Repeat after me: A.',
    'Great try! The correct way is: A. Now you try: A.',
    'Perfect! Now let\'s continue. Repeat after me: B.',
    'Take your time! Repeat after me: B.', // idle nudge — nobody touched anything
    'Great job! Now repeat after me: C.',
    'Exactly right! Now repeat after me: D.',
  ];
  env.tap(); // the lesson pick — the only gesture in the session
  await tick(20);
  for (const line of lines) await provider.speak(line, { lang: 'en-US' });

  // A Falar tap during the fetch window of one more turn (not speaking yet).
  const pending = provider.speak('Now you start the dialogue.', { lang: 'en-US' });
  env.tap();
  await pending;

  assert.equal(env.elements.length, 1, 'one shared element for the whole session');
  assert.equal(env.heard.length, lines.length + 1, `every turn must be heard (heard ${env.heard.length})`);
  assert.equal(events.start, lines.length + 1);
  assert.equal(events.error, 0);
  assert.equal(env.abortErrors.filter((a) => a.src.startsWith('blob:')).length, 0);

  // Control: the fake really enforces the iOS rule — a fresh element with
  // no gesture behind it (what cd4e323 did) is refused.
  const fresh = new FakeAudioElement();
  fresh.src = 'blob:fresh';
  await assert.rejects(fresh.play(), { name: 'NotAllowedError' });
}

// cancel() during the /api/tts fetch resolves speak() and never plays.
async function cancelDuringFetch() {
  let releaseFetch;
  const { env, provider } = makeEnv({
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      releaseFetch = () => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  env.tap();
  const speaking = provider.speak('Exactly right! Now repeat after me: D.', { lang: 'en-US' });
  await tick(5);
  provider.cancel(120);
  await speaking; // must resolve — not reject, not hang
  releaseFetch?.();
  await tick(20);
  assert.equal(env.realPlayCalls, 0, 'a line cancelled mid-fetch must never start playing');
}

(async () => {
  await harnessReproducesAbortError();
  await noSrcSwapUnderPendingPlay();
  await strayAbortErrorRetryIsAudible();
  await voiceOnlySessionStaysUnlocked();
  await cancelDuringFetch();
  console.log('PASS: shared element — no .src swap under a pending play(); stray AbortError retry is heard; 7-turn no-touch session all heard; cancel mid-fetch never plays');
})().catch((error) => { console.error(error); process.exitCode = 1; });
