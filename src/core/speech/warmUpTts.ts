/**
 * Pre-warms /api/tts with a short real request ("Hello") before the app is
 * released to the student — used by the boot loading gate (see
 * app/page.tsx's runBoot) so the serverless function and the OpenAI call
 * inside it have already spun up by the time the tutor's first real line
 * needs to play, instead of that first utterance paying for the cold
 * start. The audio itself is discarded, never played. Resolves false (not
 * throws) on any failure — the caller treats this as a health check.
 */
export async function warmUpTts(): Promise<boolean> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", speed: 1.0 }),
    });
    if (!res.ok) return false;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("audio")) return false;
    const buffer = await res.arrayBuffer();
    return buffer.byteLength > 0;
  } catch {
    return false;
  }
}
