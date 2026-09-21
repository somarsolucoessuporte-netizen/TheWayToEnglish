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
  const match = latest.content.trim().match(
    /^(?:(?:hello|hi)[,!]?\s+)?(?:my name is|my name['’]s|i am|i['’]m)\s+([\p{L}][\p{L}'’\-]*(?:\s+[\p{L}][\p{L}'’\-]*){0,3})[.!]?$/iu
  );
  if (!match) return;
  return {
    speech: {
      english: `Nice to meet you, ${match[1]}! Now reply: Nice to meet you too.`,
      portuguese: "",
    },
    praise: true,
  };
}
