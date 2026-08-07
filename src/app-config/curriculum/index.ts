import book01unit01 from "./book01-unit01.json";

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
