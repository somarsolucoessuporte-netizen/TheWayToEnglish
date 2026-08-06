"use client";

import { useState } from "react";
import { branding } from "@/app-config/branding";

/** "normal" = discrete icon (default / just interacted). "expanded" = hint
 * text visible with a soft pulse, after 8s of post-speech idle silence.
 * "blinking" = expanded + 3 opacity flashes, after 15s — see page.tsx's
 * idle timer, which owns the transitions between these based on
 * characterState. */
export type TipsAttention = "normal" | "expanded" | "blinking";

/** Shows the tutor's real-time hint for the question she just asked (see
 * TutorResponse.hint / persona.ts's HINTS section) — not a static per-lesson
 * tip list. Tracks the conversation turn by turn: the button hides itself
 * whenever the current turn has no hint. */
export function TipsPanel({
  hint,
  attention,
  onBlinkEnd,
}: {
  hint: string | undefined;
  attention: TipsAttention;
  onBlinkEnd: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!hint) return null;

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
        aria-label="Dica da pergunta atual"
        title="Dica da pergunta atual"
      >
        💡{expanded && <span>{branding.copy.tipsAttentionPrompt}</span>}
      </button>

      {open && (
        <div className="tips-overlay" onClick={() => setOpen(false)}>
          <div className="tips-card" onClick={(e) => e.stopPropagation()}>
            <div className="tips-card-header">
              <div className="tips-card-title">Dica</div>
              <button
                type="button"
                className="tips-card-close"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <p className="tips-hint-text">{hint}</p>
          </div>
        </div>
      )}
    </>
  );
}
