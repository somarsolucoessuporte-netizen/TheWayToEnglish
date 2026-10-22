const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Idle reminder: the first nudge only after ~12s of silence (it used to
// come at 6s, mid-thought), the clock is held while the student has a
// draft in the text box, and the 40s "give the answer" resolution stays.
// The reminder's wording never says "try again" (the student didn't err).

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

console.log = () => {};
console.warn = () => {};
const pass = (msg) => process.stdout.write(`${msg}\n`);

// The idle clock is a 500ms setInterval: capture it and tick it by hand,
// so "12 seconds of silence" is exact instead of depending on timer drift.
const IDLE_TICK_MS = 500;
const intervals = new Map();
let nextHandle = 1;
global.setInterval = (fn) => { const h = nextHandle++; intervals.set(h, fn); return h; };
global.clearInterval = (h) => { intervals.delete(h); };
async function waitSimulated(ms) {
  for (let t = 0; t < ms; t += IDLE_TICK_MS) {
    for (const fn of [...intervals.values()]) fn();
    await new Promise((r) => setImmediate(r));
  }
}

function setup() {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const nudges = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async (_m, opts) => {
        if (opts?.nudge) nudges.push(opts.nudge);
        return { speech: { english: 'Take your time. Where do you save your pictures?', portuguese: '' } };
      },
    },
    speech: { on: () => () => {}, speak: async () => {}, cancel: () => {} },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '' },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  orchestrator.lessonGoals = ['task-1'];
  // idle -> thinking -> idle: a fresh question, the clock starts.
  orchestrator.dispatchState({ type: 'STOP_LISTENING' });
  orchestrator.dispatchState({ type: 'RESET' });
  return { orchestrator, nudges };
}

async function firstReminderAt12s() {
  const { orchestrator, nudges } = setup();
  await waitSimulated(11500);
  assert.deepEqual(nudges, [], 'no reminder before ~12s of silence');
  await waitSimulated(2500);
  assert.deepEqual(nudges, ['gentle'], 'first reminder after ~12s');
  orchestrator.reset();
}

async function typingHoldsTheClock() {
  const { orchestrator, nudges } = setup();
  await waitSimulated(8000);
  orchestrator.setStudentTyping(true);
  await waitSimulated(10000);
  assert.deepEqual(nudges, [], 'no reminder while the student is typing');
  orchestrator.setStudentTyping(false);
  await waitSimulated(2000);
  assert.deepEqual(nudges, [], 'the held time is not counted');
  await waitSimulated(2500);
  assert.deepEqual(nudges, ['gentle'], 'an abandoned draft resumes the count where it was');
  orchestrator.reset();
}

function wordingAndThresholds() {
  const orchestratorSrc = fs.readFileSync(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'), 'utf8');
  assert.match(orchestratorSrc, /level: "gentle", ms: 12000/);
  assert.match(orchestratorSrc, /level: "answer", ms: 40000/, 'the 40s resolution is unchanged');
  const route = fs.readFileSync(path.resolve(__dirname, '../src/app/api/chat/route.ts'), 'utf8');
  const gentle = route.slice(route.indexOf('  gentle:'), route.indexOf('  help:'));
  assert.match(gentle, /Take your time/);
  assert.match(gentle, /never say/);
  assert.doesNotMatch(gentle, /e\.g\. \\"Let's try again/);
}

(async () => {
  wordingAndThresholds();
  await firstReminderAt12s();
  await typingHoldsTheClock();
  pass('PASS: first reminder only after ~12s, held while typing, 40s resolution kept; reminder never says "try again"');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => process.exit());
