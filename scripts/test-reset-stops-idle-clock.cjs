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

// Regression for a real bug found while testing the correction-speech fix:
// reset() used to call stopIdleClock() BEFORE its own final RESET dispatch
// — but that dispatch is what transitions the state machine to "idle",
// which is exactly what starts the idle-nudge clock (see the constructor's
// stateMachine.subscribe hook). Stopping the clock first only works when
// the state is ALREADY "idle" (dispatching RESET onto an already-idle
// state is a no-op — see CharacterStateMachine.setState — so nothing
// restarts). The moment reset() is called from any OTHER state — a
// correction's transient state is the easiest one to land on and hold
// (its own auto-revert takes ~1.5s, plenty of time to call reset() first)
// — RESET's dispatch is a real "-> idle" transition, which starts a fresh
// clock that stopIdleClock() (already run, earlier) never touches again.
// Every such "Encerrar" left the idle-nudge clock ticking forever on a
// cleared session, firing real /api/chat nudge calls against an empty
// history in the background.
async function check() {
  let sendCount = 0;
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async () => {
        sendCount++;
        return {
          speech: { english: 'Good try! The correct way is: LISTENING.', portuguese: '' },
          correction: { studentSaid: 'x', corrected: 'LISTENING', explanation: 'x' },
        };
      },
    },
    speech: { on: () => () => {}, speak: async () => {}, speakSlow: async () => {}, cancel: () => {} },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {} },
  });

  await orchestrator.runTurn({});
  assert.equal(sendCount, 1);
  // The correction turn just landed the state machine on the "correction"
  // transient (see runTurn's own `if (correction) dispatch({type:
  // "CORRECTION"})`) — reset() called from exactly here, before its ~1.5s
  // auto-revert, is the scenario that exposed the bug.
  assert.equal(orchestrator.getState(), 'correction');
  orchestrator.reset();

  // Wait past the FIRST nudge threshold (6s — see NUDGE_THRESHOLDS_MS).
  // If the old bug were present, the still-running idle clock would fire
  // a 'gentle' nudge (another send() call) right around this mark, on a
  // cleared session with no lesson code, no history, nothing left.
  await new Promise((resolve) => setTimeout(resolve, 6800));
  assert.equal(sendCount, 1, 'reset() must leave no idle-nudge clock running — no AI calls after ending the session');

  console.log('PASS: reset() actually stops the idle-nudge clock — no background /api/chat calls after ending a session');
}

(async () => {
  await check();
})().catch((error) => { console.error(error); process.exitCode = 1; });
