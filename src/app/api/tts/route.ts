import { NextRequest, NextResponse } from "next/server";

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

/**
 * Backs OpenAITTSProvider (the default speechProvider — see
 * app-config/providers.ts). Keeps OPENAI_API_KEY server-side; the client
 * only ever talks to this route, never to OpenAI directly.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  const voice = process.env.OPENAI_TTS_VOICE || "nova";

  console.log("[TTS] API key presente:", !!apiKey);

  if (!apiKey) {
    console.error("[TTS] erro OpenAI: OPENAI_API_KEY não configurada neste ambiente");
    return NextResponse.json({ erro: "OPENAI_API_KEY não configurada" }, { status: 500 });
  }

  const { text, speed } = await req.json();
  if (!text || typeof text !== "string") {
    return NextResponse.json({ erro: "texto não enviado" }, { status: 400 });
  }
  // OpenAI's TTS speed range is [0.25, 4.0] — clamp rather than reject so a
  // slightly out-of-range client value (or a future default change) can't
  // 400 the whole request over a cosmetic detail.
  const rawSpeed = typeof speed === "number" && Number.isFinite(speed) ? speed : 1.0;
  const clampedSpeed = Math.min(4.0, Math.max(0.25, rawSpeed));

  let response: Response;
  try {
    response = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        speed: clampedSpeed,
        response_format: "mp3",
      }),
    });
  } catch (error) {
    console.error("[TTS] erro OpenAI:", error);
    return NextResponse.json({ erro: "Falha de rede ao chamar OpenAI" }, { status: 502 });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("[TTS] erro OpenAI:", response.status, errText.slice(0, 300));
    return NextResponse.json(
      { erro: `OpenAI TTS HTTP ${response.status}: ${errText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  const audioBuffer = await response.arrayBuffer();
  return new NextResponse(audioBuffer, {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
