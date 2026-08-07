"use client";

import type { TutorResponse } from "@/core/ai/TutorResponse";
import { pronunciationHandlers } from "./pronunciationPlayback";

/**
 * Mobile's compact correction display — no explanation text, because the
 * explanation was already SPOKEN in Portuguese by the tutor (see
 * persona.ts's CORRECTING A MISTAKE); repeating it in writing here would
 * just be redundant clutter on a screen built around listening, not
 * reading. The full CorrectionCard (with explanation + pronunciation hint)
 * stays available in the "💬 Conversa" sheet for anyone who wants to reread it.
 */
export function MiniCorrectionCard({ correction }: { correction: NonNullable<TutorResponse["correction"]> }) {
  const { speakNormal, speakSlow } = pronunciationHandlers(correction.corrected);

  return (
    <div className="mini-correction">
      <span className="mini-correction-words">
        <span className="mini-correction-wrong">❌ {correction.studentSaid}</span>
        <span className="mini-correction-arrow">→</span>
        <span className="mini-correction-right">✅ {correction.corrected}</span>
      </span>
      <span className="mini-correction-buttons">
        <button type="button" className="pronunciation-btn" onClick={speakNormal} title="Ouvir na velocidade normal">
          🔊
        </button>
        <button type="button" className="pronunciation-btn" onClick={speakSlow} title="Ouvir devagar">
          🐢
        </button>
      </span>
    </div>
  );
}
