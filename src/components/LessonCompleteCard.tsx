"use client";

/**
 * Shown over the chat panel once the lesson timer reaches 0 (see page.tsx).
 * Note: the spec's mockup also showed "Etapas: 3 de 5" — this app has no
 * concept of numbered lesson steps/stages anywhere in the curriculum data
 * or UI, so that line was left out rather than inventing a number that
 * doesn't correspond to anything real.
 */
export function LessonCompleteCard({
  lessonCode,
  lessonTitle,
  durationMinutes,
  onClose,
}: {
  lessonCode: string;
  lessonTitle: string;
  durationMinutes: number;
  onClose: () => void;
}) {
  return (
    <div className="lesson-complete-overlay">
      <div className="lesson-complete-card">
        <div className="lesson-complete-title">🎉 Lição concluída!</div>
        <div className="lesson-complete-lesson">
          Lição {lessonCode} — {lessonTitle}
        </div>
        <div className="lesson-complete-meta">Tempo: {durationMinutes}:00</div>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Encerrar
        </button>
      </div>
    </div>
  );
}
