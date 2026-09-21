import type { Message } from "../ai/AIProvider";
import type { TutorResponse } from "../ai/TutorResponse";

/** The first exchange of 1A has a known next line in the lesson script. */
export function introductionReply(lessonCode: string, messages: Message[]): TutorResponse | undefined {
  if (lessonCode.toLowerCase() !== "1a") return;
  const latest = messages[messages.length - 1];
  if (latest?.role !== "user") return;
  const previous = messages.slice(0, -1).findLast((message) => message.role === "assistant");
  if (!previous || !/what(?:'|’| i)s your name\s*\?/i.test(previous.content)) return;
  // Only a standalone introduction: questions, additional sentences and
  // uncertain recognitions still go through the normal tutor provider.
  //
  // The greeting separator is `[,.!…]*` (any amount of sentence-ending
  // punctuation, including none), NOT `[,!]?` — Whisper routinely
  // transcribes the spoken pause after "Hello, my name is Francisco" as a
  // full stop ("Hello. My name is Francisco.") rather than a comma, purely
  // from prosody, with no comma anywhere. A `[,!]?` separator doesn't
  // consume that period, and since it isn't whitespace either, the whole
  // optional greeting group fails to match at all — which used to send a
  // perfectly normal self-introduction down the regular AI path, where it
  // got graded as a mispronounced ATTEMPT TO REPEAT "Hello, my name's
  // Debbie" instead of recognized as the student's own name (this is what
  // surfaced as "contraction accepted as an error": the visible diff the
  // model reacted to was really the wrong name, not my name's vs. my name is).
  const match = latest.content.trim().match(
    /^(?:(?:hello|hi)[,.!…]*\s+)?(?:my name is|my name['’]s|i am|i['’]m)\s+([\p{L}][\p{L}'’\-]*(?:\s+[\p{L}][\p{L}'’\-]*){0,3})[.!]?$/iu
  );
  if (!match) return;
  // Defensive: the regex above already restricts this to letters/'/-, but
  // normalize whitespace and cap length before it ever reaches TTS — a
  // transcript artifact (extra spaces, an unreasonably long capture) has
  // no business making it into spoken text unmodified.
  const name = match[1].trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return;
  return {
    speech: {
      english: `Nice to meet you, ${name}! Now reply: Nice to meet you too.`,
      portuguese: "",
    },
    praise: true,
  };
}
