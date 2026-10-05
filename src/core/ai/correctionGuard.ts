import type { TutorResponse } from "./TutorResponse";

/**
 * A correct answer gets praise + the next instruction — never a correction.
 * The persona says so (see persona.ts's CORRECTION section), but the model
 * still sometimes writes "Great job! The correct way is: SPEAKING. Now…" on
 * a turn it marked as correct itself (praise: true, no correction), which
 * sounds like the student got it wrong. This is the mechanical backstop,
 * used by /api/chat: on such a turn, the "The correct way is: …" sentence is
 * removed (and its Portuguese counterpart, "A forma correta é: …").
 *
 * Only a turn the model itself marked as correct is touched. Anything with a
 * correction — even one that only changes capitalization, since the student
 * may have said the wrong word ("Listening" when SPEAKING was asked) — is a
 * real correction and is left alone.
 */

const ENGLISH_CORRECTION = /(^|\s)the correct (?:way|form|answer) is\b:?[^.!?]*[.!?]?/gi;
// No \b after "é": without the u flag, accented letters aren't word chars.
const PORTUGUESE_CORRECTION = /(^|\s)(?:a forma correta é|o correto é|a resposta correta é)(?=[\s:])[^.!?]*[.!?]?/gi;

function strip(text: string, pattern: RegExp): string {
  return text.replace(pattern, "$1").replace(/\s{2,}/g, " ").trim();
}

export function isPraiseTurn(response: TutorResponse): boolean {
  return response.praise === true && !response.correction;
}

export function removeCorrectionFromPraise(response: TutorResponse): { response: TutorResponse; removed: boolean } {
  if (!isPraiseTurn(response)) return { response, removed: false };
  const english = strip(response.speech.english, ENGLISH_CORRECTION);
  const portuguese = strip(response.speech.portuguese, PORTUGUESE_CORRECTION);
  // Never leave the spoken line empty because of this guard.
  if (!english && response.speech.english.trim()) return { response, removed: false };
  const removed = english !== response.speech.english.trim() || portuguese !== response.speech.portuguese.trim();
  if (!removed) return { response, removed: false };
  return { response: { ...response, speech: { ...response.speech, english, portuguese } }, removed: true };
}
