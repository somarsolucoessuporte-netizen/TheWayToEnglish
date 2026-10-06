import type { Message } from "./AIProvider";
import type { TutorResponse } from "./TutorResponse";

/**
 * In a repeat drill ("Repeat after me: SPEAKING."), the expected answer is
 * the item the tutor itself asked for. Lessons run from legacy tasks, which
 * carry no per-item expected answer, so the model had to work it out from
 * its own previous line — and on a wrong word ("LISTENING") it corrected
 * the student to the word they SAID: "The correct way is: LISTENING".
 *
 * /api/chat uses this module to (1) read the item back from the tutor's
 * last line and send it as an explicit EXPECTED ANSWER note, and (2) as a
 * mechanical backstop, repoint a correction that still targets what the
 * student said to the item that was asked for.
 */

const ASKED_PATTERNS = [/repeat after me\s*:?\s*([^.!?\n]+)/gi, /now you try\s*:?\s*([^.!?\n]+)/gi];

const QUOTES = /^["'“”‘’\s]+|["'“”‘’\s]+$/g;

function clean(item: string): string {
  return item.replace(QUOTES, "").trim();
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

/** The last item the tutor asked the student to say in `line`, if any. */
export function askedItem(line: string): string | undefined {
  let last: { index: number; item: string } | undefined;
  for (const pattern of ASKED_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const item = clean(match[1]);
      const index = match.index ?? 0;
      if (item && (!last || index > last.index)) last = { index, item };
    }
  }
  return last?.item;
}

/** The item asked for in the tutor's last message, when the conversation
 * ends with the student's reply to it (the turn being answered now). */
export function expectedAnswerFor(conversation: Message[]): string | undefined {
  const last = conversation[conversation.length - 1];
  const previous = conversation[conversation.length - 2];
  if (last?.role !== "user" || previous?.role !== "assistant") return undefined;
  return askedItem(previous.content);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Swaps `from` for `to` right after "The correct way is", "Repeat after
 * me" and "Now you try" — nowhere else in the line. */
function replaceItem(text: string, from: string, to: string): string {
  const item = `["“]?${escapeRegExp(from)}["”]?`;
  const lead = String.raw`(the correct (?:way|form|answer) is\s*:?\s*|repeat after me\s*:?\s*|now you try\s*:?\s*)`;
  return text.replace(new RegExp(lead + item, "gi"), `$1${to}`);
}

/** A turn that corrects the student although what they said IS the
 * expected item (case/punctuation aside) — "Listening" for LISTENING. */
export function correctsAnExpectedAnswer(response: TutorResponse, expected: string | undefined): boolean {
  return !!expected && !!response.correction && normalize(response.correction.studentSaid) === normalize(expected);
}

/** Short drill items only (a symbol, a letter, a word or two): a whole
 * sentence can be answered correctly in other words ("I'm" for "I am"),
 * so a plain text comparison would misjudge it. */
const MAX_CHECKED_WORDS = 3;

/** A turn that PRAISES although the student's words don't contain the short
 * item that was asked for — "Speaking" for LISTENING → "Great job!". */
export function praisesAWrongAnswer(response: TutorResponse, expected: string | undefined, studentSaid: string): boolean {
  if (!expected || response.praise !== true || response.correction) return false;
  const target = normalize(expected);
  if (!target || target.split(" ").length > MAX_CHECKED_WORDS) return false;
  return !` ${normalize(studentSaid)} `.includes(` ${target} `);
}

/**
 * A correction whose "corrected" form is just what the student said (not
 * what was asked for) is repointed to `expected`: correction.corrected and
 * the "The correct way is / Repeat after me / Now you try" items in
 * speech.english. Any other correction (e.g. a fix of the expected item's
 * own pronunciation) is left alone.
 */
export function pointCorrectionAtExpected(
  response: TutorResponse,
  expected: string | undefined
): { response: TutorResponse; fixed: boolean } {
  const correction = response.correction;
  if (!expected || !correction) return { response, fixed: false };
  const corrected = normalize(correction.corrected);
  if (corrected === normalize(expected)) return { response, fixed: false };
  if (corrected !== normalize(correction.studentSaid)) return { response, fixed: false };
  return {
    response: {
      ...response,
      correction: { ...correction, corrected: expected },
      speech: { ...response.speech, english: replaceItem(response.speech.english, correction.corrected, expected) },
    },
    fixed: true,
  };
}
