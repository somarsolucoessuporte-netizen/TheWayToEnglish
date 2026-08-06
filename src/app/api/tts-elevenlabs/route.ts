import { NextRequest, NextResponse } from "next/server";

/**
 * Backs ElevenLabsSpeechProvider (not activated by default — see
 * app-config/providers.ts). Keeps ELEVENLABS_API_KEY server-side; the
 * client only ever talks to this route, never to ElevenLabs directly.
 *
 * Lives at /api/tts-elevenlabs (not /api/tts) so it doesn't collide with
 * OpenAITTSProvider's route — the two TTS backends are independent and
 * both stay usable via the one-line swap in app-config/providers.ts.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return NextResponse.json(
      { erro: "ElevenLabs não configurado (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)" },
      { status: 500 }
    );
  }

  const { text } = await req.json();
  if (!text || typeof text !== "string") {
    return NextResponse.json({ erro: "texto não enviado" }, { status: 400 });
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return NextResponse.json(
      { erro: `ElevenLabs HTTP ${response.status}: ${errText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  const audioBuffer = await response.arrayBuffer();
  return new NextResponse(audioBuffer, {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
