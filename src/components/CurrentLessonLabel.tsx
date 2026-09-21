import type { CurriculumLesson } from "@/app-config/curriculum";

export function CurrentLessonLabel({ lesson }: { lesson: CurriculumLesson | undefined }) {
  if (!lesson) return null;
  return (
    <div className="current-lesson-label" aria-label="Livro e lição atual">
      <span>{lesson.book.replace(/^Book\s+/i, "Livro ")}</span>
      <span aria-hidden="true">·</span>
      <strong>Lição {lesson.lessonCode}</strong>
    </div>
  );
}
