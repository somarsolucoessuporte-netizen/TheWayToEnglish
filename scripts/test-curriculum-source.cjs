const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The app's curriculum (src/app-config/curriculum/index.ts): served from
// Supabase, and — when Supabase is unreachable — from the bundled JSON, with
// the exact same lessons either way. Needs the live database for the first
// half; FAILS (does not skip) without credentials in .env.local.

const root = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env.local')); } catch {}

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'server-only') return {};
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(filename), name);
    if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
    return loadTs(`${base}.ts`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const indexPath = path.join(root, 'src/app-config/curriculum/index.ts');
const json = loadTs(path.join(root, 'src/app-config/curriculum/json-source.ts'));
// Task images exist only in the database.
const withoutImages = (lesson) => lesson && { ...lesson, tasks: lesson.tasks.map(({ imagePath, ...task }) => task) };

async function sameAsJson(app, label) {
  assert.deepEqual(await app.getGlobalPrinciples(), json.getGlobalPrinciples(), `${label}: principles`);
  assert.deepEqual(await app.getCourseOverview(), json.getCourseOverview(), `${label}: overview`);
  assert.deepEqual(withoutImages(await app.getFirstLesson()), json.getFirstLesson(), `${label}: first lesson`);
  const lessons = (await app.getAllLessons()).map(withoutImages);
  assert.deepEqual(lessons, json.getAllLessons(), `${label}: all lessons`);
  for (const { code } of lessons) {
    assert.deepEqual(withoutImages(await app.getLessonByCode(code)), json.getLessonByCode(code), `${label}: ${code}`);
    assert.deepEqual(withoutImages(await app.getNextLesson(code)), json.getNextLesson(code), `${label}: next after ${code}`);
  }
  assert.equal(await app.getLessonByCode(' 1b '), lessons.find((l) => l.code === '1B') && (await app.getLessonByCode('1B')), `${label}: code matching ignores case/spaces`);
  assert.equal(await app.getLessonByCode('nope'), undefined);
  assert.equal(await app.getNextLesson('5'), undefined, `${label}: nothing after the last lesson`);
  return lessons.length;
}

async function main() {
  assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY, 'Supabase credentials must be set in .env.local');

  const live = loadTs(indexPath);
  assert.equal(await live.getCurriculumSource(), 'supabase', 'with Supabase reachable the app reads from it');
  const count = await sameAsJson(live, 'supabase');

  // Unreachable database (connection refused): same lessons, from the JSON.
  const realUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
  const quiet = console.error;
  console.error = () => {};
  try {
    const offline = loadTs(indexPath);
    const started = Date.now();
    assert.equal(await offline.getCurriculumSource(), 'json', 'Supabase down → JSON fallback');
    assert.ok(Date.now() - started < 6000, 'the fallback does not hang');
    const lookups = Date.now();
    await sameAsJson(offline, 'fallback');
    assert.ok(Date.now() - lookups < 2000, 'during an outage lookups reuse the fallback instead of waiting on Supabase again');
  } finally {
    console.error = quiet;
    process.env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
  }

  console.log(`curriculum source: app reads ${count} lessons from Supabase, identical to the JSON; falls back to the JSON when Supabase is down`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
