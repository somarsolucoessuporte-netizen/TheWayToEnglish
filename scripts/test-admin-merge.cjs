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

console.log('admin merge: hand-edited fields and status are preserved on .docx import');
