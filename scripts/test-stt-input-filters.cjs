const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Input quality (Lição A session):
//   - the mic transcribed the tutor's own line as the student's answer
//     ("What is the symbol for SPEAKING?" came back as the reply);
//   - Whisper hallucinated "Legendas pela comunidade Amara.org" on silence;
//   - repeated prompts had no ceiling ("repete sem parar").
// Also: "Book 1, Lesson A — Lesson A" (title fell back to the code).

function loadTs(filename) {
  if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, resolveJsonModule: true, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(filename), name);
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadTs(candidate);
    }
    throw new Error(`cannot resolve ${name}`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const quiet = { ...console };
console.log = () => {};
console.warn = () => {};

const src = (p) => path.resolve(__dirname, '../src', p);
const { matchWhisperHallucination, echoSimilarity, ECHO_SIMILARITY_THRESHOLD } = loadTs(src('core/stt/transcriptFilters.ts'));
const { ConversationOrchestrator } = loadTs(src('core/conversation/orchestrator.ts'));

function filters() {
  for (const h of [
    'Legendas pela comunidade Amara.org',
    'Amara.org',
    'Subtitles by the Amara.org community',
    'Legendas por Rafael',
    'Obrigado por assistir!',
    'Thanks for watching!',
    'Tchau.',
    'www.example.com',
  ]) assert.ok(matchWhisperHallucination(h), `must be flagged as hallucination: ${h}`);
  for (const ok of ['Speaking', 'I don\'t know', 'Tchau, see you tomorrow teacher', 'My name is Francisco', 'Eu não sei']) {
    assert.equal(matchWhisperHallucination(ok), null, `must NOT be flagged: ${ok}`);
  }

  const echo = (t, line) => echoSimilarity(t, line) > ECHO_SIMILARITY_THRESHOLD;
  // The reported echoes (full and partial).
  assert.ok(echo('What is the symbol for SPEAKING?', 'First one: SPEAKING. What is the symbol for SPEAKING?'));
  assert.ok(echo(
    "Now, let's try again. What is the symbol for LISTENING?",
    "The symbol for SPEAKING is a person talking. Now, let's try again. What is the symbol for LISTENING?"
  ));
  // Real answers — including correct repeats of the practice target.
  assert.ok(!echo('Nice to meet you', 'Great! Repeat after me: Nice to meet you.'));
  assert.ok(!echo('Hello, nice to meet you too', 'Repeat after me: Hello, nice to meet you too.'));
  assert.ok(!echo('The symbol for speaking is a mouth', 'What is the symbol for SPEAKING?'));
  assert.ok(!echo('Hello, my name is Francisco', "Hello, my name's Debbie. What's your name?"));
  assert.ok(!echo('Speaking', 'Repeat after me: SPEAKING.'));
}

function makeOrchestrator(replyFor) {
  const sends = [];
  const stt = { listeners: {}, starts: 0 };
  const speech = { listeners: { start: new Set(), end: new Set(), error: new Set() }, cancels: [], speaking: false };
  const orchestrator = new ConversationOrchestrator({
    systemPrompt: '',
    ai: { send: async (_m, opts) => { sends.push(opts?.nudge ?? 'answer-turn'); return replyFor(opts); } },
    speech: {
      on: (e, cb) => { speech.listeners[e].add(cb); return () => speech.listeners[e].delete(cb); },
      speak: async () => {},
      cancel: (fade) => { speech.cancels.push(fade ?? 0); speech.speaking = false; },
      isSpeaking: () => speech.speaking,
    },
    stt: {
      on: (e, cb) => { stt.listeners[e] = cb; return () => {}; },
      start: async () => { stt.starts++; },
      stop: async () => '',
    },
    avatar: { setState() {}, setSpeechAudioDuration() {}, notifySpeechSegmentEnded() {} },
  });
  const say = async (transcript) => {
    await orchestrator.startListening();
    stt.listeners.final({ transcript });
    await new Promise((r) => setTimeout(r, 30));
  };
  return { orchestrator, sends, stt, speech, say };
}

async function rejectedTranscriptsRepeatInsteadOfGrading() {
  const { orchestrator, sends, say } = makeOrchestrator(() => ({ speech: { english: 'First one: SPEAKING. What is the symbol for SPEAKING?', portuguese: '' } }));
  orchestrator.lessonGoals = ['task-1', 'task-2'];
  await orchestrator.runTurn({}); // tutor asks
  await say('What is the symbol for SPEAKING?'); // echo
  await say('Legendas pela comunidade Amara.org'); // hallucination
  const userBubbles = orchestrator.entries.filter((e) => e.role === 'user');
  assert.equal(userBubbles.length, 0, 'echo/hallucination must never appear as the student\'s answer');
  assert.deepEqual(sends, ['answer-turn', 'unclear', 'unclear'], 'each rejected transcript -> an "unclear" repeat, not an answer');
  orchestrator.reset();
}

async function nudgeCapAdvancesAfterThree() {
  const { orchestrator, sends, say } = makeOrchestrator(() => ({ speech: { english: "Sorry, I didn't catch that. What is the symbol for SPEAKING?", portuguese: '' } }));
  orchestrator.lessonGoals = ['task-1', 'task-2'];
  await orchestrator.runTurn({});
  for (let i = 0; i < 4; i++) await say('Legendas pela comunidade Amara.org'); // the production loop
  assert.deepEqual(sends, ['answer-turn', 'unclear', 'unclear', 'advance', 'unclear'],
    'the 3rd consecutive prompt must be "advance", and the counter restarts after it');

  // A valid answer resets the counter.
  sends.length = 0;
  await say('Legendas pela comunidade Amara.org');
  await say('A person talking');
  await say('Legendas pela comunidade Amara.org');
  await say('Legendas pela comunidade Amara.org');
  assert.deepEqual(sends, ['unclear', 'answer-turn', 'unclear', 'unclear']);
  orchestrator.reset();
}

async function micNeverOpensOverTheTutor() {
  const { orchestrator, stt, speech } = makeOrchestrator(() => ({ speech: { english: 'Hi', portuguese: '' } }));
  // Correction-card audio (not owned by a turn) playing when Falar is pressed.
  speech.speaking = true;
  const t0 = Date.now();
  await orchestrator.startListening();
  const waited = Date.now() - t0;
  assert.ok(speech.cancels.includes(120), 'stray audio must be faded out');
  assert.ok(waited >= 250, `mic must wait fade (120) + margin (150) before opening (waited ${waited}ms)`);
  assert.equal(stt.starts, 1);

  // TTS starting while the mic is open is cancelled on the spot.
  speech.cancels.length = 0;
  for (const cb of speech.listeners.start) cb();
  assert.equal(speech.cancels.length, 1, 'TTS that starts while listening must be cancelled');
  assert.equal(orchestrator.getState(), 'listening');
  orchestrator.reset();
}

function lessonATitle() {
  const { getLessonByCode, getCourseOverview } = loadTs(src('app-config/curriculum/index.ts'));
  assert.equal(getLessonByCode('A').title, 'Symbols used in The Way to English');
  for (const l of getCourseOverview()) {
    assert.notEqual(l.title, `Lesson ${l.lessonCode}`, `lesson ${l.lessonCode} has no descriptive title`);
  }
}

(async () => {
  filters();
  lessonATitle();
  await rejectedTranscriptsRepeatInsteadOfGrading();
  await nudgeCapAdvancesAfterThree();
  await micNeverOpensOverTheTutor();
  quiet.log('PASS: echo + Whisper hallucinations rejected as "unclear"; 3rd prompt in a row advances; mic waits for silence; Lesson A title');
  process.exit(0);
})().catch((error) => { quiet.error(error); process.exit(1); });
