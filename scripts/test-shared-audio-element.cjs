const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Regression for "turno 1 fala, do turno 2 em diante só escreve, até o fim
// da sessão" (Lição B — The Alphabet). cd4e323 switched playBlob() to a
// brand-new `new Audio()` per call; on iOS an element that never played
// inside a user gesture gets play() rejected, and every turn after the
// kickoff has no gesture behind it. Confirms:
//   1. every speak() plays through the SAME element (the one unlocked by
//      the gesture), turn after turn;
//   2. a one-off AbortError from play() is retried once instead of
//      dropping the line;
//   3. cancel() during the /api/tts fetch resolves speak() without ever
//      playing — a cancelled line can't start talking later.
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/speech/OpenAITTSProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function load({ playBehaviors = [], fetchImpl } = {}) {
  const created = [];
  let playCalls = 0;
  class FakeAudioElement {
    constructor() { created.push(this); this.paused = true; this.volume = 1; }
    set src(v) { this._src = v; }
    get src() { return this._src ?? ''; }
    play() {
      const behavior = playBehaviors[playCalls++] ?? 'ok';
      if (behavior === 'abort') {
        const err = new Error('The play() request was interrupted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      this.paused = false;
      setTimeout(() => this.onplaying?.(), 0);
      setTimeout(() => { this.paused = true; this.onended?.(); }, 5);
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }
  const context = {
    exports: {},
    console: { ...console, log() {}, warn() {} },
    Audio: FakeAudioElement,
    Blob,
    AbortController,
    setInterval,
    clearInterval,
    window: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    document: undefined,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { provider: new context.exports.OpenAITTSProvider(), created, playCount: () => playCalls };
}

async function sharedElementAcrossTurns() {
  const { provider, created } = load();
  let starts = 0;
  provider.on('start', () => starts++);
  for (const text of ['Repeat after me: A.', 'Great try! Now you try: A.', 'Repeat after me: B.', 'Repeat after me: C.']) {
    await provider.speak(text, { lang: 'en-US' });
  }
  assert.equal(created.length, 1, 'every turn must play through the one shared (gesture-unlocked) element');
  assert.equal(starts, 4, 'all four turns must actually start playing');
}

async function abortErrorRetriedOnce() {
  const { provider, playCount } = load({ playBehaviors: ['abort', 'ok'] });
  let started = false;
  provider.on('start', () => { started = true; });
  await provider.speak('Perfect! Repeat after me: B.', { lang: 'en-US' });
  assert.equal(playCount(), 2, 'AbortError must trigger exactly one retry');
  assert.ok(started, 'the retried play() must actually play');
}

async function cancelDuringFetch() {
  let releaseFetch;
  const { provider, playCount } = load({
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      releaseFetch = () => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  const speaking = provider.speak('Exactly right! Now repeat after me: D.', { lang: 'en-US' });
  await new Promise((r) => setTimeout(r, 5));
  provider.cancel(120);
  await speaking; // must resolve (not reject, not hang)
  releaseFetch?.();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(playCount(), 0, 'a line cancelled mid-fetch must never start playing');
}

(async () => {
  await sharedElementAcrossTurns();
  await abortErrorRetriedOnce();
  await cancelDuringFetch();
  console.log('PASS: every turn reuses the unlocked <audio> element; AbortError retried once; cancel() mid-fetch never plays');
})().catch((error) => { console.error(error); process.exitCode = 1; });
