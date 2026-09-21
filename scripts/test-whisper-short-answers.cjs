const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/stt/WhisperSTTProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function check(name, samples, expectedUploads, suspended = false) {
  let tick;
  let now = 0;
  let value = 128;
  let uploads = 0;
  let resumes = 0;
  const events = [];
  class AudioContext {
    state = suspended ? 'suspended' : 'running';
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return {
      frequencyBinCount: 256,
      getByteTimeDomainData(data) { data.fill(value); },
    }; }
    async resume() { resumes++; this.state = 'running'; }
    async close() {}
  }
  const context = {
    exports: {}, console, Blob, FormData, AbortController,
    performance: { now: () => now },
    setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {}, clearTimeout() {},
    window: { AudioContext, setTimeout: () => 1, clearTimeout() {} },
    fetch: async () => {
      uploads++;
      return { ok: true, json: async () => ({ transcript: 'Yes', detectedLanguage: 'en' }) };
    },
  };
  vm.runInNewContext(source, context);
  const provider = new context.exports.WhisperSTTProvider();
  provider.stream = {};
  provider.chunks = [new Blob(['recorded audio'])];
  provider.on('final', ({ transcript }) => events.push(transcript));
  provider.startSilenceWatch();
  for (const sample of samples) {
    value = sample;
    now += 50;
    tick();
  }
  now = Math.max(now, 600);
  // Exercise the same completion path as the recorder's stop event.
  provider.stopSilenceWatch();
  await provider.transcribeAndFinish();
  assert.equal(uploads, expectedUploads, name);
  assert.deepEqual(events, expectedUploads ? ['Yes'] : [], name);
  if (suspended) assert.equal(resumes, 1);
  console.log(`PASS: ${name}`);
}

(async () => {
  // 500ms of voice at RMS 0.0234; the old whole-clip average was < 0.015.
  await check('short answer after thinking and before trailing silence',
    [...Array(40).fill(128), ...Array(10).fill(131), ...Array(35).fill(128)], 1);
  await check('silence is discarded', Array(40).fill(128), 0);
  await check('single click is discarded', [140, ...Array(20).fill(128)], 0);
  await check('unavailable measurements preserve recording', [], 1);
  await check('suspended analyser resumes', Array(10).fill(131), 1, true);
})().catch((error) => { console.error(error); process.exitCode = 1; });
