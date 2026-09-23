const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// OpenAITTSProvider imports ./portugueseGuard — resolve it for the vm context.
function requireFromSpeech(name) {
  const file = require('node:path').resolve(__dirname, '../src/core/speech', `${name.replace(/^\.\//, '')}.ts`);
  const out = require('typescript').transpileModule(require('node:fs').readFileSync(file, 'utf8'), {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out)(require, mod, mod.exports);
  return mod.exports;
}


// Verifies OpenAITTSProvider.fallbackSpeak() always settles even when
// speechSynthesis never fires onstart/onend/onerror for the utterance —
// the exact "sessão trava, busy nunca volta a false" production report:
// the PRIMARY /api/tts path failing (any reason) falls back to
// speechSynthesis, and without a watchdog that promise could hang the
// whole runTurn() forever.
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/speech/OpenAITTSProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function check(name, { fires = null } = {}) {
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  }
  const utterances = [];
  const context = {
    exports: {}, require: requireFromSpeech, console,
    window: {
      speechSynthesis: {
        speak(u) {
          utterances.push(u);
          // Simulate the browser never calling back at all (the real bug),
          // or firing the given event, on the next tick either way.
          if (fires) setTimeout(() => u[fires]?.(new Event(fires)), 0);
        },
        cancel() {},
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout,
      AudioContext: undefined,
    },
    document: undefined,
    Audio: undefined,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    fetch: async () => { throw new Error('network down'); },
    Event: class Event { constructor(type) { this.type = type; } },
  };
  context.window.speechSynthesis.constructor = undefined;
  vm.createContext(context);
  context.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  context.window.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  vm.runInContext(`Object.defineProperty(window, 'AudioContext', {value: undefined});`, context);
  vm.runInContext(source, context);
  const provider = new context.exports.OpenAITTSProvider();
  const start = Date.now();
  try {
    await provider.speak('Nice to meet you, Francisco!', { lang: 'en-US' });
    console.log(`PASS: ${name} (${Date.now() - start}ms) — resolved`);
  } catch (err) {
    console.log(`PASS: ${name} (${Date.now() - start}ms) — rejected: ${err.message}`);
  }
  assert.ok(Date.now() - start < 9000, `${name}: took too long — fallback hung`);
}

(async () => {
  await check('speechSynthesis fires onend normally', { fires: 'onend' });
  await check('speechSynthesis never fires any event (the bug)', { fires: null });
  console.log('PASS: fallbackSpeak always settles, even when speechSynthesis stays silent');
})().catch((error) => { console.error(error); process.exitCode = 1; });
