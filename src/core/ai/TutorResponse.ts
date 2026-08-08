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
         * student can also click "Ouvir" to replay (see CorrectionCard). */
        pronunciation: z.string().optional(),
      })
      .optional(),
    praise: z.boolean().optional(),
    /** Which of the current lesson's can-do goals (verbatim strings from
     * CurriculumLesson.canDo — see app-config/curriculum) the student just
     * demonstrated in this exchange, if any — see persona.ts's LESSON
     * COMPLETION section. Accumulated turn over turn by the orchestrator;
     * the lesson is considered complete once every goal has been checked
     * off at least once, independent of the session timer. */
    completedGoals: z.array(z.string()).optional(),
    level: z.enum(["A1", "A2", "B1", "B2", "C1"]).optional(),
    /** What answer(s) would satisfy THIS turn's question, if it asked one —
     * never spoken or shown to the student. Exists purely so the server-
     * side guard (see app/api/chat/route.ts's checkForLeakedAnswer) can
     * mechanically verify `speech` never states one of these outright —
     * defense in depth against the model leaking the answer inside the
     * question itself (see persona.ts's ASKING VS. HELPING section).
     * Omitted for turns that don't ask a checkable question (open-ended
     * prompts, corrections, praise, etc.). */
    expectedAnswer: z
      .object({
        type: z.enum(["enum", "free"]),
        /** Required when type is "enum" — every acceptable surface form of
         * the answer (e.g. ["Africa"], or ["Yes, I am", "Yes I am"] for a
         * short-answer question). Omitted for "free" (open-ended, nothing
         * fixed to check against). */
        values: z.array(z.string()).optional(),
      })
      .optional(),
    /** Up to 3 escalating hints for THIS turn's question — see persona.ts's
     * ASKING VS. HELPING section for what each level should contain
     * (reformulation, partial clue, guided answer, in that order). NEVER
     * spoken by the TTS and NEVER shown automatically — only revealed one
     * level at a time behind the "Dica" button (see TipsPanel), which is the
     * whole point: the student must attempt the question in silence before
     * any help appears. Omitted when this turn doesn't ask anything a hint
     * would help with (pure praise, a correction already carrying its own
     * audio model, etc.). */
    hints: z.array(z.string()).max(3).optional(),
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
  const result: Record<string, unknown> = { ...obj, speech };
  // Coerces the retired single "hint" string (a model still trained on/
  // echoing the old field shape) into the new "hints" array rather than
  // failing schema validation outright — see TutorResponseSchema.hints.
  if (typeof result.hint === "string" && result.hint.trim() && !Array.isArray(result.hints)) {
    result.hints = [result.hint.trim()];
  }
  delete result.hint;
  return result;
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
