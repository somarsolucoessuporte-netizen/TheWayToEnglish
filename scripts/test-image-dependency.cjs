const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

// Lessons that "show images": per-task classification (oral / visual /
// image-only — see CurriculumTask.imageDependency) plus the pictures each
// item carries (CurriculumItem.imagePath, cut from the school's .docx).
// Checks:
//   - every unit JSON carries exactly what processar-unit.py's classifier
//     produces for its tasks (so the next unit comes out classified the
//     same way);
//   - a task runs when it needs no picture, or has one to show; image-only
//     without a picture and disabled tasks are out of the progress
//     denominator (canDo);
//   - "Usar imagem" off (task or item) means no picture on screen;
//   - a lesson with no playable task is flagged unplayable.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
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

const curriculumDir = path.resolve(__dirname, '../src/app-config/curriculum');
const unitFiles = fs.readdirSync(curriculumDir).filter((f) => /^book\d+-unit\d+\.json$/.test(f));
assert.ok(unitFiles.length >= 6, 'one JSON per loaded unit');

// 1. JSON == the Python classifier, task by task, in every unit.
const tasks = unitFiles.flatMap((f) => JSON.parse(fs.readFileSync(path.join(curriculumDir, f), 'utf8')).lessons.flatMap((l) => l.tasks));
const pyInput = tasks.map((t) => [t.instruction, (t.items ?? []).some((i) => i.imagePath)]);
const pyOut = execFileSync('python', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pu", r"${path.resolve(__dirname, 'processar-unit.py')}")
pu = importlib.util.module_from_spec(spec); spec.loader.exec_module(pu)
print(json.dumps([pu.classify_image_dependency(t, has) for t, has in json.loads(sys.stdin.buffer.read().decode("utf-8"))]))
`], { input: JSON.stringify(pyInput), encoding: 'utf8' });
assert.deepEqual(tasks.map((t) => t.imageDependency), JSON.parse(pyOut), 'every task in the unit JSON must match processar-unit.py\'s classification');

// 2. Book 1 / Unit 1, the lessons that ran before pictures existed.
const unit = JSON.parse(fs.readFileSync(path.join(curriculumDir, 'book01-unit01.json'), 'utf8'));
const byCode = Object.fromEntries(unit.lessons.map((l) => [l.code, l]));
const dep = (code) => byCode[code].tasks.map((t) => t.imageDependency);
const pictures = (code) => byCode[code].tasks.map((t) => (t.items ?? []).filter((i) => i.imagePath).length);
assert.deepEqual(dep('A'), ['visual', 'image-only'], 'A: the symbols table is shown; "identify the symbol" names no picture of its own');
assert.deepEqual(pictures('A'), [8, 0], 'A: one picture per symbol in task 1');
assert.deepEqual(dep('B'), ['visual', 'visual'], 'B: "A IA mostra as imagens" — but the .docx has none (school question 7)');
assert.deepEqual(pictures('B'), [0, 0]);
assert.deepEqual(dep('4C'), ['visual'], '4C: a/an sentences about the 4AB characters');
assert.deepEqual(pictures('2F').slice(3, 5), [4, 8], '2F: the 4 crops of the Jesus picture, the 8 people of the table');

const { getLessonByCode, playableTasks, itemImagePaths, taskShowsImages } = loadTs(path.join(curriculumDir, 'json-source.ts'));
assert.deepEqual(getLessonByCode('A').canDo, ['task-1'], 'image-only without a picture is not in the denominator');
assert.deepEqual(getLessonByCode('B').canDo, ['task-1', 'task-2'], 'visual without a picture still runs (spoken practice)');
assert.deepEqual(getLessonByCode('4E').canDo, ['task-1', 'task-2']);
for (const l of unit.lessons) assert.equal(getLessonByCode(l.code).playable, true, `${l.code} must still be playable`);

// 3. Book 2 / Unit 2 6A: pictures per item, task 3 off until the school decides.
const sixA = getLessonByCode('book02-unit02-6a');
assert.equal(sixA.code, '6A');
assert.deepEqual(sixA.canDo, ['task-1', 'task-2'], '6A task 3 (a photo from the student\'s phone) is disabled');
assert.equal(sixA.tasks[1].items.length, 6);
assert.deepEqual(
  sixA.tasks[1].items.map((i) => i.imagePath),
  [1, 2, 3, 4, 5, 6].map((m) => `book02/unit02/6A/task-2-item-${m}.png`),
  '6A task 2: each cue with its own picture'
);
assert.equal(sixA.tasks[1].items[2].expectedAnswer, 'Joel is hugging Mirna.');

// 4. The rules themselves.
const item = { prompt: 'x', expectedAnswer: null, imagePath: 'b/u/l/task-1-item-1.png' };
const task = (extra) => ({ order: 1, instruction: 'x', type: 'other', items: [item], ...extra });
assert.deepEqual(itemImagePaths(task({ imageDependency: 'visual' }), item), ['b/u/l/task-1-item-1.png']);
assert.deepEqual(itemImagePaths(task({ imageDependency: 'oral' }), item), [], 'task "Usar imagem" off = no picture');
assert.deepEqual(itemImagePaths(task({ imageDependency: 'visual' }), { ...item, useImage: false }), [], 'item "Usar imagem" off = no picture');
assert.equal(taskShowsImages(task({ imageDependency: 'image-only' })), true);
assert.equal(playableTasks([task({ imageDependency: 'image-only' })]).length, 1, 'image-only with a picture runs');
assert.equal(playableTasks([task({ imageDependency: 'image-only', items: [] })]).length, 0, 'image-only without one does not');
assert.equal(playableTasks([task({ imageDependency: 'visual', disabled: true })]).length, 0, 'a disabled task never runs');
assert.equal(playableTasks([{ order: 1, instruction: 'x', type: 'other' }]).length, 1, 'missing field = oral');

console.log(`PASS: image dependency — ${tasks.length} tasks in ${unitFiles.length} units match processar-unit.py; pictures per item; canDo/playable; "Usar imagem"; disabled tasks`);
