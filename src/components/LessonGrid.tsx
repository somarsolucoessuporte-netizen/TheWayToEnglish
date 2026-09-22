"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { branding } from "@/app-config/branding";
import type { CurriculumLesson } from "@/app-config/curriculum";

/** First-appearance order (not alphabetical) — matches the curriculum
 * data's own sequence, which already reflects course order. */
function uniqueInOrder(values: string[]): string[] {
  const seen: string[] = [];
  for (const value of values) if (!seen.includes(value)) seen.push(value);
  return seen;
}

type DropdownKey = "book" | "unit" | "lesson";

/**
 * Initial "pick a lesson" screen (see page.tsx) — the entry point at "/"
 * whenever there's no ?licao= in the URL. Three dependent dropdowns
 * (Book, Unit, Lesson), each filtered by whatever was picked above it,
 * plus a Start button that navigates to ?licao=CODE once all three are
 * resolved — a real navigation (window.location.href), not a callback
 * prop, so the existing ?licao=-only auto-start effect in page.tsx (see
 * its own handling of the "Aluno" placeholder for a non-1A lesson) is
 * the ONE code path that ever kicks off a lesson, whether reached from
 * here, a bookmark, or a deep link.
 *
 * Every label (`lesson.book` / `lesson.unit` / `lesson.code` /
 * `lesson.title`) is exactly what app-config/curriculum already
 * carries — never translated or reformatted.
 */
export function LessonGrid({ lessons }: { lessons: CurriculumLesson[] }) {
  const books = useMemo(() => uniqueInOrder(lessons.map((lesson) => lesson.book)), [lessons]);

  // Pre-selected (not skipped) when there's only one book — the dropdown
  // still renders, showing that book already chosen, so the level itself
  // stays visible instead of disappearing.
  const [book, setBook] = useState<string | undefined>(books.length === 1 ? books[0] : undefined);
  const [unit, setUnit] = useState<string | undefined>(undefined);
  const [lessonCode, setLessonCode] = useState<string | undefined>(undefined);
  const [openDropdown, setOpenDropdown] = useState<DropdownKey | null>(books.length === 1 ? "unit" : null);

  const units = useMemo(
    () => (book ? uniqueInOrder(lessons.filter((lesson) => lesson.book === book).map((lesson) => lesson.unit)) : []),
    [lessons, book]
  );

  const lessonsForUnit = useMemo(
    () => (book && unit ? lessons.filter((lesson) => lesson.book === book && lesson.unit === unit) : []),
    [lessons, book, unit]
  );

  const selectedLesson = lessonsForUnit.find((lesson) => lesson.code === lessonCode);

  // Closes whichever dropdown is open on any click outside this screen —
  // selecting an option or picking the next level already closes it, this
  // is just for "clicked away without choosing anything".
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenDropdown(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function toggle(key: DropdownKey) {
    setOpenDropdown((prev) => (prev === key ? null : key));
  }

  function handleBookSelect(nextBook: string) {
    setBook(nextBook);
    setUnit(undefined);
    setLessonCode(undefined);
    setOpenDropdown("unit");
  }

  function handleUnitSelect(nextUnit: string) {
    setUnit(nextUnit);
    setLessonCode(undefined);
    setOpenDropdown("lesson");
  }

  function handleLessonSelect(code: string) {
    setLessonCode(code);
    setOpenDropdown(null);
  }

  function handleStart() {
    if (!selectedLesson) return;
    window.location.href = `/?licao=${encodeURIComponent(selectedLesson.code)}`;
  }

  return (
    <div className="lesson-select-screen">
      <div className="lesson-select-card">
        <div className="brand lesson-select-brand">
          <div className="dot" />
          <div className="brand-text">
            <div className="title">{branding.productName}</div>
            <div className="subtitle">{branding.companyName}</div>
          </div>
        </div>

        <div className="lesson-select-dropdowns" ref={rootRef}>
          <FilterDropdown
            placeholder="Select Book"
            value={book}
            options={books}
            disabled={false}
            open={openDropdown === "book"}
            onToggle={() => toggle("book")}
            onSelect={handleBookSelect}
          />
          <FilterDropdown
            placeholder="Select Unit"
            value={unit}
            options={units}
            disabled={!book}
            open={openDropdown === "unit"}
            onToggle={() => toggle("unit")}
            onSelect={handleUnitSelect}
          />
          <LessonDropdown
            placeholder="Select Lesson"
            value={selectedLesson}
            lessons={lessonsForUnit}
            disabled={!unit}
            open={openDropdown === "lesson"}
            onToggle={() => toggle("lesson")}
            onSelect={handleLessonSelect}
          />
        </div>

        <button
          type="button"
          className="btn btn-primary lesson-select-start"
          disabled={!selectedLesson}
          onClick={handleStart}
        >
          Start
        </button>
      </div>
    </div>
  );
}

function FilterDropdown({
  placeholder,
  value,
  options,
  disabled,
  open,
  onToggle,
  onSelect,
}: {
  placeholder: string;
  value: string | undefined;
  options: string[];
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="lesson-dropdown">
      <button type="button" className="lesson-dropdown-trigger" onClick={onToggle} disabled={disabled}>
        <span className={value ? undefined : "lesson-dropdown-placeholder"}>{value ?? placeholder}</span>
        <span className="lesson-dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="lesson-dropdown-list">
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                className={`lesson-dropdown-option${option === value ? " selected" : ""}`}
                onClick={() => onSelect(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LessonDropdown({
  placeholder,
  value,
  lessons,
  disabled,
  open,
  onToggle,
  onSelect,
}: {
  placeholder: string;
  value: CurriculumLesson | undefined;
  lessons: CurriculumLesson[];
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: (code: string) => void;
}) {
  return (
    <div className="lesson-dropdown">
      <button type="button" className="lesson-dropdown-trigger" onClick={onToggle} disabled={disabled}>
        <span className={value ? undefined : "lesson-dropdown-placeholder"}>
          {value ? `${value.code} — ${value.title}` : placeholder}
        </span>
        <span className="lesson-dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="lesson-dropdown-list">
          {lessons.map((lesson) => (
            <li key={lesson.code}>
              <button
                type="button"
                className={`lesson-dropdown-option${lesson.code === value?.code ? " selected" : ""}`}
                onClick={() => onSelect(lesson.code)}
              >
                <strong>{lesson.code}</strong> — {lesson.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
