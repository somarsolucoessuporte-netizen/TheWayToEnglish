const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Regression for a real bug found investigating "funciona na primeira tarefa,
// para de falar a partir da segunda": OpenAITTSProvider.playBlob's
// `audio.play().catch(...)` handler called `finish()` — the RESOLVE path —
// on a rejected play() (autoplay blocked, or an AbortError from reusing the
// same <audio> element turn after turn — see playBlob's own doc comment).
// That silently treated a playback failure as success: no error ever
// reached speakAtSpeed's catch, so its speechSynthesis fallback never ran,
// and the student got text with no audio and no error, indistinguishable
// from a passing turn in the logs. This proves a rejected play() now
// correctly falls through to the fallback voice instead.
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/speech/OpenAITTSProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function check() {
  const synthCalls = [];
  class FakeAudioElement {
    set src(v) { this._src = v; }
    get src() { return this._src ?? ''; }
    play() {
      return Promise.reject(Object.assign(new Error('play() not allowed'), { name: 'NotAllowedError' }));
    }
    pause() {}
  }
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  }
  const context = {
    exports: {},
    console,
    Audio: FakeAudioElement,
    Blob,
    AbortController,
    window: {
      speechSynthesis: {
        speak(u) {
          synthCalls.push(u.text);
          setTimeout(() => u.onend?.(), 0);
        },
        cancel() {},
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout,
      AudioContext: undefined,
    },
    document: undefined,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
  };
  vm.createContext(context);
  context.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  context.window.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  vm.runInContext(source, context);
  const provider = new context.exports.OpenAITTSProvider();

  await provider.speak('Repeat after me: Listening.', { lang: 'en-US' });

  assert.deepEqual(
    synthCalls,
    ['Repeat after me: Listening.'],
    'a rejected audio.play() must trigger the speechSynthesis fallback, not silently "succeed" with no audio at all'
  );

  console.log('PASS: a rejected audio.play() falls back to speechSynthesis instead of silently succeeding with no audio');
}

(async () => {
  await check();
})().catch((error) => { console.error(error); process.exitCode = 1; });
