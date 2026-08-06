import { z } from "zod";

export const TutorResponseSchema = z.object({
  /** Exactly what the tutor says out loud. Goes to the SpeechProvider. */
  speech: z.string().min(1),
  /**
   * Predominant language of `speech` — drives which TTS voice/locale reads
   * it (see orchestrator). "mixed" is for sandwich-method replies that
   * bridge both languages in one utterance (e.g. a Portuguese explanation
   * that ends in an English example); English wins the pronunciation in
   * that case since the English snippet is usually what matters most.
   */
  language: z.enum(["en", "pt", "mixed"]).optional(),
  correction: z
    .object({
      studentSaid: z.string(),
      corrected: z.string(),
      explanation: z.string(),
    })
    .optional(),
  praise: z.boolean().optional(),
  level: z.enum(["A1", "A2", "B1", "B2", "C1"]).optional(),
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
});

export type TutorResponse = z.infer<typeof TutorResponseSchema>;

/**
 * Parses raw LLM output into a TutorResponse. Never throws: a malformed or
 * non-JSON reply is treated as plain speech so the conversation never breaks
 * over a formatting slip.
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
  return { speech: raw.trim() };
}

/**
 * BCP-47 tag to speak a TutorResponse in. English wins for "mixed" —
 * the pronunciation that matters most in a sandwich-method reply that
 * bridges both languages is usually the English snippet.
 */
export function speechLangFor(language: TutorResponse["language"]): string {
  return language === "pt" ? "pt-BR" : "en-US";
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
