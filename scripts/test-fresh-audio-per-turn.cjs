const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Regression for the follow-up report after a1f77b5 ("só a primeira
// sentença é falada, a segunda aparece escrita sem voz"): reusing the same
// <audio> element turn after turn (reassigning .src and calling .play()
// again) could throw AbortError once enough turns accumulated in a
// session. Confirms playBlob() now creates a genuinely NEW Audio instance
// on every call — nothing carried over from the previous turn for a new
// .src/.play() to conflict with — and that two back-to-back calls both
// play through cleanly.
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/speech/OpenAITTSProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function check() {
  const createdInstances = [];
  class FakeAudioElement {
    constructor() { createdInstances.push(this); }
    set src(v) { this._src = v; }
    get src() { return this._src ?? ''; }
    play() {
      // Fires "playing" (and later "ended") asynchronously, like a real
      // element — never rejects, so a successful play is what's tested
      // here (the rejection path already has its own dedicated test).
      setTimeout(() => this.onplaying?.(), 0);
      setTimeout(() => this.onended?.(), 5);
      return Promise.resolve();
    }
    pause() {}
  }
  const context = {
    exports: {},
    console,
    Audio: FakeAudioElement,
    Blob,
    AbortController,
    window: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout,
      AudioContext: undefined,
    },
    document: undefined,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const provider = new context.exports.OpenAITTSProvider();

  await provider.speak('Repeat after me: Speaking.', { lang: 'en-US' });
  await provider.speak('Repeat after me: Listening.', { lang: 'en-US' });

  assert.equal(createdInstances.length, 2, 'each speak() call must create its own fresh Audio element');
  assert.notEqual(createdInstances[0], createdInstances[1], 'the second turn must not reuse the first turn\'s element');

  console.log('PASS: playBlob() creates a brand-new Audio element per call instead of reusing one across turns');
}

(async () => {
  await check();
})().catch((error) => { console.error(error); process.exitCode = 1; });
