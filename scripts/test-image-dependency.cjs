const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

// Lessons that "show images" when the app has none: "What is the symbol for
// SPEAKING?" was unanswerable (the student said "Eu não sei"). Per-task
// classification (oral / visual / image-only) — see
// CurriculumTask.imageDependency. Checks:
//   - the unit JSON carries exactly what processar-unit.py's classifier
//     produces (so the next unit comes out classified the same way);
//   - image-only tasks are out of the progress denominator (canDo);
//   - Lesson B (pure oral practice, proven in a real session) is untouched;
//   - a lesson with no playable task is flagged unplayable.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(filename), name);
    if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
    return loadTs(`${base}.ts`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const unitPath = path.resolve(__dirname, '../src/app-config/curriculum/book01-unit01.json');
const unit = JSON.parse(fs.readFileSync(unitPath, 'utf8'));

// 1. JSON == the Python classifier, task by task.
const instructions = unit.lessons.flatMap((l) => l.tasks.map((t) => t.instruction));
const pyOut = execFileSync('python', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pu", r"${path.resolve(__dirname, 'processar-unit.py')}")
pu = importlib.util.module_from_spec(spec); spec.loader.exec_module(pu)
print(json.dumps([pu.classify_image_dependency(t) for t in json.loads(sys.stdin.buffer.read().decode("utf-8"))]))
`], { input: JSON.stringify(instructions), encoding: 'utf8' });
const fromPython = JSON.parse(pyOut);
const inJson = unit.lessons.flatMap((l) => l.tasks.map((t) => t.imageDependency));
assert.deepEqual(inJson, fromPython, 'every task in the unit JSON must match processar-unit.py\'s classification');

const byCode = Object.fromEntries(unit.lessons.map((l) => [l.code, l]));
const dep = (code) => byCode[code].tasks.map((t) => t.imageDependency);
assert.deepEqual(dep('A'), ['oral', 'image-only'], 'A: repeat the names stays; "identify the symbol" is skipped');
assert.deepEqual(dep('B'), ['oral', 'oral'], 'B: the alphabet drill is pure oral practice');
assert.deepEqual(dep('4C'), ['visual'], '4C: a/an sentences about named characters work orally');
assert.deepEqual(dep('4D'), ['visual', 'image-only'], '4D: the "USAR AS MESMAS IMAGENS" note is not a task');

// 2. Progress denominator and playability.
const { getLessonByCode, playableTasks } = loadTs(path.resolve(__dirname, '../src/app-config/curriculum/index.ts'));
assert.deepEqual(getLessonByCode('A').canDo, ['task-1'], 'image-only tasks are not in the denominator');
assert.deepEqual(getLessonByCode('B').canDo, ['task-1', 'task-2']);
assert.deepEqual(getLessonByCode('4E').canDo, ['task-1', 'task-2']);
for (const l of unit.lessons) assert.equal(getLessonByCode(l.code).playable, true, `${l.code} must still be playable`);
assert.equal(
  playableTasks([{ order: 1, instruction: 'x', type: 'other', imageDependency: 'image-only' }]).length,
  0,
  'a lesson made only of image-only tasks has nothing playable (UI refuses to open it)'
);
assert.equal(playableTasks([{ order: 1, instruction: 'x', type: 'other' }]).length, 1, 'missing field = oral');

console.log('PASS: per-task image dependency — JSON matches processar-unit.py; image-only out of canDo; B untouched; unplayable detection');
