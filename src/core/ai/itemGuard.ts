// The model reports which lesson item its message asks (TutorResponse.item)
// — the student's screen shows that item's picture. When it moves on it
// sometimes still reports the previous one ("Perfect! … Joel – hug Mirna."
// with item = the drama-group item), and the screen would show the wrong
// picture. The cue it actually spoke settles it: the item whose prompt
// appears LAST in speech.english wins.

export interface ItemCue {
  id: string;
  prompt: string;
}

/** Cues shorter than this ("Ear", "tie") are too likely to appear by chance. */
const MIN_CUE_LENGTH = 8;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[–—-]/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that carry no content of the answer ("He is hugging Mirna" vs
// "Joel is hugging Mirna" share hugging + mirna).
const FUNCTION_WORDS = new Set(
  ("a an the is are am was were be been i you he she it we they me him her us them my your his its our their " +
    "this that these those there here do does did don't doesn't not no yes s 's to of in on at and or but with " +
    "for what who where when how why which").split(" ")
);

function contentWords(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => w && !FUNCTION_WORDS.has(w));
}

/** Share of the answer's content words a leak must repeat. */
const LEAK_COVERAGE = 0.6;

/**
 * The tutor asked an item and then answered it herself ("What is Joel
 * doing? He is hugging Mirna.") — for a picture item that is describing the
 * picture, and it gives the answer away. Only what comes AFTER the last
 * question is looked at (praise for the previous item comes before it), the
 * item's own cue there is allowed ("What are they doing? Joel – hug
 * Mirna."), and a correction turn is never touched (giving the answer is
 * its job). Returns the speech cut after the question, and what was cut.
 */
export function stripLeakedAnswer(
  speech: string,
  item: { prompt: string; expectedAnswer: string | null },
  isCorrection: boolean
): { speech: string; leaked?: string } {
  if (isCorrection || !item.expectedAnswer) return { speech };
  const answer = contentWords(item.expectedAnswer);
  if (answer.length === 0) return { speech };
  const lastQuestion = speech.lastIndexOf("?");
  if (lastQuestion < 0) return { speech };
  const tail = speech.slice(lastQuestion + 1);
  const cue = normalize(item.prompt);
  const rest = cue.length > 0 ? normalize(tail).replace(cue, " ") : normalize(tail);
  const said = new Set(contentWords(rest));
  const covered = answer.filter((w) => said.has(w)).length / answer.length;
  if (covered < LEAK_COVERAGE) return { speech };
  // Keep the cue when it was spoken after the question.
  const cueText = item.prompt.trim().replace(/([^.?!])$/, "$1.");
  const keepCue = cue.length > 0 && normalize(tail).includes(cue) ? ` ${cueText}` : "";
  return { speech: `${speech.slice(0, lastQuestion + 1)}${keepCue}`.trim(), leaked: tail.trim() };
}

/** The item the message really asks: `reported` unless another item's cue
 * appears later in the speech. Several items with the same cue (9A asks
 * "What's the weather like?" for every picture) keep `reported` when it is
 * one of them. */
export function itemAskedInSpeech(speech: string, reported: string | undefined, cues: ItemCue[]): string | undefined {
  const spoken = normalize(speech);
  let best: { end: number; ids: string[] } | undefined;
  for (const cue of cues) {
    const prompt = normalize(cue.prompt);
    if (prompt.length < MIN_CUE_LENGTH) continue;
    const at = spoken.lastIndexOf(prompt);
    if (at < 0) continue;
    const end = at + prompt.length;
    if (!best || end > best.end) best = { end, ids: [cue.id] };
    else if (end === best.end) best.ids.push(cue.id);
  }
  if (!best) return reported;
  return reported && best.ids.includes(reported) ? reported : best.ids[0];
}
