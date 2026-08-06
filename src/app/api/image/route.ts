import { NextRequest, NextResponse } from "next/server";

/**
 * Resolves a short query (country/continent/city name) to a free,
 * rights-clear thumbnail via Wikipedia's REST summary API — no API key,
 * no cost. Never errors the caller: any failure (404, network issue,
 * missing thumbnail) just returns { imageUrl: null }, and the UI shows
 * nothing rather than breaking the chat over a missing picture.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ erro: "q não informado" }, { status: 400 });
  }

  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TheWayToEnglish-demo/1.0 (educational prototype)" },
    });

    if (!res.ok) {
      return NextResponse.json({ imageUrl: null });
    }

    const data = await res.json();
    const imageUrl: string | null = data?.thumbnail?.source ?? null;
    return NextResponse.json({ imageUrl });
  } catch (err) {
    console.error("[api/image] error", err);
    return NextResponse.json({ imageUrl: null });
  }
}
