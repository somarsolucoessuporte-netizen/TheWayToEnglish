import type { CurriculumLesson } from "@/app-config/curriculum";

export function CurrentLessonLabel({ lesson }: { lesson: CurriculumLesson | undefined }) {
  if (!lesson) return null;
  return (
    <div className="current-lesson-label" aria-label="Current book and lesson">
      <span>{lesson.book}</span>
      <span aria-hidden="true">·</span>
      <strong>Lesson {lesson.lessonCode}</strong>
    </div>
  );
}
