import { NextRequest, NextResponse } from "next/server";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

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

/**
 * Backs WhisperSTTProvider. Proxies a single recorded utterance to Groq's
 * Whisper endpoint and returns the transcript — nothing here touches disk
 * or a database. The audio Blob exists only in this request's memory and
 * is discarded the moment this function returns (no filesystem writes, no
 * persistence layer involved at all), which is what keeps this out of
 * LGPD data-retention territory for student voice recordings.
 *
 * No "language" is sent to Groq — Whisper auto-detects, which is the
 * right call for Brazilian-accented English (see WhisperSTTProvider).
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";

  if (!apiKey) {
    return NextResponse.json({ erro: "GROQ_API_KEY não configurada" }, { status: 500 });
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

  const groqForm = new FormData();
  groqForm.append("file", audio, "audio.webm");
  groqForm.append("model", model);
  groqForm.append("response_format", "verbose_json"); // includes detected `language`

  const started = Date.now();
  let groqRes: Response;
  try {
    groqRes = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
    });
  } catch (err) {
    console.error("[api/stt] network error calling Groq", err);
    return NextResponse.json({ erro: "Falha de rede ao chamar Groq" }, { status: 502 });
  }
  const serverLatencyMs = Date.now() - started;

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => "");
    console.error("[api/stt] Groq HTTP error", groqRes.status, errText.slice(0, 300));
    return NextResponse.json(
      { erro: `Whisper HTTP ${groqRes.status}: ${errText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  const data = await groqRes.json();
  const rawLanguage: string | undefined = data.language;
  const detectedLanguage = rawLanguage ? LANGUAGE_NAME_TO_CODE[rawLanguage.toLowerCase()] ?? rawLanguage : undefined;

  return NextResponse.json({ transcript: data.text ?? "", detectedLanguage, serverLatencyMs, model });
}
