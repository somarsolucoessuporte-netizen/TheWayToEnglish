"use client";

import { useMemo, useState } from "react";
import { branding } from "@/app-config/branding";
import type { CurriculumLesson } from "@/app-config/curriculum";

/**
 * Initial "pick a lesson" screen (see page.tsx) — the entry point at "/"
 * whenever there's no ?licao= in the URL, replacing the old flat list of
 * demo-student names with a real grid of every lesson in the curriculum,
 * grouped by book. Every label rendered here (book name, lesson code,
 * lesson title) is exactly what app-config/curriculum already carries —
 * `lesson.book` / `lesson.code` / `lesson.title` — never translated or
 * reformatted, so this never drifts from the curriculum's own naming.
 */
export function LessonGrid({
  lessons,
  onPick,
}: {
  lessons: CurriculumLesson[];
  onPick: (lesson: CurriculumLesson) => void;
}) {
  // Preserves first-appearance order from the curriculum data rather than
  // sorting alphabetically — there's currently exactly one book, but this
  // stays correct the moment a second book's JSON is added to
  // app-config/curriculum/index.ts.
  const books = useMemo(() => {
    const seen: string[] = [];
    for (const lesson of lessons) if (!seen.includes(lesson.book)) seen.push(lesson.book);
    return seen;
  }, [lessons]);

  const [activeBook, setActiveBook] = useState(books[0]);
  // Falls back to the first book if `activeBook` ever isn't in the current
  // list (only possible if `lessons` itself changes shape at runtime,
  // which it doesn't today) — avoids rendering an empty grid.
  const currentBook = books.includes(activeBook) ? activeBook : books[0];
  const visibleLessons = lessons.filter((lesson) => lesson.book === currentBook);

  return (
    <div className="lesson-grid-screen">
      <header className="lesson-grid-header">
        <div className="brand">
          <div className="dot" />
          <div className="brand-text">
            <div className="title">{branding.productName}</div>
            <div className="subtitle">{branding.companyName}</div>
          </div>
        </div>
        {books.length > 1 && (
          <div className="book-tabs">
            {books.map((book) => (
              <button
                key={book}
                type="button"
                className={`book-tab${book === currentBook ? " active" : ""}`}
                onClick={() => setActiveBook(book)}
              >
                {book}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="lesson-grid">
        {visibleLessons.map((lesson) => (
          <button
            key={lesson.code}
            type="button"
            className="lesson-card"
            onClick={() => onPick(lesson)}
          >
            <span className="lesson-card-code">{lesson.code}</span>
            <span className="lesson-card-title">{lesson.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
