const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Regression for "turno 1 fala OK, turno 2 em diante silêncio total,
// texto revelado normalmente": the real gap in enqueueSpeak wasn't a
// REJECTED task (this.speechQueue's own continuation already swallowed
// that, via `.then(() => undefined, () => undefined)`) — it was a task
// that never settles AT ALL. That leaves `this.speechQueue` (and every
// enqueueSpeak call chained after it, forever) waiting on a promise that
// will never resolve or reject, which reads exactly like "works once,
// dead after": the first turn's speech genuinely never finishes, and
// nothing downstream — including every LATER turn's own speech — can
// ever run again for the rest of the session.
//
// Speeds up any timer scheduled for >= 30s (matches
// SPEAK_QUEUE_WATCHDOG_MS in orchestrator.ts) so this doesn't have to
// wait 34 real seconds — every other timer in the module (well under
// 30s) keeps its real duration.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) =>
  (typeof ms === 'number' && ms >= 30000) ? realSetTimeout(fn, 30, ...args) : realSetTimeout(fn, ms, ...args);

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

async function check() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  let speakCallCount = 0;
  const resolvedCalls = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => ({ speech: { english: 'Hello!', portuguese: '' } }) },
    speech: {
      on: () => () => {},
      cancel: () => {},
      speak: async (text) => {
        speakCallCount++;
        if (speakCallCount === 1) {
          // The exact bug: neither resolves nor rejects, ever — e.g. an
          // "ended"/"error" that silently never fires on some browser/
          // element combination, with no watchdog inside speak() itself
          // covering that specific gap.
          return new Promise(() => {});
        }
        resolvedCalls.push(text);
      },
    },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });

  const start = Date.now();
  await orchestrator.runTurn({}); // turn 1 — its speak() hangs; the watchdog must still release it
  await orchestrator.runTurn({}); // turn 2 — proves the shared queue is still usable afterward
  const elapsedMs = Date.now() - start;

  assert.deepEqual(
    resolvedCalls,
    ['Hello!'],
    'turn 2 must actually reach speech.speak() — a hung turn 1 must not permanently jam the queue'
  );
  assert.ok(elapsedMs < 3000, `must not wait anywhere near the real 34s watchdog duration (took ${elapsedMs}ms)`);

  console.log('PASS: a speak() call that never settles does not permanently jam the shared queue for later turns');
}

check()
  .then(() => { global.setTimeout = realSetTimeout; })
  .catch((error) => {
    global.setTimeout = realSetTimeout;
    console.error(error);
    process.exitCode = 1;
  });
