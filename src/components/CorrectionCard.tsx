"use client";

import type { TutorResponse } from "@/core/ai/TutorResponse";
import { pronunciationHandlers } from "./pronunciationPlayback";

export function CorrectionCard({ correction }: { correction: NonNullable<TutorResponse["correction"]> }) {
  const { speakNormal, speakSlow } = pronunciationHandlers(correction.corrected);

  return (
    <div className="correction-card">
      <div className="row">
        <span className="icon">❌</span>
        <span>Você disse: {correction.studentSaid}</span>
      </div>
      <div className="row">
        <span className="icon">✅</span>
        <span>Forma correta: {correction.corrected}</span>
      </div>
      <div className="row">
        <button type="button" className="pronunciation-btn" onClick={speakNormal} title="Ouvir na velocidade normal">
          🔊 Normal
        </button>
        <button type="button" className="pronunciation-btn" onClick={speakSlow} title="Ouvir devagar, sílaba por sílaba">
          🐢 Devagar
        </button>
      </div>
      <div className="row">
        <span className="icon">💡</span>
        <span>{correction.explanation}</span>
      </div>
      {correction.pronunciation && (
        <div className="row">
          <span className="icon">🗣️</span>
          <span>Como pronunciar: {correction.pronunciation}</span>
        </div>
      )}
    </div>
  );
}
