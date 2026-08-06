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
 * Parses raw LLM output into a TutorResponse. Never throws, and never
 * surfaces raw JSON to the student: response_format: json_object (see
 * GroqAIProvider/OpenAIProvider) should already guarantee syntactically
 * valid JSON, but a model can still emit JSON that's syntactically fine yet
 * doesn't match TutorResponseSchema's shape (e.g. speech.english as null
 * instead of "", or speech as a bare string) — those get normalized rather
 * than rejected. Only a response that fails ALL of that falls through to
 * the last-resort branch below, which is careful never to hand back
 * something JSON-shaped as if it were spoken text.
 */
export function parseTutorResponse(raw: string): TutorResponse {
  const stripped = stripMarkdownFence(raw);
  const jsonCandidate = extractJsonObject(stripped);
  if (jsonCandidate) {
    try {
      const parsed = TutorResponseSchema.safeParse(normalizeForSchema(JSON.parse(jsonCandidate)));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to the last-resort branch below
    }
  }

  // Nothing above produced a valid TutorResponse. If what's left still
  // looks JSON-shaped, showing it verbatim would just dump braces/quotes
  // into the chat — use a generic apology instead. Genuinely
  // non-JSON prose (the model ignored response_format entirely, which
  // response_format is supposed to prevent but isn't a hard guarantee) is
  // the one case safe to show as-is, and even then it's spoken Portuguese
  // per LANGUAGE STRATEGY's rescue case, never English.
  const trimmed = stripped.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  return {
    speech: {
      english: "",
      portuguese: looksLikeJson
        ? "Desculpe, tive um problema para responder agora. Pode repetir, por favor?"
        : trimmed,
    },
  };
}

/** Strips ``` / ```json code-fence markers a model sometimes wraps JSON in
 * despite response_format: json_object — harmless no-op when there's no
 * fence to begin with. */
function stripMarkdownFence(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").trim();
}

/** Coerces shapes real models occasionally emit that are valid JSON but
 * not quite TutorResponseSchema — null instead of "" for an empty speech
 * field, or `speech` as a bare string instead of {english, portuguese} —
 * into the schema's expected shape, so a shape hiccup normalizes instead
 * of raw JSON leaking into the chat as fallback text. */
function normalizeForSchema(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  let speech: unknown = obj.speech;
  if (typeof speech === "string") {
    speech = { english: speech, portuguese: "" };
  }
  if (typeof speech === "object" && speech !== null) {
    const s = speech as Record<string, unknown>;
    speech = {
      english: typeof s.english === "string" ? s.english : "",
      portuguese: typeof s.portuguese === "string" ? s.portuguese : "",
    };
  }
  return { ...obj, speech };
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
