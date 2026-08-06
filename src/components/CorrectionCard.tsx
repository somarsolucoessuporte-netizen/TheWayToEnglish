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
    </div>
  );
}
