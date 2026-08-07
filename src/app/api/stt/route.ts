import { NextRequest, NextResponse } from "next/server";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

// Whisper's verbose_json returns the full language name (e.g. "english"),
// not an ISO code — map the common ones down to the short codes the rest
// of the app (AIOptions.detectedLanguage, the sandwich-method hint) uses.
// Unmapped languages pass through as-is rather than being dropped.
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: "en",
  portuguese: "pt",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
};

// Whisper's `prompt` doesn't force a language or bias transcription
// toward one — unlike `language` (deliberately NOT sent here: the
// student can answer in Portuguese or English in the same session, and
// forcing either would mistranscribe the other). It's a style/vocabulary
// hint: naming the exact words this app cares about (continent/country
// names, common PT/EN near-homophones) measurably cuts down on mixups
// like "city" -> "siege" or "Morocco" -> "Marroko" for Brazilian-accented
// English. See WhisperSTTProvider.setLessonVocabulary for the per-lesson
// half of this — appended below when the client sends it.
const BASE_PROMPT =
  "English lesson for Brazilian students. Student speaks Brazilian Portuguese and " +
  "English with Brazilian accent. Common words: continents, countries, Africa, Europe, " +
  "Asia, America, Australia, Morocco, Senegal, France.";

/**
 * Backs WhisperSTTProvider. Proxies a single recorded utterance to
 * OpenAI's Whisper endpoint (migrated off Groq — same OPENAI_API_KEY the
 * TTS and chat routes already use, one fewer key to manage) and returns
 * the transcript — nothing here touches disk or a database. The audio
 * Blob exists only in this request's memory and is discarded the moment
 * this function returns (no filesystem writes, no persistence layer
 * involved at all), which is what keeps this out of LGPD data-retention
 * territory for student voice recordings.
 *
 * No `language` field is sent — the student can speak Portuguese or
 * English in the same conversation, and both need to come back correctly
 * transcribed, so this deliberately leaves Whisper's own auto-detection
 * in charge rather than biasing toward one language.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = "whisper-1";

  if (!apiKey) {
    return NextResponse.json({ erro: "OPENAI_API_KEY não configurada" }, { status: 500 });
  }

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return NextResponse.json({ erro: "corpo multipart inválido" }, { status: 400 });
  }

  const audio = incoming.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ erro: "áudio não enviado" }, { status: 400 });
  }

  // Optional — see WhisperSTTProvider.setLessonVocabulary. Absent for any
  // STT provider/call site that doesn't send it (falls back to just the
  // base prompt), so this never breaks a caller that predates it.
  const lessonVocabularyRaw = incoming.get("lessonVocabulary");
  const lessonVocabulary = typeof lessonVocabularyRaw === "string" ? lessonVocabularyRaw.trim() : "";
  const prompt = lessonVocabulary
    ? `${BASE_PROMPT} Current lesson vocabulary: ${lessonVocabulary}.`
    : BASE_PROMPT;

  const openaiForm = new FormData();
  openaiForm.append("file", audio, "audio.webm");
  openaiForm.append("model", model);
  openaiForm.append("response_format", "verbose_json"); // includes detected `language`
  openaiForm.append("prompt", prompt);

  const started = Date.now();
  let openaiRes: Response;
  try {
    openaiRes = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openaiForm,
    });
  } catch (err) {
    console.error("[api/stt] network error calling OpenAI", err);
    return NextResponse.json({ erro: "Falha de rede ao chamar OpenAI" }, { status: 502 });
  }
  const serverLatencyMs = Date.now() - started;

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => "");
    console.error("[api/stt] OpenAI HTTP error", openaiRes.status, errText.slice(0, 300));
    return NextResponse.json(
      { erro: `Whisper HTTP ${openaiRes.status}: ${errText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  const data = await openaiRes.json();
  const rawLanguage: string | undefined = data.language;
  const detectedLanguage = rawLanguage ? LANGUAGE_NAME_TO_CODE[rawLanguage.toLowerCase()] ?? rawLanguage : undefined;

  console.log("[STT] OpenAI whisper-1, idioma detectado:", detectedLanguage);
  console.log("[STT] latência:", serverLatencyMs, "ms");

  return NextResponse.json({ transcript: data.text ?? "", detectedLanguage, serverLatencyMs, model });
}
