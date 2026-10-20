const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Lessons are identified by book + unit + code (codes repeat: Book 2 /
// Unit 1 has its own 1A). Checks the lookups (grid, chat, deep link) and the
// student-screen picture: it follows the item being asked, changes when the
// tutor moves on and disappears for an item without one.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(filename), name);
    if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
    return loadTs(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const root = path.resolve(__dirname, '..');
const { getAllLessons } = loadTs(path.join(root, 'src/app-config/curriculum/json-source.ts'));
const { findLessonByRef, findLessonFromLink, nextLessonAfter } = loadTs(path.join(root, 'src/app-config/curriculum/lookup.ts'));
const lessons = getAllLessons();

const ids = lessons.map((l) => l.id);
assert.equal(new Set(ids).size, ids.length, 'every lesson id is unique');
assert.ok(lessons.filter((l) => l.code === '1A').length >= 2, 'the material really repeats 1A');

// Lookups by id / bare code.
assert.equal(findLessonByRef(lessons, 'book02-unit01-1a').book, 'Book 2');
assert.equal(findLessonByRef(lessons, 'BOOK02-UNIT01-1A ').unit, 'Unit 1');
assert.equal(findLessonByRef(lessons, '1a').id, 'book01-unit01-1a', 'a bare code is Book 1\'s');
assert.equal(findLessonByRef(lessons, '11A').id, 'book01-unit03-11a', 'a code only one unit has resolves to it');
assert.equal(nextLessonAfter(lessons, 'book01-unit01-5').id, 'book01-unit02-6a', 'next crosses into the next unit');
assert.equal(nextLessonAfter(lessons, 'book01-unit02-10').id, 'book01-unit03-11a', 'Unit 2 sits between Units 1 and 3');
assert.equal(nextLessonAfter(lessons, 'book02-unit01-1a').id, 'book02-unit01-1b', 'next stays in Book 2');

// The school's deep link.
assert.equal(findLessonFromLink(lessons, { book: '2', unit: '1', licao: '1A' }).id, 'book02-unit01-1a');
assert.equal(findLessonFromLink(lessons, { book: '2', unit: '2', licao: '6a' }).id, 'book02-unit02-6a');
assert.equal(findLessonFromLink(lessons, { licao: '1A' }).id, 'book01-unit01-1a', '?licao=1A alone = Book 1 / Unit 1');
assert.equal(findLessonFromLink(lessons, { licao: '6A' }).id, 'book01-unit02-6a', 'a code Unit 1 lacks resolves in course order (Book 1 first)');
assert.equal(findLessonFromLink(lessons, { book: '1', unit: '2', licao: '6A' }).id, 'book01-unit02-6a');
assert.equal(findLessonFromLink(lessons, { book: '1', unit: '6', licao: '6A' }), undefined, 'a unit that does not exist');

// Book 1 / Unit 2 writes one lesson for two codes ("Lessons 7C and 7D").
const sevenCD = findLessonByRef(lessons, 'book01-unit02-7c-and-7d');
assert.equal(sevenCD.code, '7C and 7D');
assert.equal(findLessonFromLink(lessons, { book: '1', unit: '2', licao: '7C' }), sevenCD, 'either code opens it');
assert.equal(findLessonFromLink(lessons, { book: '1', unit: '2', licao: '7d' }), sevenCD);
assert.equal(findLessonFromLink(lessons, { book: '2', unit: '2', licao: '7C' }).id, 'book02-unit02-7c', 'Book 2 keeps its own 7C');

// Every lesson carries its unit's principles (inherited ones flagged).
const b2 = findLessonByRef(lessons, 'book02-unit02-6a');
assert.ok(b2.globalPrinciples.length > 0, 'Book 2 / Unit 2 inherits the principles');
assert.equal(b2.principlesInheritedFrom, 'Book 1 / Unit 1');
assert.equal(findLessonByRef(lessons, 'book01-unit01-1a').principlesInheritedFrom, undefined);

// The picture on the student's screen.
const { currentItemImages } = loadTs(path.join(root, 'src/components/LessonImage.tsx'));
const tutor = (response) => ({ role: 'tutor', response: { speech: { english: 'x', portuguese: '' }, ...response } });
const student = { role: 'user', text: 'y' };
assert.equal(currentItemImages([]), null);
assert.deepEqual(currentItemImages([tutor({ item: 'task-2-item-1', itemImages: ['u1'] })]), ['u1'], 'asking an item shows its picture');
assert.deepEqual(
  currentItemImages([tutor({ item: 'task-2-item-1', itemImages: ['u1'] }), student, tutor({ praise: false })]),
  ['u1'],
  'a correction with no item keeps it'
);
assert.deepEqual(
  currentItemImages([tutor({ item: 'task-2-item-1', itemImages: ['u1'] }), student, tutor({ item: 'task-2-item-2', itemImages: ['u2'] })]),
  ['u2'],
  'the next item changes it'
);
assert.equal(
  currentItemImages([tutor({ item: 'task-2-item-1', itemImages: ['u1'] }), student, tutor({ item: 'task-3-item-1', itemImages: null })]),
  null,
  'an item without a picture clears it'
);
assert.equal(
  currentItemImages([tutor({ item: 'task-2-item-6', itemImages: ['u6'] }), student, tutor({ completedGoals: ['task-2'] })]),
  null,
  'finishing the picture\'s task clears it'
);

console.log(`lesson lookup: ${lessons.length} unique ids; bare codes = Book 1; deep link with book/unit; picture follows the item`);
