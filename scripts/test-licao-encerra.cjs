const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Lesson ending is TERMINAL: after the last task, turns and nudges kept
// firing and the model — seeing every task done — started the lesson over.
// After "finished": no runTurn, no nudge scheduled, mic closed. The closing
// announcement itself (forceAnnounce, not runTurn) still plays.

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

const quiet = { ...console };
console.log = () => {};
console.warn = () => {};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(reply) {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  const sends = [];
  const spoken = [];
  const stt = { starts: 0, aborts: 0, listeners: {} };
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async (_m, opts) => { sends.push(opts?.nudge ?? 'turn'); return reply(); } },
    speech: {
      on: () => () => {},
      speak: async (text) => { spoken.push(text); },
      cancel: () => {},
      isSpeaking: () => false,
    },
    stt: {
      on: (e, cb) => { stt.listeners[e] = cb; return () => {}; },
      start: async () => { stt.starts++; },
      stop: async () => '',
      abort: () => { stt.aborts++; },
    },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  // Same wiring as page.tsx: completion -> closing announcement.
  orchestrator.onLessonComplete(() => { void orchestrator.announceLessonComplete(); });
  return { orchestrator, sends, spoken, stt };
}

async function lastTaskEndsTheLesson() {
  // A task only completes after a real student answer in it (see
  // test-premature-goal.cjs): kickoff, one answer, then the completing reply.
  const replies = [
    { speech: { english: 'Hi! Repeat after me: SPEAKING.', portuguese: '' } },
    { speech: { english: 'Great job! We finished all the tasks.', portuguese: '' }, completedGoals: ['task-1'] },
  ];
  const { orchestrator, sends, spoken, stt } = setup(() => replies.shift());
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'A', canDoGoals: ['task-1'] });
  await orchestrator.sendTextMessage('speaking');
  await tick(2500); // the closing announcement plays after its ~1.5s praise pose
  assert.deepEqual(sends, ['turn', 'turn'], 'only the kickoff and the turn that completed the last task');
  assert.ok(spoken.some((t) => /Congratulations/.test(t)), 'the closing announcement still plays');

  // Nothing may start again: turns, nudges, mic, typed messages.
  orchestrator.idleAccumulatedMs = 5900;
  await tick(1200); // past the first nudge threshold if a clock were running
  await orchestrator.runTurn({});
  await orchestrator.fireNudge('gentle');
  const micOpened = await orchestrator.startListening();
  await orchestrator.sendTextMessage('hello again');
  assert.deepEqual(sends, ['turn', 'turn'], 'no runTurn and no nudge after the lesson is finished');
  assert.equal(orchestrator.idleTickHandle, null, 'no nudge clock scheduled');
  assert.equal(micOpened, false);
  assert.equal(stt.starts, 0, 'the mic never opens after the lesson is finished');
  assert.equal(orchestrator.entries.filter((e) => e.role === 'user').length, 1, 'only the real answer — the post-end message is dropped');

  // A new lesson starts fresh.
  orchestrator.reset();
  replies.push({ speech: { english: 'Hi! Repeat after me: A.', portuguese: '' } });
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: ['task-1', 'task-2'] });
  assert.deepEqual(sends, ['turn', 'turn', 'turn'], 'reset + startLesson makes the session active again');
  orchestrator.reset();
}

async function timeUpClosesTheOpenMic() {
  const { orchestrator, sends, stt } = setup(() => ({ speech: { english: 'Repeat after me: B.', portuguese: '' } }));
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: ['task-1', 'task-2'] });
  await orchestrator.startListening();
  assert.equal(orchestrator.getState(), 'listening');
  await orchestrator.announceLessonComplete(); // page.tsx's time-up path
  assert.equal(stt.aborts >= 1, true, 'an open mic is closed when the lesson ends');
  stt.listeners.final?.({ transcript: 'B' }); // a late transcript
  await tick(30);
  assert.deepEqual(sends, ['turn'], 'no turn after time ran out');
  orchestrator.reset();
}

(async () => {
  await lastTaskEndsTheLesson();
  await timeUpClosesTheOpenMic();
  quiet.log('PASS: lesson end is terminal — no runTurn, no nudge, mic closed; the closing announcement still plays; reset starts fresh');
  process.exit(0);
})().catch((error) => { quiet.error(error); process.exit(1); });
