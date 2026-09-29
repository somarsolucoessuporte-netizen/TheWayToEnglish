const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The model reported a task in completedGoals in the SAME reply that started
// it, so lessons ended with a fraction of the tasks done ("Etapa 1 de 1").
// The orchestrator now accepts at most one goal per turn, and only the
// CURRENT task after at least one real student answer in it. Rejected ids are
// stripped from the response, so the progress bar (which counts from
// entries) never shows them either.

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
const rejections = [];
console.log = () => {};
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[progress] goal rejeitado')) rejections.push(line);
};

function setup(replies) {
  const { ConversationOrchestrator } = loadTs(path.resolve(__dirname, '../src/core/conversation/orchestrator.ts'));
  let completed = 0;
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async () => replies.shift() },
    speech: { on: () => () => {}, speak: async () => {}, cancel: () => {}, isSpeaking: () => false },
    stt: { on: () => () => {}, start: async () => {}, stop: async () => '', abort: () => {} },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  orchestrator.onLessonComplete(() => { completed++; });
  const tutorGoals = () => orchestrator.entries.filter((e) => e.role === 'tutor').map((e) => e.response.completedGoals);
  return { orchestrator, tutorGoals, completedCount: () => completed };
}

const say = (english, completedGoals) => ({ speech: { english, portuguese: '' }, ...(completedGoals ? { completedGoals } : {}) });
const GOALS = ['task-1', 'task-2', 'task-3'];

async function goalReportedWhenTaskStartsDoesNotCount() {
  rejections.length = 0;
  const { orchestrator, tutorGoals, completedCount } = setup([
    say('Hi! Repeat after me: A.'),
    say('Great! Now in random order. Repeat: K.', ['task-1', 'task-2']), // closes 1 AND claims the task it just started
    say('Good. Repeat: Q.', ['task-2']), // after a real answer in task-2: accepted
  ]);
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: GOALS });
  await orchestrator.sendTextMessage('A');
  assert.deepEqual(Array.from(orchestrator.completedGoals), ['task-1'], 'task-2 was only started — not done');
  assert.equal(orchestrator.currentTaskId(), 'task-2');
  assert.equal(completedCount(), 0, 'the lesson did not end');
  assert.ok(rejections.some((r) => /task-2 motivo: mais de uma tarefa/.test(r)));
  await orchestrator.sendTextMessage('K');
  assert.deepEqual(Array.from(orchestrator.completedGoals), ['task-1', 'task-2']);
  assert.deepEqual(tutorGoals(), [undefined, ['task-1'], ['task-2']], 'progress bar sees only accepted goals');
  orchestrator.reset();
}

async function startingReplyAloneCannotCompleteTheCurrentTask() {
  rejections.length = 0;
  // The production case: the turn that STARTS task-1 already reports it.
  const { orchestrator, tutorGoals, completedCount } = setup([say('Hi! Repeat after me: A.', ['task-1'])]);
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'A', canDoGoals: ['task-1'] });
  assert.equal(orchestrator.completedGoals.size, 0);
  assert.equal(completedCount(), 0, '"Etapa 1 de 1" without a single answer must not happen');
  assert.deepEqual(tutorGoals(), [undefined]);
  assert.ok(rejections.some((r) => /task-1 motivo: nenhuma resposta do aluno/.test(r)));
  orchestrator.reset();
}

async function futureRepeatedAndUnknownIdsAreRejected() {
  rejections.length = 0;
  const { orchestrator } = setup([
    say('Hi! Repeat after me: A.'),
    say('Repeat: B.', ['task-3']), // future task
    say('Repeat: C.', ['task-9']), // not in this lesson
    say('Nice. Next.', ['task-1']), // current + answered: accepted
    say('Repeat: D.', ['task-1']), // repeated
  ]);
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: GOALS });
  for (const text of ['A', 'B', 'C', 'D']) await orchestrator.sendTextMessage(text);
  assert.deepEqual(Array.from(orchestrator.completedGoals), ['task-1']);
  assert.ok(rejections.some((r) => /task-3 motivo: não é a tarefa atual \(task-1\)/.test(r)));
  assert.ok(rejections.some((r) => /task-9 motivo: não é tarefa desta lição/.test(r)));
  assert.ok(rejections.some((r) => /task-1 motivo: já concluída/.test(r)));
  orchestrator.reset();
}

async function nudgesAreNotAnswers() {
  const { orchestrator } = setup([say('Hi! Repeat after me: A.'), say('Let me help: A.', ['task-1'])]);
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: GOALS });
  await orchestrator.runNudgeTurn('answer'); // silence, not an answer
  assert.equal(orchestrator.completedGoals.size, 0);
  orchestrator.reset();
}

async function wholeLessonStillCompletes() {
  const { orchestrator, completedCount } = setup([
    say('Hi! Repeat after me: A.'),
    say('Great. Next task.', ['task-1']),
    say('Great. Last task.', ['task-2']),
    say('All done!', ['task-3']),
  ]);
  await orchestrator.startLesson({ studentName: 'Ana', currentLessonCode: 'B', canDoGoals: GOALS });
  for (const text of ['A', 'B', 'C']) await orchestrator.sendTextMessage(text);
  assert.equal(completedCount(), 1, 'one real answer per task completes the lesson');
  orchestrator.reset();
}

(async () => {
  await goalReportedWhenTaskStartsDoesNotCount();
  await startingReplyAloneCannotCompleteTheCurrentTask();
  await futureRepeatedAndUnknownIdsAreRejected();
  await nudgesAreNotAnswers();
  await wholeLessonStillCompletes();
  quiet.log('PASS: a task only completes when current, answered at least once, one per turn; future/repeated/unanswered ids rejected and never shown');
  process.exit(0);
})().catch((error) => { quiet.error(error); process.exit(1); });
