/**
 * Technical filters applied to a Whisper transcript BEFORE it's treated as
 * the student's answer (see orchestrator's stt "final" handler). Neither
 * one is an evaluation of the student — a transcript caught here never
 * reaches the model as an attempt; the tutor just repeats her instruction.
 */

/**
 * Known Whisper hallucinations on silence / background noise — text from
 * its training data (subtitle credits, video sign-offs), not anything the
 * student said. "Legendas pela comunidade Amara.org" showed up twice as a
 * student answer in a single Lição A session. Matched anywhere in the
 * transcript, except "tchau", which only counts when it's the whole thing
 * (a real student may well say goodbye inside a longer sentence).
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /amara\.org/i,
  /legendas?\s+(pela|por)\b/i,
  /subtitles?\s+by\b/i,
  /obrigad[oa]s?\s+por\s+assistir/i,
  /thanks?\s+(you\s+)?for\s+watching/i,
  /^\s*tchau[\s.!]*$/i,
  /www\.|https?:\/\/|\b[\w-]+\.(com|org|net|br)\b/i,
];

/** Returns the pattern that matched (for the log), or null if clean. */
export function matchWhisperHallucination(transcript: string): string | null {
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(transcript)) return pattern.source;
  }
  return null;
}

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip accents
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

function bigrams(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Drops the practice target from each sentence of the tutor's line —
 * whatever follows a colon ("Repeat after me: Nice to meet you." -> "Repeat
 * after me."). The student is SUPPOSED to say that part back; only her
 * instruction/question wording coming back means the mic heard her. */
function withoutPracticeTargets(tutorLine: string): string {
  return tutorLine.replace(/:[^.!?]*([.!?]|$)/g, "$1");
}

/** Transcripts shorter than this are never treated as echo: a student
 * repeating a single word or short phrase ("Speaking", "Nice to meet you")
 * is SUPPOSED to match what the tutor just said. */
const ECHO_MIN_WORDS = 4;
export const ECHO_SIMILARITY_THRESHOLD = 0.7;

/**
 * How much `transcript` looks like the mic picked up the tutor's own line
 * rather than an answer, 0..1 (case/accent-insensitive, over word
 * bigrams). The max of two measures:
 *   - Dice similarity: the whole line came back (or most of it).
 *   - containment: nearly every bigram of the transcript is in the tutor's
 *     line — a PARTIAL echo (only the end of her sentence got recorded).
 *     Weighted down a bit so a real answer reusing the question's wording
 *     ("The symbol for speaking is a mouth" after "What is the symbol for
 *     speaking?") stays well under the threshold.
 * Returns 0 for transcripts under ECHO_MIN_WORDS words.
 */
export function echoSimilarity(transcript: string, tutorLine: string): number {
  const tw = normalizedWords(transcript);
  if (tw.length < ECHO_MIN_WORDS) return 0;
  const a = bigrams(tw);
  const b = bigrams(normalizedWords(withoutPracticeTargets(tutorLine)));
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of b) pool.set(g, (pool.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of a) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      common++;
      pool.set(g, n - 1);
    }
  }
  const dice = (2 * common) / (a.length + b.length);
  const containment = common / a.length;
  return Math.max(dice, containment === 1 ? 1 : containment * 0.85);
}
