const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// /admin's .docx upload must never silently overwrite a lesson field that
// was corrected by hand (lessons.edited_fields), must never touch status of
// an existing lesson, and must never delete a lesson missing from the docx.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

const { planLessonMerge, DOCX_LESSON_FIELDS } = loadTs(path.resolve(__dirname, '../src/lib/admin/mergeLessons.ts'));

const docxLesson = (code, extra = {}) => ({
  code,
  title: `Title ${code}`,
  skill: 'SPEAKING',
  order: 1,
  tasks: [{ order: 1, instruction: `new ${code}`, type: 'drill' }],
  referenceContent: { dialogues: [], vocabulary: [] },
  requiresImages: false,
  ...extra,
});

const existing = [
  { id: 'id-a', code: 'A', edited_fields: [] },
  { id: 'id-b', code: 'B', edited_fields: ['legacy_tasks', 'title', 'status'] },
  { id: 'id-old', code: 'OLD', edited_fields: null },
];

const plan = planLessonMerge(existing, [docxLesson('A'), docxLesson('B', { imageNote: 'img' }), docxLesson('NEW')]);

// New lesson: inserted as pendente with every docx field.
assert.equal(plan.inserts.length, 1);
assert.equal(plan.inserts[0].code, 'NEW');
assert.equal(plan.inserts[0].status, 'pendente');
assert.deepEqual(Object.keys(plan.inserts[0]).sort(), [...DOCX_LESSON_FIELDS, 'code', 'status'].sort());

// Untouched lesson: all docx fields rewritten, status never part of an update.
const a = plan.updates.find((u) => u.code === 'A');
assert.deepEqual(Object.keys(a.values).sort(), [...DOCX_LESSON_FIELDS].sort());
assert.deepEqual(a.protectedFields, []);
assert.equal(a.values.legacy_tasks[0].instruction, 'new A');
for (const u of plan.updates) assert.ok(!('status' in u.values), `${u.code}: status is never overwritten`);

// Hand-edited lesson: edited fields are left out, the rest is updated.
const b = plan.updates.find((u) => u.code === 'B');
assert.equal(b.id, 'id-b');
assert.ok(!('legacy_tasks' in b.values), 'edited legacy_tasks must not be overwritten');
assert.ok(!('title' in b.values), 'edited title must not be overwritten');
assert.equal(b.values.image_note, 'img', 'non-edited fields still follow the docx');
assert.deepEqual(b.protectedFields.sort(), ['legacy_tasks', 'title']);

// Lesson only in the DB: reported, not deleted.
assert.deepEqual(plan.missingFromDocx, ['OLD']);

// Missing optional docx fields become null (the column is cleared, not left stale).
assert.equal(a.values.practice_note, null);
assert.equal(a.values.image_note, null);

// Task images uploaded in /admin survive a .docx re-import (matched by order).
const withImages = planLessonMerge(
  [{ id: 'id-c', code: 'C', edited_fields: [], legacy_tasks: [
    { order: 1, instruction: 'old', type: 'drill', imagePath: 'book01/unit01/C/task-1.png' },
    { order: 3, instruction: 'gone', type: 'drill', imagePath: 'book01/unit01/C/task-3.png' },
  ] }],
  [docxLesson('C', { tasks: [
    { order: 1, instruction: 'rewritten', type: 'drill' },
    { order: 2, instruction: 'new', type: 'drill' },
  ] })]
).updates[0].values.legacy_tasks;
assert.deepEqual(withImages, [
  { order: 1, instruction: 'rewritten', type: 'drill', imagePath: 'book01/unit01/C/task-1.png' },
  { order: 2, instruction: 'new', type: 'drill' },
], 'imagePath follows the task order; text comes from the docx; dropped tasks drop their image');

const { carryImagePaths, stripImagePaths } = loadTs(path.resolve(__dirname, '../src/lib/admin/mergeLessons.ts'));
const stored = [{ order: 1, instruction: 'x', type: 't', imagePath: 'p/task-1.png' }];
assert.deepEqual(stripImagePaths(stored), [{ order: 1, instruction: 'x', type: 't' }]);
assert.deepEqual(carryImagePaths(stripImagePaths(stored), stored), stored, 'JSON editor round-trip keeps the image');
assert.deepEqual(carryImagePaths([{ order: 1, instruction: 'x', type: 't', imagePath: 'forged' }], []),
  [{ order: 1, instruction: 'x', type: 't' }], 'imagePath typed into the JSON editor is ignored');

// The school's "no task" note (red) reaches the tutor with the practice
// note; the lesson's original text goes to source_excerpt.
const noTask = planLessonMerge([], [docxLesson('11C', { tasks: [], practiceNote: 'Pratique 2x.', noTasksNote: 'Sem tarefa oral nessa lição.', sourceExcerpt: 'Lesson 11C\n[VERMELHO] Sem tarefa' })]).inserts[0];
assert.equal(noTask.practice_note, 'Pratique 2x.\nSem tarefa oral nessa lição.');
assert.equal(noTask.source_excerpt, 'Lesson 11C\n[VERMELHO] Sem tarefa');

// ajustes-escola.json marks, never rewrites: a task off, items and the lesson
// flagged "verificar com a escola"; what it can't find is reported.
const { applySchoolAdjustments } = loadTs(path.resolve(__dirname, '../src/lib/admin/mergeLessons.ts'));
const lessons = [docxLesson('6A', { tasks: [
  { order: 2, instruction: 'describe', type: 'x', items: [{ prompt: 'Joel – hug Mirna', expectedAnswer: 'Joel is hugging Mirna.' }] },
  { order: 3, instruction: 'show a picture', type: 'x', items: [] },
] })];
const missing = applySchoolAdjustments(lessons, {
  '6A': {
    schoolChecks: ['título'],
    tasks: [
      { order: 3, disabled: 'sem fotos do aluno' },
      { order: 2, items: [{ match: 'hugging', schoolCheck: 'confirmar' }, { match: 'nope', schoolCheck: 'x' }] },
    ],
  },
  '9Z': { schoolChecks: ['x'] },
});
assert.equal(lessons[0].tasks[1].disabled, true);
assert.equal(lessons[0].tasks[1].disabledReason, 'sem fotos do aluno');
assert.equal(lessons[0].tasks[0].items[0].schoolCheck, 'confirmar');
assert.equal(lessons[0].tasks[0].items[0].expectedAnswer, 'Joel is hugging Mirna.', 'the school text is kept as written');
assert.deepEqual(lessons[0].referenceContent.schoolChecks, ['título']);
assert.deepEqual(missing, ['6A task-2: item "nope" não encontrado', '9Z: lição não encontrada']);

// The real adjustments file matches the material as processed.
const adjustments = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/app-config/curriculum/ajustes-escola.json'), 'utf8'));
const sixA = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/app-config/curriculum/book02-unit02.json'), 'utf8')).lessons.find((l) => l.code === '6A');
assert.equal(adjustments['book02/unit02']['6A'].tasks[0].order, 3);
assert.equal(sixA.tasks[2].disabled, true, '6A task 3 is off in the loaded JSON');

console.log('admin merge: hand-edited fields, status and task images are preserved on .docx import; school adjustments only mark');
