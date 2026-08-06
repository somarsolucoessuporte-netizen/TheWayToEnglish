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

/**
 * Prefers the tutor's real-time hint for the question she just asked (see
 * TutorResponse.hint / persona.ts's HINTS section) — falls back to the
 * lesson's fixed tips list whenever the current turn has no hint (e.g. the
 * very first render, before the opening line lands, or any turn the tutor
 * didn't attach one to). Only hides entirely when neither exists.
 */
export function TipsPanel({
  hint,
  lesson,
  attention,
  onBlinkEnd,
}: {
  hint: string | undefined;
  lesson: CurriculumLesson | undefined;
  attention: TipsAttention;
  onBlinkEnd: () => void;
}) {
  const [open, setOpen] = useState(false);

  const fallbackTips = lesson?.tips ?? [];
  if (!hint && fallbackTips.length === 0) return null;

  const expanded = attention !== "normal";
  const cardTitle = hint ? "💡 Dica para esta pergunta" : "📚 Dicas da lição";

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
        aria-label="Dicas"
        title="Dicas"
      >
        💡{expanded && <span>{branding.copy.tipsAttentionPrompt}</span>}
      </button>

      {open && (
        <div className="tips-overlay" onClick={() => setOpen(false)}>
          <div className="tips-card" onClick={(e) => e.stopPropagation()}>
            <div className="tips-card-header">
              <div className="tips-card-title">{cardTitle}</div>
              <button
                type="button"
                className="tips-card-close"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            {hint ? (
              <p className="tips-hint-text">{hint}</p>
            ) : (
              <ul className="tips-list">
                {fallbackTips.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
