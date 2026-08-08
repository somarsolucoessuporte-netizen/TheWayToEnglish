"use client";

import type { TutorResponse } from "@/core/ai/TutorResponse";
import { pronunciationHandlers } from "./pronunciationPlayback";
import { HintIcon } from "./icons/HintIcon";

export function CorrectionCard({ correction }: { correction: NonNullable<TutorResponse["correction"]> }) {
  const { speakNormal, speakSlow } = pronunciationHandlers(correction.corrected);

  return (
    <div className="correction-card">
      <div className="row">
        <span className="icon icon-wrong">✗</span>
        <span>Você disse: {correction.studentSaid}</span>
      </div>
      <div className="row">
        <span className="icon icon-right">✓</span>
        <span>Forma correta: {correction.corrected}</span>
      </div>
      <div className="row">
        <button type="button" className="pronunciation-btn" onClick={speakNormal} title="Ouvir na velocidade normal">
          Ouvir
        </button>
        <button type="button" className="pronunciation-btn" onClick={speakSlow} title="Ouvir devagar, sílaba por sílaba">
          Devagar
        </button>
      </div>
      <div className="row">
        <span className="icon" aria-hidden="true">
          <HintIcon size={16} />
        </span>
        <span>{correction.explanation}</span>
      </div>
      {correction.pronunciation && (
        <div className="row">
          <span>Como pronunciar: {correction.pronunciation}</span>
        </div>
      )}
    </div>
  );
}
