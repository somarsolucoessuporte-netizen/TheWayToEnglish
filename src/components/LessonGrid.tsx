"use client";

import { useMemo, useState } from "react";
import { branding } from "@/app-config/branding";
import type { CurriculumLesson } from "@/app-config/curriculum";

/** First-appearance order (not alphabetical) — matches the curriculum
 * data's own sequence, which already reflects course order. */
function uniqueInOrder(values: string[]): string[] {
  const seen: string[] = [];
  for (const value of values) if (!seen.includes(value)) seen.push(value);
  return seen;
}

type Step = "book" | "unit" | "lessons";

/**
 * Initial "pick a lesson" screen (see page.tsx) — the entry point at "/"
 * whenever there's no ?licao= in the URL. Cascading filters: Book, then
 * Unit within that book, then the lesson grid for that unit — every
 * label (`lesson.book` / `lesson.unit` / `lesson.code` / `lesson.title`)
 * is exactly what app-config/curriculum already carries, never
 * translated or reformatted.
 *
 * `book`/`unit` stay remembered even after stepping back to an earlier
 * filter (see backToUnitStep) — that's what lets the previously chosen
 * chip still render `.active` (solid fill) on return, instead of the
 * filter looking reset. Only `step` actually decides what's on screen.
 */
export function LessonGrid({
  lessons,
  onPick,
}: {
  lessons: CurriculumLesson[];
  onPick: (lesson: CurriculumLesson) => void;
}) {
  const books = useMemo(() => uniqueInOrder(lessons.map((lesson) => lesson.book)), [lessons]);

  // Auto-select and skip straight to the unit filter when there's only
  // one book — nothing to actually filter there.
  const [step, setStep] = useState<Step>(books.length === 1 ? "unit" : "book");
  const [book, setBook] = useState<string | undefined>(books.length === 1 ? books[0] : undefined);
  const [unit, setUnit] = useState<string | undefined>(undefined);

  const units = useMemo(
    () => (book ? uniqueInOrder(lessons.filter((lesson) => lesson.book === book).map((lesson) => lesson.unit)) : []),
    [lessons, book]
  );

  const visibleLessons = useMemo(
    () => (book && unit ? lessons.filter((lesson) => lesson.book === book && lesson.unit === unit) : []),
    [lessons, book, unit]
  );

  function pickBook(nextBook: string) {
    setBook(nextBook);
    setUnit(undefined);
    setStep("unit");
  }

  function pickUnit(nextUnit: string) {
    setUnit(nextUnit);
    setStep("lessons");
  }

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
      </header>

      {step === "book" && (
        <div className="filter-step">
          <div className="filter-chip-row">
            {books.map((b) => (
              <button
                key={b}
                type="button"
                className={`filter-chip${b === book ? " active" : ""}`}
                onClick={() => pickBook(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "unit" && (
        <div className="filter-step">
          <div className="filter-chip-row">
            {units.map((u) => (
              <button
                key={u}
                type="button"
                className={`filter-chip${u === unit ? " active" : ""}`}
                onClick={() => pickUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "lessons" && book && unit && (
        <>
          <div className="lesson-grid-breadcrumb">
            <button type="button" className="breadcrumb-link" onClick={() => setStep("unit")}>
              {book}
            </button>
            <span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">{unit}</span>
          </div>
          <div className="lesson-grid">
            {visibleLessons.map((lesson) => (
              <button key={lesson.code} type="button" className="lesson-card" onClick={() => onPick(lesson)}>
                <span className="lesson-card-code">{lesson.code}</span>
                <span className="lesson-card-title">{lesson.title}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
