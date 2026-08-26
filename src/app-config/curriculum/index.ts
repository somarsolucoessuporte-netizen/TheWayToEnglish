// TODO: migrar para o novo formato JSON (book01-unit01.json) quando
// curriculum/index.ts for refatorado para o novo shape de licao/tarefas.
import book01unit01 from "./book01-unit01.LEGACY.json";

export interface CurriculumLesson {
  id: string;
  book: string;
  unit: string;
  lessonCode: string;
  title: string;
  type: string;
  /** Allotted time for the lesson timer bar (see LessonTimer) — defaults
   * to 15 in every current lesson, but can vary per lesson. */
  durationMinutes: number;
  vocabulary: string[];
  grammarPoints: string[];
  targetPhrases: string[];
  canDo: string[];
  exampleExchanges: { q: string; a: string }[];
  prerequisiteLessonIds: string[];
  notes: string | null;
  cumulativeScope: string[];
  tips: string[];
}

const ALL_LESSONS: CurriculumLesson[] = (book01unit01 as { lessons: CurriculumLesson[] }).lessons;

export function getLessonByCode(code: string): CurriculumLesson | undefined {
  const normalized = code.trim().toLowerCase();
  return ALL_LESSONS.find((l) => l.lessonCode.toLowerCase() === normalized);
}

/** Compact list of every lesson in the course — enough for the tutor to
 * recognize and name a lesson the student references, without teaching it. */
export function getCourseOverview(): { lessonCode: string; title: string }[] {
  return ALL_LESSONS.map((l) => ({ lessonCode: l.lessonCode, title: l.title }));
}

/** The lesson immediately after `code` in the curriculum's own array order
 * (book01-unit01.json's sequence) — not a prerequisite-based recommendation,
 * just positional order. undefined if `code` isn't found or is the last
 * lesson in the course — see orchestrator.announceLessonComplete's doc
 * comment for how the caller handles that case. */
export function getNextLesson(code: string): CurriculumLesson | undefined {
  const normalized = code.trim().toLowerCase();
  const index = ALL_LESSONS.findIndex((l) => l.lessonCode.toLowerCase() === normalized);
  if (index === -1) return undefined;
  return ALL_LESSONS[index + 1];
}
