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

function makeOrchestrator(sendOptionsSink) {
  const sttListeners = {};
  const spoken = [];
  const studentNames = [];
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: {
      send: async (messages, opts) => {
        sendOptionsSink.calls.push({ messages, opts });
        return { speech: { english: 'Hi! How are you doing today?', portuguese: '' } };
      },
    },
    speech: {
      on: () => () => {},
      speak: async (text) => { spoken.push(text); },
      cancel: () => {},
    },
    stt: {
      on: (event, cb) => { sttListeners[event] = cb; return () => {}; },
      start: async () => {},
      stop: async () => '',
    },
    avatar: { setState() {} },
  });
  orchestrator.onStudentNameChange((name) => studentNames.push(name));
  return { orchestrator, sttListeners, spoken, studentNames };
}

async function testCaptureNameFirst() {
  const sendOptionsSink = { calls: [] };
  const { orchestrator, sttListeners, spoken, studentNames } = makeOrchestrator(sendOptionsSink);

  await orchestrator.startLesson({
    studentName: 'Aluno',
    currentLessonCode: '1B',
    captureNameFirst: true,
  });

  // The scripted question must be spoken, and /api/chat must NOT have
  // been called yet — this is a fixed line, not AI-generated.
  assert.deepEqual(spoken, ["Hi! Before we start — what's your name?"]);
  assert.equal(sendOptionsSink.calls.length, 0, 'must not call the AI before the name is captured');
  assert.deepEqual(studentNames, ['Aluno'], 'the placeholder is reported first');

  // Student answers — must go through startListening() first, same as a
  // real push-to-talk turn, since handleUserMessage only routes a "final"
  // event while the state machine is genuinely "listening".
  const started = await orchestrator.startListening();
  assert.equal(started, true);
  sttListeners.final({ transcript: "Hi, my name is Carlos", detectedLanguage: 'en' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The real kickoff must now have fired, exactly once, with the CAPTURED
  // name (not the "Aluno" placeholder) — and the Q&A itself must be
  // invisible to the model: only LESSON_KICKOFF_INSTRUCTION as history.
  assert.equal(sendOptionsSink.calls.length, 1, 'the real kickoff must fire once the name is captured');
  const { messages, opts } = sendOptionsSink.calls[0];
  assert.equal(opts.studentName, 'Carlos');
  const userMessages = messages.filter((m) => m.role === 'user');
  assert.equal(userMessages.length, 1, 'the name-capture exchange must not leak into the AI-visible history');
  assert.match(userMessages[0].content, /Lesson start/);
  assert.deepEqual(studentNames, ['Aluno', 'Carlos']);

  orchestrator.reset();
}

async function testUnparseableAnswerKeepsPlaceholder() {
  const sendOptionsSink = { calls: [] };
  const { orchestrator, sttListeners, studentNames } = makeOrchestrator(sendOptionsSink);

  await orchestrator.startLesson({ studentName: 'Aluno', currentLessonCode: '1B', captureNameFirst: true });
  await orchestrator.startListening();
  sttListeners.final({ transcript: 'uh, I mean, not sure', detectedLanguage: 'en' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sendOptionsSink.calls.length, 1, 'an unparseable answer must still move on to the real lesson, not stall');
  assert.equal(sendOptionsSink.calls[0].opts.studentName, 'Aluno', 'keeps the placeholder rather than a bad guess');
  assert.deepEqual(studentNames, ['Aluno'], 'never reports a name it could not actually parse');

  orchestrator.reset();
}

async function testSkippedWhenNotCapturing() {
  const sendOptionsSink = { calls: [] };
  const { orchestrator, spoken } = makeOrchestrator(sendOptionsSink);

  await orchestrator.startLesson({ studentName: 'Maria', currentLessonCode: '1A' });

  // No pre-kickoff question at all — the AI call fires immediately with
  // the real name page.tsx already had (e.g. from ?aluno=, or because
  // this is 1A, which captures the name inside its own script instead).
  assert.equal(spoken.some((t) => t.includes("what's your name")), false);
  assert.equal(sendOptionsSink.calls.length, 1);
  assert.equal(sendOptionsSink.calls[0].opts.studentName, 'Maria');

  orchestrator.reset();
}

(async () => {
  await testCaptureNameFirst();
  await testUnparseableAnswerKeepsPlaceholder();
  await testSkippedWhenNotCapturing();
  console.log('PASS: pre-kickoff name capture asks once, never leaks into AI history, and is skipped when not needed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
