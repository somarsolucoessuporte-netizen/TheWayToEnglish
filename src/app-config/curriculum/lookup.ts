import type { CurriculumLesson } from "./json-source";

// Lesson lookups over an already-loaded list — shared by the sources
// (json-source.ts, index.ts) and client code (TutorApp), which receives the
// lessons from the server instead of reading a source.
//
// A lesson is identified by book + unit + code: its id, "book02-unit01-1a".
// Codes repeat across units (Book 2 / Unit 1 has its own 1A), so a bare code
// — the old ?licao=1A links — means the first lesson with that code in
// course order, which is Book 1's.

function normalize(ref: string): string {
  return ref.trim().toLowerCase();
}

/** The lesson's code is `code`, or one of a combined lesson's codes (Book 1
 * / Unit 2 has "7C and 7D": ?licao=7C opens it). */
function hasCode(lesson: CurriculumLesson, code: string): boolean {
  const own = lesson.code.toLowerCase();
  return own === code || own.split(/\s+and\s+/).includes(code);
}

/** By id, or by bare code (first match in list order). */
export function findLessonByRef(lessons: CurriculumLesson[], ref: string): CurriculumLesson | undefined {
  const normalized = normalize(ref);
  return lessons.find((l) => l.id === normalized) ?? lessons.find((l) => hasCode(l, normalized));
}

/** Old name of findLessonByRef. */
export const findLessonByCode = findLessonByRef;

/** The school's deep link: ?book=2&unit=1&licao=1A. Without book/unit,
 * ?licao=1A is Book 1 / Unit 1 (the links that already exist), then any
 * unit with that code. */
export function findLessonFromLink(
  lessons: CurriculumLesson[],
  link: { book?: string | null; unit?: string | null; licao: string }
): CurriculumLesson | undefined {
  const code = normalize(link.licao);
  const number = (value?: string | null) => {
    const n = Number(String(value ?? "").match(/\d+/)?.[0]);
    return Number.isFinite(n) && n > 0 ? String(n).padStart(2, "0") : undefined;
  };
  const book = number(link.book);
  const unit = number(link.unit);
  const inScope = lessons.filter(
    (l) => (!book || l.bookCode === `book${book}`) && (!unit || l.unitCode === `unit${unit}`)
  );
  if (book || unit) return inScope.find((l) => hasCode(l, code));
  return lessons.find((l) => l.id === `book01-unit01-${code}`) ?? findLessonByRef(lessons, code);
}

/** The lesson right after `ref` in list order; undefined if `ref` isn't
 * found or is the last one. */
export function nextLessonAfter(lessons: CurriculumLesson[], ref: string): CurriculumLesson | undefined {
  const lesson = findLessonByRef(lessons, ref);
  return lesson ? lessons[lessons.indexOf(lesson) + 1] : undefined;
}
