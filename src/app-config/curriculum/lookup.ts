import type { CurriculumLesson } from "./json-source";

// Lesson lookups over an already-loaded list — for client code (TutorApp),
// which receives the lessons from the server instead of reading a source.
// Same matching rules as json-source.ts's getLessonByCode / getNextLesson.

function normalize(code: string): string {
  return code.trim().toLowerCase();
}

export function findLessonByCode(lessons: CurriculumLesson[], code: string): CurriculumLesson | undefined {
  const normalized = normalize(code);
  return lessons.find((l) => l.code.toLowerCase() === normalized);
}

/** The lesson right after `code` in list order; undefined if `code` isn't
 * found or is the last one. */
export function nextLessonAfter(lessons: CurriculumLesson[], code: string): CurriculumLesson | undefined {
  const normalized = normalize(code);
  const index = lessons.findIndex((l) => l.code.toLowerCase() === normalized);
  return index === -1 ? undefined : lessons[index + 1];
}
