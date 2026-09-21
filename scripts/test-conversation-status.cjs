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
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => {
      if (chatFails) throw new Error('Chat unavailable');
      return response;
    } },
    speech: {
      on: () => () => {},
      speak: async () => { throw new Error('Audio unavailable'); },
    },
    stt: { on: () => () => {} },
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
    await orchestrator.runTurn(prefetched ? { prefetchedResponse: response } : {});
    assert.equal(errors.length, 2, 'A repeated reply to a student must still be spoken');
  }
  orchestrator.updateCorrectionAttemptTracking({ correction: { corrected: 'LISTENING' } });
  orchestrator.updateCorrectionAttemptTracking({ correction: { corrected: 'Listening.' } });
  assert.equal(orchestrator.correctionAttemptCount, 2, 'Punctuation must not reset attempts');
}

(async () => {
  await check({});
  await check({ prefetched: true });
  await check({ chatFails: true });
  console.log('PASS: live/prefetched audio failures preserve chat status; chat failures mark offline.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
