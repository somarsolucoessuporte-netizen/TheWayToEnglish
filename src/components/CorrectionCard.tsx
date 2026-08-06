"use client";

import { speechProvider } from "@/app-config/providers";
import type { TutorResponse } from "@/core/ai/TutorResponse";

export function CorrectionCard({ correction }: { correction: NonNullable<TutorResponse["correction"]> }) {
  const speakNormal = () => void speechProvider.speak(correction.corrected, { lang: "en-US" });
  // Falls back to normal speed if the active SpeechProvider has no real
  // speed control (speakSlow is optional — see SpeechProvider.ts) rather
  // than silently doing nothing on click.
  const speakSlow = () =>
    void (speechProvider.speakSlow
      ? speechProvider.speakSlow(correction.corrected, { lang: "en-US" })
      : speechProvider.speak(correction.corrected, { lang: "en-US" }));

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
