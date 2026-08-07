"use client";

import type { ChatEntry } from "@/core/conversation/orchestrator";
import { LessonProgressBar } from "./LessonProgressBar";

/** Local, not imported from LessonTimer — this component stays self-
 * contained on purpose (see the "only touch the lesson-completion
 * component" constraint this redesign was built under). */
function formatMMSS(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Shown over the chat panel once the lesson is complete (see page.tsx —
 * every can-do goal demonstrated, OR the session timer reaching 0).
 * `entries`/`canDoGoals` feed the same LessonProgressBar used under the
 * time bar during the lesson, so this shows the REAL step count at the
 * moment of completion — e.g. "3 de 5" if time ran out before every goal
 * was demonstrated, not always a full bar.
 */
export function LessonCompleteCard({
  studentName,
  lessonCode,
  lessonTitle,
  entries,
  canDoGoals,
  elapsedSeconds,
  onClose,
}: {
  studentName: string;
  lessonCode: string;
  lessonTitle: string;
  entries: ChatEntry[];
  canDoGoals: string[];
  elapsedSeconds: number;
  onClose: () => void;
}) {
  return (
    <div className="lesson-complete-overlay">
      <div className="lesson-complete-card">
        <div className="lesson-complete-title">🎉 Lição concluída!</div>
        <div className="lesson-complete-lesson">
          {studentName}, você completou:
          <br />
          Lição {lessonCode} — {lessonTitle}
        </div>
        <LessonProgressBar entries={entries} canDoGoals={canDoGoals} />
        <div className="lesson-complete-meta">Tempo: {formatMMSS(elapsedSeconds)}</div>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Próxima aula →
        </button>
      </div>
    </div>
  );
}
