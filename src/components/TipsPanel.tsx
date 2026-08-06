"use client";

import { useState } from "react";
import type { CurriculumLesson } from "@/app-config/curriculum";
import { branding } from "@/app-config/branding";

/** "normal" = discrete icon (default / just interacted). "expanded" = hint
 * text visible with a soft pulse, after 8s of post-speech idle silence.
 * "blinking" = expanded + 3 opacity flashes, after 15s — see page.tsx's
 * idle timer, which owns the transitions between these based on
 * characterState. */
export type TipsAttention = "normal" | "expanded" | "blinking";

export function TipsPanel({
  lesson,
  attention,
  onBlinkEnd,
}: {
  lesson: CurriculumLesson | undefined;
  attention: TipsAttention;
  onBlinkEnd: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!lesson || lesson.tips.length === 0) return null;

  const expanded = attention !== "normal";

  return (
    <>
      <button
        type="button"
        className={expanded ? `tips-btn-expanded${attention === "blinking" ? " tips-btn-blinking" : ""}` : "tips-button"}
        onClick={() => setOpen(true)}
        onAnimationEnd={(e) => {
          // Only the finite blink-attention animation ever fires this
          // (pulse-gold repeats forever, so it never reaches "end") —
          // settle back to the plain expanded look once the 3 flashes finish.
          if (e.animationName === "blink-attention") onBlinkEnd();
        }}
        aria-label="Dicas da lição"
        title="Dicas da lição"
      >
        💡{expanded && <span>{branding.copy.tipsAttentionPrompt}</span>}
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
