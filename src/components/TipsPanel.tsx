"use client";

import { useState } from "react";
import type { CurriculumLesson } from "@/app-config/curriculum";
import { branding } from "@/app-config/branding";
import { HintIcon } from "./icons/HintIcon";

/** "normal" = discrete icon (default / just interacted). "expanded" = hint
 * text visible with a soft pulse, after 8s of post-speech idle silence.
 * "blinking" = expanded + 3 opacity flashes, after 15s — see page.tsx's
 * idle timer, which owns the transitions between these based on
 * characterState. */
export type TipsAttention = "normal" | "expanded" | "blinking";

/**
 * Prefers the tutor's real-time 3-level hint ladder for the question she
 * just asked (see TutorResponse.hints / persona.ts's HINTS LADDER
 * section) — falls back to the lesson's fixed tips list whenever the
 * current turn has no hints (e.g. the very first render, before the
 * opening line lands, or any turn the tutor didn't attach any to). Only
 * hides entirely when neither exists.
 *
 * ASKING VS. HELPING (see persona.ts): nothing from `hints` is ever shown
 * until the student clicks — `hintLevel` (owned by page.tsx, reset to 0
 * on every new tutor turn) is how many of the 3 levels are currently
 * revealed, and every click on the button here calls `onHintReveal` to
 * advance it by one AND open the card. That's the whole mechanism that
 * keeps a hint from ever leaking before the student actually asks for it.
 */
export function TipsPanel({
  hints,
  hintLevel,
  onHintReveal,
  lesson,
  attention,
  onBlinkEnd,
}: {
  hints: string[] | undefined;
  hintLevel: number;
  onHintReveal: () => void;
  lesson: CurriculumLesson | undefined;
  attention: TipsAttention;
  onBlinkEnd: () => void;
}) {
  // Fallback list has its own open/close state — it's a static, non-leveled
  // list of lesson-wide tips, unrelated to the per-question reveal ladder
  // below. The ladder's OWN open/closed state is also local (closing it —
  // clicking outside, or the × button — must never itself advance
  // hintLevel, which is owned by page.tsx and only ever moves forward on
  // an actual Dica click); hintLevel additionally gates the ladder content so
  // it can never render revealed hints across a new question even if this
  // stayed true from a previous turn.
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [ladderOpen, setLadderOpen] = useState(false);

  const hasLadder = !!hints && hints.length > 0;
  const fallbackTips = lesson?.tips ?? [];
  if (!hasLadder && fallbackTips.length === 0) return null;

  const expanded = attention !== "normal";

  function handleButtonClick() {
    if (hasLadder) {
      onHintReveal();
      setLadderOpen(true);
    } else {
      setFallbackOpen(true);
    }
  }

  const revealedHints = hasLadder ? hints!.slice(0, hintLevel) : [];
  const hasMoreLevels = hasLadder && hintLevel < hints!.length;
  const ladderTitle = `Dica ${Math.max(1, hintLevel)} de ${hasLadder ? hints!.length : 0}`;

  return (
    <>
      <button
        type="button"
        className={expanded ? `tips-btn-expanded${attention === "blinking" ? " tips-btn-blinking" : ""}` : "tips-button"}
        onClick={handleButtonClick}
        onAnimationEnd={(e) => {
          // Only the finite blink-attention animation ever fires this
          // (pulse-gold repeats forever, so it never reaches "end") —
          // settle back to the plain expanded look once the 3 flashes finish.
          if (e.animationName === "blink-attention") onBlinkEnd();
        }}
        aria-label="Dicas"
        title="Dicas"
      >
        <HintIcon />
        {expanded && <span>{branding.copy.tipsAttentionPrompt}</span>}
      </button>

      {hasLadder && ladderOpen && hintLevel > 0 && (
        <div className="tips-overlay" onClick={() => setLadderOpen(false)}>
          <div className="tips-card" onClick={(e) => e.stopPropagation()}>
            <div className="tips-card-header">
              <div className="tips-card-title">{ladderTitle}</div>
              <button
                type="button"
                className="tips-card-close"
                onClick={() => setLadderOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <ul className="tips-hint-ladder">
              {revealedHints.map((h, i) => (
                <li key={i} className={i === revealedHints.length - 1 ? "tips-hint-latest" : undefined}>
                  {h}
                </li>
              ))}
            </ul>
            {hasMoreLevels ? (
              <button
                type="button"
                className="tips-hint-more"
                onClick={() => {
                  onHintReveal();
                  setLadderOpen(true);
                }}
              >
                Mais uma dica →
              </button>
            ) : (
              <div className="tips-hint-done">É isso — tenta agora!</div>
            )}
          </div>
        </div>
      )}

      {!hasLadder && fallbackOpen && (
        <div className="tips-overlay" onClick={() => setFallbackOpen(false)}>
          <div className="tips-card" onClick={(e) => e.stopPropagation()}>
            <div className="tips-card-header">
              <div className="tips-card-title">Dicas da lição</div>
              <button
                type="button"
                className="tips-card-close"
                onClick={() => setFallbackOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <ul className="tips-list">
              {fallbackTips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
