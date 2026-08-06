"use client";

import { useState } from "react";
import type { CurriculumLesson } from "@/app-config/curriculum";

export function TipsPanel({ lesson }: { lesson: CurriculumLesson | undefined }) {
  const [open, setOpen] = useState(false);

  if (!lesson || lesson.tips.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="tips-button"
        onClick={() => setOpen(true)}
        aria-label="Dicas da lição"
        title="Dicas da lição"
      >
        💡
      </button>

      {open && (
        <div className="tips-overlay" onClick={() => setOpen(false)}>
          <div className="tips-card" onClick={(e) => e.stopPropagation()}>
            <div className="tips-card-header">
              <div className="tips-card-title">
                Dicas — {lesson.lessonCode} {lesson.title}
              </div>
              <button
                type="button"
                className="tips-card-close"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <ul className="tips-list">
              {lesson.tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
