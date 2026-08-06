"use client";

import { speechProvider } from "@/app-config/providers";
import type { TutorResponse } from "@/core/ai/TutorResponse";

export function CorrectionCard({ correction }: { correction: NonNullable<TutorResponse["correction"]> }) {
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
        <span className="icon">💡</span>
        <span>{correction.explanation}</span>
      </div>
      {correction.pronunciation && (
        <div className="row">
          <button
            type="button"
            className="pronunciation-btn"
            onClick={() => void speechProvider.speak(correction.corrected, { lang: "en-US" })}
            aria-label="Ouvir pronúncia"
            title="Ouvir pronúncia"
          >
            🔊
          </button>
          <span>Como pronunciar: {correction.pronunciation}</span>
        </div>
      )}
    </div>
  );
}
