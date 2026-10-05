const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

// The curriculum in Supabase (supabase-source.ts) must be exactly what the
// app serves today from the bundled JSON (index.ts) — every function, every
// lesson, field by field. Run after seed-curriculum.cjs and before switching
// the app to supabase-source. Needs the live database: with no credentials
// in .env.local it FAILS instead of skipping.
//
// Also checks the publishable key sees nothing (RLS on, no public policy).

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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert.ok(url && process.env.SUPABASE_SERVICE_ROLE_KEY && publishableKey,
    'NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');

  const json = loadTs(path.join(root, 'src/app-config/curriculum/index.ts'));
  const db = loadTs(path.join(root, 'src/app-config/curriculum/supabase-source.ts'));

  assert.deepEqual(await db.getGlobalPrinciples(), json.getGlobalPrinciples(), 'global principles');
  assert.deepEqual(await db.getCourseOverview(), json.getCourseOverview(), 'course overview (codes, titles, order)');
  assert.deepEqual(await db.getFirstLesson(), json.getFirstLesson(), 'first lesson');

  const fromDb = await db.getAllLessons();
  const fromJson = json.getAllLessons();
  assert.equal(fromDb.length, fromJson.length, 'lesson count');
  for (let i = 0; i < fromJson.length; i++) {
    const code = fromJson[i].code;
    assert.deepEqual(fromDb[i], fromJson[i], `lesson ${code}: getAllLessons`);
    assert.deepEqual(await db.getLessonByCode(code), json.getLessonByCode(code), `lesson ${code}: getLessonByCode`);
    assert.deepEqual(await db.getNextLesson(code), json.getNextLesson(code), `lesson ${code}: getNextLesson`);
  }
  assert.equal(await db.getLessonByCode('nope'), undefined);
  assert.equal(await db.getNextLesson('nope'), undefined);

  const anon = createClient(url, publishableKey, { auth: { persistSession: false } });
  for (const table of ['books', 'units', 'lessons', 'steps', 'sessions', 'session_events']) {
    const { data } = await anon.from(table).select('*').limit(1);
    assert.deepEqual(data ?? [], [], `${table}: the publishable key must not read anything`);
    const { error } = await anon.from(table).insert({});
    assert.ok(error, `${table}: the publishable key must not write`);
  }

  console.log(`supabase parity: ${fromJson.length} lessons identical to the JSON; RLS blocks the publishable key`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
