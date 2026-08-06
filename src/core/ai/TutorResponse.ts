import { z } from "zod";

export const TutorResponseSchema = z
  .object({
    /**
     * What the tutor says out loud, split by language so each part can be
     * spoken with the right voice/pronunciation in sequence — English
     * first, then Portuguese (see orchestrator.speakParts). Either half
     * may be "" (never omitted): a normal English-only reply leaves
     * portuguese empty; a fully-Portuguese rescue (student totally lost)
     * leaves english empty; a correction usually fills both.
     */
    speech: z.object({
      english: z.string(),
      portuguese: z.string(),
    }),
    correction: z
      .object({
        studentSaid: z.string(),
        corrected: z.string(),
        explanation: z.string(),
        /** Simplified, non-phonetic pronunciation hint for the on-screen
         * card (e.g. "Éfrica", "iú-rop") — the audible pronunciation model
         * is speech.english itself; this is just a visual reminder the
         * student can also click 🔊 to replay (see CorrectionCard). */
        pronunciation: z.string().optional(),
      })
      .optional(),
    praise: z.boolean().optional(),
    level: z.enum(["A1", "A2", "B1", "B2", "C1"]).optional(),
    /** Short, real-time tip (in Portuguese) that helps the student answer
     * THIS turn's question specifically — not a lesson-wide tip list. Shown
     * on demand behind the 💡 button (see TipsPanel); "" or omitted when
     * this turn doesn't ask anything a hint would help with. */
    hint: z.string().optional(),
    /** At most one per reply — a country/continent/city mentioned for the
     * first time in the conversation gets an illustrative image (see
     * VisualCard + /api/image, which resolves `query` via Wikipedia). */
    visual: z
      .object({
        type: z.literal("image"),
        query: z.string(),
        caption: z.string(),
      })
      .optional(),
  })
  .refine((data) => data.speech.english.trim() || data.speech.portuguese.trim(), {
    message: "speech.english and speech.portuguese can't both be empty",
    path: ["speech"],
  });

export type TutorResponse = z.infer<typeof TutorResponseSchema>;

/**
 * Parses raw LLM output into a TutorResponse. Never throws: a malformed or
 * non-JSON reply is treated as plain English speech so the conversation
 * never breaks over a formatting slip.
 */
export function parseTutorResponse(raw: string): TutorResponse {
  const jsonCandidate = extractJsonObject(raw);
  if (jsonCandidate) {
    try {
      const parsed = TutorResponseSchema.safeParse(JSON.parse(jsonCandidate));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to plain-text fallback
    }
  }
  return { speech: { english: raw.trim(), portuguese: "" } };
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
